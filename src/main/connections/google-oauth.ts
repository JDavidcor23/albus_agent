import { BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { z } from 'zod'
import { CLAVES, guardarSecreto } from './store'

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

export interface ResultadoOauth {
  ok: boolean
  scopes: string[]
  mensaje: string
}

function credenciales(): { id: string; secret: string } {
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

export function conectarGoogle(timeoutMs = 3 * 60_000): Promise<ResultadoOauth> {
  const { id, secret } = credenciales()

  return new Promise<ResultadoOauth>((resolve) => {
    let terminado = false
    let ventana: BrowserWindow | null = null

    const cerrar = (r: ResultadoOauth): void => {
      if (terminado) return
      terminado = true
      clearTimeout(limite)
      try {
        servidor.close()
      } catch {
        // Ya estaba cerrado.
      }
      if (ventana !== null && !ventana.isDestroyed()) ventana.destroy()
      resolve(r)
    }

    const servidor = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      const code = u.searchParams.get('code')
      const error = u.searchParams.get('error')

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(code !== null ? HTML_OK : `<h2>No se pudo: ${error ?? 'sin código'}</h2>`)

      if (code === null) {
        cerrar({ ok: false, scopes: [], mensaje: error ?? 'Google no devolvió código' })
        return
      }

      void canjear(code, redirect, id, secret).then(cerrar)
    })

    let redirect = ''

    servidor.listen(0, '127.0.0.1', () => {
      const dir = servidor.address()
      if (dir === null || typeof dir === 'string') {
        cerrar({ ok: false, scopes: [], mensaje: 'no pude abrir un puerto local' })
        return
      }

      redirect = `http://127.0.0.1:${dir.port}`

      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.searchParams.set('client_id', id)
      auth.searchParams.set('redirect_uri', redirect)
      auth.searchParams.set('response_type', 'code')
      auth.searchParams.set('scope', SCOPES.join(' '))
      // Sin `prompt=consent` la segunda autorización devuelve solo el access
      // token: el script parece andar y no sirve para nada.
      auth.searchParams.set('prompt', 'consent')
      auth.searchParams.set('access_type', 'offline')

      ventana = new BrowserWindow({
        width: 520,
        height: 680,
        autoHideMenuBar: true,
        title: 'Conectar Google',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      })

      ventana.on('closed', () =>
        cerrar({ ok: false, scopes: [], mensaje: 'cerraste la ventana antes de terminar' })
      )

      void ventana.loadURL(auth.toString())
    })

    const limite = setTimeout(
      () => cerrar({ ok: false, scopes: [], mensaje: 'se acabó el tiempo' }),
      timeoutMs
    )
  })
}

async function canjear(
  code: string,
  redirect: string,
  id: string,
  secret: string
): Promise<ResultadoOauth> {
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
    if (!res.ok) return { ok: false, scopes: [], mensaje: `Google rechazó el código` }

    const t = TokenSchema.parse(json)
    const scopes = t.scope.split(/\s+/).filter(Boolean)

    if (t.refresh_token === undefined) {
      return {
        ok: false,
        scopes,
        mensaje:
          'Google no devolvió refresh token. Revocá el acceso en myaccount.google.com/permissions y probá de nuevo.'
      }
    }

    guardarSecreto(CLAVES.googleRefreshToken, t.refresh_token)
    return { ok: true, scopes, mensaje: 'Google conectado' }
  } catch (error: unknown) {
    return {
      ok: false,
      scopes: [],
      mensaje: error instanceof Error ? error.message : String(error)
    }
  }
}
