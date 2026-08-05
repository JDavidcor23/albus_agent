/**
 * Autoriza Albus contra Google Drive una sola vez y guarda el refresh token en .env.
 *
 *   npx tsx scripts/drive-connect.ts
 *
 * Usa el flujo "loopback" de OAuth para apps de escritorio: levantamos un servidor
 * HTTP efimero en localhost, Google redirige ahi con el code, lo canjeamos por tokens.
 * Sin dependencias: fetch y node:http ya vienen en Node.
 *
 * El refresh token no caduca porque la app esta "En produccion" en el proyecto n8ntest.
 * En modo prueba caducaria a los 7 dias.
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { z } from 'zod'
import 'dotenv/config'

const SCOPE = 'https://www.googleapis.com/auth/drive'
const ENV_PATH = resolve(process.cwd(), '.env')

/**
 * Puerto fijo opcional: `--port 53793`.
 * Sirve para retomar una pestania de consentimiento que ya quedo abierta con
 * ese redirect_uri. Por defecto usa 0 (puerto efimero que asigna el SO).
 */
const portArg = process.argv.indexOf('--port')
const FIXED_PORT = portArg !== -1 ? Number(process.argv[portArg + 1]) : 0
const NO_OPEN = process.argv.includes('--no-open')

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number(),
  scope: z.string()
})

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`Falta ${name} en .env. Corre primero la configuracion de Google Cloud.`)
    process.exit(1)
  }
  return v
}

/** Escribe o reemplaza una clave en .env sin tocar el resto del archivo. */
function upsertEnv(key: string, value: string): void {
  const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
  const line = `${key}=${value}`
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm')
  const next = re.test(current)
    ? current.replace(re, line)
    : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`
  writeFileSync(ENV_PATH, next, 'utf8')
}

function openBrowser(url: string): void {
  // En Windows `start` es un builtin de cmd, no un ejecutable.
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
}

async function main(): Promise<void> {
  const clientId = requireEnv('GOOGLE_CLIENT_ID')
  const clientSecret = requireEnv('GOOGLE_CLIENT_SECRET')

  if (process.env.GOOGLE_REFRESH_TOKEN && !process.argv.includes('--force')) {
    console.log('Ya hay un GOOGLE_REFRESH_TOKEN en .env. Usa --force para reautorizar.')
    return
  }

  // Rescate: si ya autorizaste y el listener estaba caido, el code quedo en la URL
  // de redireccion. `--code <code> --port <puerto>` lo canjea sin levantar servidor.
  const codeArg = process.argv.indexOf('--code')
  const MANUAL_CODE = codeArg !== -1 ? process.argv[codeArg + 1] : null

  if (MANUAL_CODE && !FIXED_PORT) {
    console.error('--code necesita tambien --port, con el mismo puerto del redirect_uri original.')
    process.exit(1)
  }

  // Google exige que el redirect_uri del canje sea IDENTICO al de la autorizacion,
  // asi que el puerto efimero viaja junto con el code.
  const { code, redirectUri } = MANUAL_CODE
    ? { code: MANUAL_CODE, redirectUri: `http://127.0.0.1:${FIXED_PORT}` }
    : await new Promise<{ code: string; redirectUri: string }>(
    (res, rej) => {
      let uri = ''

      const server = createServer((req, response) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const received = url.searchParams.get('code')
        const error = url.searchParams.get('error')

        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(
          received
            ? '<h2>Listo. Ya podes cerrar esta pestania y volver a la terminal.</h2>'
            : `<h2>Fallo la autorizacion: ${error ?? 'sin code'}</h2>`
        )

        server.close()
        if (received) res({ code: received, redirectUri: uri })
        else rej(new Error(error ?? 'Google no devolvio un code'))
      })

      server.listen(FIXED_PORT, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        uri = `http://127.0.0.1:${port}`

        const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
        auth.searchParams.set('client_id', clientId)
        auth.searchParams.set('redirect_uri', uri)
        auth.searchParams.set('response_type', 'code')
        auth.searchParams.set('scope', SCOPE)
        auth.searchParams.set('access_type', 'offline')
        // Sin prompt=consent Google no reemite refresh_token si ya autorizaste antes.
        auth.searchParams.set('prompt', 'consent')

        if (NO_OPEN) {
          console.log(`\nEscuchando en ${uri} — esperando que autorices en la pestania ya abierta.`)
          console.log('Si la cerraste, entra a:\n')
          console.log(auth.toString(), '\n')
        } else {
          console.log('\nAbriendo el navegador para autorizar...')
          console.log('Si no se abre solo, entra a:\n')
          console.log(auth.toString(), '\n')
          openBrowser(auth.toString())
        }

        console.log('Google te va a decir "Google no ha verificado esta aplicacion".')
        console.log('Es esperado: la app es tuya y no esta verificada.')
        console.log('Entra en "Configuracion avanzada" > "Ir a Albus Agent (no seguro)".\n')
      })

      server.on('error', rej)
    }
  )

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  })

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })

  const json: unknown = await res.json()
  if (!res.ok) {
    console.error('Google rechazo el canje del code:', JSON.stringify(json))
    process.exit(1)
  }

  const parsed = TokenResponse.safeParse(json)
  if (!parsed.success) {
    console.error('Respuesta de token con forma inesperada:', parsed.error.message)
    process.exit(1)
  }

  if (!parsed.data.refresh_token) {
    console.error('Google no devolvio refresh_token. Revoca el acceso y reintenta con --force.')
    process.exit(1)
  }

  upsertEnv('GOOGLE_REFRESH_TOKEN', parsed.data.refresh_token)
  console.log('OK — GOOGLE_REFRESH_TOKEN guardado en .env')
  console.log(`   scope concedido: ${parsed.data.scope}`)
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
