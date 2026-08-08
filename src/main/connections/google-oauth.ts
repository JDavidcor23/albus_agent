import { BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { z } from 'zod'
import { KEYS, saveSecret } from './store'

/**
 * Conectar Google con un botón, sin terminal.
 *
 * El consentimiento se abre en una ventana de Electron y no en el navegador
 * del sistema: así la podemos cerrar solos cuando termina, en vez de dejarle
 * una pestaña colgada que dice "volvé a la terminal" — que era literalmente la
 * fricción que el usuario dijo que no quiere.
 *
 * El redirect va a un servidor loopback efímero. El cliente de OAuth es de
 * tipo "aplicación de escritorio", así que Google acepta cualquier puerto de
 * 127.0.0.1 sin registrar nada en la consola.
 */

export const SCOPE_DRIVE = 'https://www.googleapis.com/auth/drive'
export const SCOPE_GMAIL = 'https://www.googleapis.com/auth/gmail.compose'

/**
 * Los dos juntos, SIEMPRE. Un consentimiento nuevo reemplaza al anterior: si
 * pidiéramos solo Gmail, el archivado en Drive dejaría de funcionar en silencio.
 */
export const SCOPES = [SCOPE_DRIVE, SCOPE_GMAIL]

const TokenSchema = z.object({
  refresh_token: z.string().optional(),
  scope: z.string().default('')
})

export interface OauthResult {
  ok: boolean
  scopes: string[]
  message: string
}

function credentials(): { id: string; secret: string } {
  const id = process.env.GOOGLE_CLIENT_ID
  const secret = process.env.GOOGLE_CLIENT_SECRET
  if (!id || !secret) {
    throw new Error('Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el .env')
  }
  return { id, secret }
}

const HTML_OK = `<!doctype html><meta charset="utf-8">
<body style="background:#0F0E13;color:#E8E2D4;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:2rem;color:#C9973F">listo</div>
<p style="color:#8A8478">Ya podés cerrar esto. Albus lo guardó solo.</p></div>`

export function connectGoogle(timeoutMs = 3 * 60_000): Promise<OauthResult> {
  const { id, secret } = credentials()

  return new Promise<OauthResult>((resolve) => {
    let finished = false
    let authWindow: BrowserWindow | null = null

    const close = (r: OauthResult): void => {
      if (finished) return
      finished = true
      clearTimeout(limit)
      try {
        server.close()
      } catch {
        // Ya estaba cerrado.
      }
      if (authWindow !== null && !authWindow.isDestroyed()) authWindow.destroy()
      resolve(r)
    }

    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      const code = u.searchParams.get('code')
      const error = u.searchParams.get('error')

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(code !== null ? HTML_OK : `<h2>No se pudo: ${error ?? 'sin código'}</h2>`)

      if (code === null) {
        close({ ok: false, scopes: [], message: error ?? 'Google no devolvió código' })
        return
      }

      void exchange(code, redirect, id, secret).then(close)
    })

    let redirect = ''

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        close({ ok: false, scopes: [], message: 'no pude abrir un puerto local' })
        return
      }

      redirect = `http://127.0.0.1:${addr.port}`

      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.searchParams.set('client_id', id)
      auth.searchParams.set('redirect_uri', redirect)
      auth.searchParams.set('response_type', 'code')
      auth.searchParams.set('scope', SCOPES.join(' '))
      // Sin `prompt=consent` la segunda autorización devuelve solo el access
      // token: el script parece andar y no sirve para nada.
      auth.searchParams.set('prompt', 'consent')
      auth.searchParams.set('access_type', 'offline')

      authWindow = new BrowserWindow({
        width: 520,
        height: 680,
        autoHideMenuBar: true,
        title: 'Conectar Google',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      })

      authWindow.on('closed', () =>
        close({ ok: false, scopes: [], message: 'cerraste la ventana antes de terminar' })
      )

      void authWindow.loadURL(auth.toString())
    })

    const limit = setTimeout(
      () => close({ ok: false, scopes: [], message: 'se acabó el tiempo' }),
      timeoutMs
    )
  })
}

async function exchange(
  code: string,
  redirect: string,
  id: string,
  secret: string
): Promise<OauthResult> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: id,
        client_secret: secret,
        redirect_uri: redirect,
        grant_type: 'authorization_code'
      })
    })

    const json: unknown = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, scopes: [], message: `Google rechazó el código` }

    const t = TokenSchema.parse(json)
    const scopes = t.scope.split(/\s+/).filter(Boolean)

    if (t.refresh_token === undefined) {
      return {
        ok: false,
        scopes,
        message:
          'Google no devolvió refresh token. Revocá el acceso en myaccount.google.com/permissions y probá de nuevo.'
      }
    }

    saveSecret(KEYS.googleRefreshToken, t.refresh_token)
    return { ok: true, scopes, message: 'Google conectado' }
  } catch (error: unknown) {
    return {
      ok: false,
      scopes: [],
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
