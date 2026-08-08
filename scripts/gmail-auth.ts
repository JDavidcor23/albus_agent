/**
 * Vuelve a pedir el consentimiento de Google agregando el scope de Gmail.
 *
 *   npx tsx scripts/gmail-auth.ts --check   ¿qué scopes tiene el token de hoy?
 *   npx tsx scripts/gmail-auth.ts           pide uno nuevo y lo imprime
 *
 * Por qué hace falta: el refresh token guardado se emitió para Drive. Un scope
 * nuevo NO se puede agregar a un token existente — hay que pasar otra vez por
 * la pantalla de consentimiento. El script incluye los scopes actuales en el
 * pedido para que Drive no deje de andar.
 *
 * El cliente de OAuth es de tipo "aplicación de escritorio", así que Google
 * acepta un redirect a loopback en cualquier puerto. No hace falta registrar
 * nada nuevo en la consola.
 */
import { config as loadDotenv } from 'dotenv'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { z } from 'zod'

loadDotenv()

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.compose'

function requireEnv(nombre: string): string {
  const v = process.env[nombre]
  if (!v) throw new Error(`Falta ${nombre} en .env`)
  return v
}

async function scopesActuales(): Promise<string[]> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requireEnv('GOOGLE_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
      refresh_token: requireEnv('GOOGLE_REFRESH_TOKEN'),
      grant_type: 'refresh_token'
    })
  })

  const json: unknown = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Google rechazó el refresh token: ${JSON.stringify(json)}`)

  const parsed = z.object({ access_token: z.string(), scope: z.string().optional() }).parse(json)

  // La respuesta del refresh a veces no trae `scope`; tokeninfo siempre sí.
  if (parsed.scope !== undefined) return parsed.scope.split(/\s+/).filter(Boolean)

  const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${parsed.access_token}`)
  const infoJson: unknown = await info.json().catch(() => ({}))
  const s = z.object({ scope: z.string() }).safeParse(infoJson)
  return s.success ? s.data.scope.split(/\s+/).filter(Boolean) : []
}

function abrirNavegador(url: string): void {
  // `start` en Windows necesita un título vacío antes de la URL, si no toma la
  // URL como título y no abre nada.
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true })
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true })
  else spawn('xdg-open', [url], { detached: true })
}

async function pedirConsentimiento(scopes: string[]): Promise<void> {
  const clientId = requireEnv('GOOGLE_CLIENT_ID')
  const clientSecret = requireEnv('GOOGLE_CLIENT_SECRET')

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const codigo = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        codigo !== null
          ? '<h2>Listo. Volvé a la terminal.</h2>'
          : `<h2>No se pudo: ${error ?? 'sin código'}</h2>`
      )

      server.close()
      if (codigo !== null) resolve(codigo)
      else reject(new Error(error ?? 'Google no devolvió código'))
    })

    server.listen(0, '127.0.0.1', () => {
      const dir = server.address()
      if (dir === null || typeof dir === 'string') {
        reject(new Error('no pude abrir el puerto local'))
        return
      }

      const redirect = `http://127.0.0.1:${dir.port}`
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.searchParams.set('client_id', clientId)
      auth.searchParams.set('redirect_uri', redirect)
      auth.searchParams.set('response_type', 'code')
      auth.searchParams.set('scope', scopes.join(' '))
      // `consent` obliga a Google a devolver un refresh_token nuevo. Sin esto,
      // en la segunda autorización devuelve solo el access token y el script
      // parece funcionar pero no sirve para nada.
      auth.searchParams.set('prompt', 'consent')
      auth.searchParams.set('access_type', 'offline')

      console.log(`\nEsperando en ${redirect}`)
      console.log('Se abre el navegador. Si no, entrá acá a mano:\n')
      console.log(auth.toString())
      abrirNavegador(auth.toString())
      ;(globalThis as { __redirect?: string }).__redirect = redirect
    })
  })

  const redirect = (globalThis as { __redirect?: string }).__redirect ?? ''

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirect,
      grant_type: 'authorization_code'
    })
  })

  const json: unknown = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Google rechazó el código: ${JSON.stringify(json)}`)

  const parsed = z
    .object({ refresh_token: z.string().optional(), scope: z.string() })
    .parse(json)

  if (parsed.refresh_token === undefined) {
    console.error(
      '\nGoogle no devolvió refresh_token. Revocá el acceso de la app en ' +
        'myaccount.google.com/permissions y volvé a correr esto.'
    )
    process.exit(1)
  }

  console.log(`\n${'='.repeat(64)}`)
  console.log('Pegá esto en el .env, reemplazando el valor que está:\n')
  console.log(`GOOGLE_REFRESH_TOKEN=${parsed.refresh_token}`)
  console.log(`\nScopes concedidos:`)
  for (const s of parsed.scope.split(/\s+/)) console.log(`  · ${s}`)
  console.log('='.repeat(64))
}

async function main(): Promise<void> {
  const actuales = await scopesActuales()

  console.log('\nScopes del token guardado:')
  for (const s of actuales) console.log(`  · ${s}`)

  const yaTiene = actuales.includes(GMAIL_SCOPE) || actuales.includes('https://mail.google.com/')
  console.log(`\ngmail.compose: ${yaTiene ? 'SÍ — no hace falta hacer nada' : 'NO'}`)

  if (process.argv.includes('--check')) {
    process.exit(yaTiene ? 0 : 1)
  }

  if (yaTiene) {
    console.log('El token ya sirve para mandar correos. Nada que hacer.')
    process.exit(0)
  }

  // Los actuales van SIEMPRE en el pedido: un consentimiento nuevo reemplaza
  // al viejo, y si dejáramos Drive afuera el archivado dejaría de funcionar.
  await pedirConsentimiento([...new Set([...actuales, GMAIL_SCOPE])])
}

void main().catch((error: unknown) => {
  console.error(`\n${String(error)}`)
  process.exit(1)
})
