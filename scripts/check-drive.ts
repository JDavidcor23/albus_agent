/**
 * ¿Drive está conectado, y la carpeta de tus reglas existe?
 *
 *   npx tsx scripts/check-drive.ts
 *
 * Existe por un 404 que costó una corrida entera: subir el CV fallaba con
 * *"la carpeta no existe o no tengo acceso"* y no había forma de saber cuál de
 * las tres cosas era. **La API de Drive devuelve 404 —no 403— cuando el token
 * no tiene permiso**, justamente para no revelar si el recurso existe. Así que
 * "carpeta borrada", "link con typo" y "token sin el scope de Drive" se ven
 * exactamente iguales desde afuera, y se arreglan distinto.
 *
 * Acá se separan las tres. No sube nada, no escribe nada.
 */

import { readFileSync, existsSync } from 'node:fs'
import { parseYml, albusYmlPath } from '../src/main/connections/albus-yml'
import { setGoogleRefreshTokenResolver, getAccessToken, driveFetch } from '../src/main/drive/client'
import { readRules } from '../src/main/agents/rules'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'

function line(label: string, value: string): void {
  console.log(`${label.padEnd(12)}${value}`)
}

async function main(): Promise<void> {
  console.log('\n══ ¿DRIVE ESTÁ CONECTADO? ══\n')

  const ymlPath = albusYmlPath()
  line('albus.yml:', ymlPath)

  const secrets = existsSync(ymlPath) ? parseYml(readFileSync(ymlPath, 'utf8')) : {}
  const token = secrets['google.refreshToken'] ?? process.env.GOOGLE_REFRESH_TOKEN ?? ''

  if (token === '') {
    console.log('\n✗ NO HAY TOKEN de Google. Corré: npm run gmail:auth')
    process.exit(1)
  }
  line('token:', `${token.slice(0, 12)}… (${token.length} caracteres)`)

  setGoogleRefreshTokenResolver(() => token)

  // ── 1. ¿el token sirve, y para qué? ──────────────────────────────────────
  let access: string
  try {
    access = await getAccessToken()
  } catch (error: unknown) {
    console.log(`\n✗ el refresh token no sirve: ${String(error)}`)
    console.log('  Corré: npm run gmail:auth')
    process.exit(1)
  }

  const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${access}`)
  const json = (await info.json().catch(() => ({}))) as { scope?: string }
  const scopes = (json.scope ?? '').split(/\s+/).filter(Boolean)

  console.log('\nscopes que tiene ESTE token:')
  for (const s of scopes) console.log(`  · ${s}`)

  const hasDrive = scopes.includes(DRIVE_SCOPE)
  if (!hasDrive) {
    console.log('\n✗ FALTA EL SCOPE DE DRIVE.')
    console.log('  El token se autorizó cuando Albus solo pedía Gmail. Drive va a')
    console.log('  devolver 404 en TODO, aunque la carpeta exista y sea tuya.')
    console.log('\n  Arreglo: npm run gmail:auth  (volvé a autorizar, ahora pide Drive)')
    process.exit(1)
  }
  console.log('\n✓ el token tiene permiso de Drive')

  // ── 2. ¿la carpeta de las reglas existe y es accesible? ──────────────────
  const rules = readRules('job-search', '')
  if (rules.drive.length === 0) {
    console.log('\n⚠ no hay ninguna carpeta de Drive en tus reglas.')
    console.log(`  Pegá el link de la carpeta en: ${rules.path}`)
    return
  }

  for (const ref of rules.drive) {
    console.log(`\ncarpeta: ${ref.label !== '' ? ref.label : '(sin etiqueta)'}`)
    line('  id:', ref.id)
    line('  url:', ref.url)

    try {
      const folder = (await driveFetch(
        `/files/${ref.id}?fields=id,name,mimeType,trashed&supportsAllDrives=true`
      )) as { name?: string; mimeType?: string; trashed?: boolean }

      if (folder.mimeType !== 'application/vnd.google-apps.folder') {
        console.log(`  ⚠ existe pero NO es una carpeta (${folder.mimeType})`)
        continue
      }
      if (folder.trashed === true) {
        console.log('  ✗ está en la PAPELERA. Restaurala o pegá otra.')
        continue
      }
      console.log(`  ✓ existe y es tuya: "${folder.name}"`)
    } catch (error: unknown) {
      const message = String(error)
      console.log(`  ✗ ${message}`)
      if (message.includes('404')) {
        console.log('    404 con el scope puesto = el id no existe, o la carpeta')
        console.log('    es de OTRA cuenta de Google (no la que autorizaste).')
        console.log('    Abrí la carpeta en el navegador y copiá el link de la barra.')
      }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(`\n✗ ${String(error)}`)
  process.exit(1)
})
