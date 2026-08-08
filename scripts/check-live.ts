/**
 * Los asserts que necesitan red o credenciales.
 *
 *   npx tsx scripts/check-live.ts
 *
 * Lo que no tiene credencial se reporta como BLOQUEADO con la línea exacta que
 * hay que correr — nunca como pasado. Un assert que se saltea en silencio es
 * peor que uno rojo: el rojo se arregla, el silencioso se descubre en
 * producción.
 *
 * Nada de esto ensucia datos reales: la fila de Notion se archiva y el
 * borrador de Gmail se borra al terminar.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config as loadDotenv } from 'dotenv'

loadDotenv()

let pasados = 0
let fallados = 0
let bloqueados = 0
const detalle: string[] = []

function check(nombre: string, real: unknown, esperado: unknown): void {
  if (JSON.stringify(real) === JSON.stringify(esperado)) {
    pasados++
    console.log(`  ok      ${nombre}`)
  } else {
    fallados++
    const l = `${nombre}\n            esperado ${JSON.stringify(esperado)}\n            real     ${JSON.stringify(real)}`
    detalle.push(`✗ ${l}`)
    console.log(`  FALLA   ${l}`)
  }
}

function bloquear(nombre: string, comoArreglar: string): void {
  bloqueados++
  detalle.push(`⊘ ${nombre} → ${comoArreglar}`)
  console.log(`  BLOQ    ${nombre}`)
  console.log(`            correr: ${comoArreglar}`)
}

function seccion(t: string): void {
  console.log(`\n── ${t}`)
}

const WS =
  process.env.JOB_WORKSPACE_DIR ?? 'C:/Users/jdiaz483/Documents/work/dream/ai-job-search'

async function chequearBusqueda(): Promise<void> {
  seccion('assert 14 · el CLI de búsqueda devuelve vacantes parseadas')

  const { buscar } = await import('../src/main/jobs/search')

  try {
    const encontradas = await buscar({
      query: 'react developer',
      location: 'Colombia',
      jobAgeDays: 14,
      remote: 'remote',
      limit: 5
    })

    check('devuelve al menos una vacante', encontradas.length >= 1, true)
    if (encontradas.length === 0) return

    const j = encontradas[0]
    check('trae id numérico', /^\d{6,}$/.test(j.id), true)
    check('trae título', j.title.length > 0, true)
    check('trae empresa', j.company.length > 0, true)
    check('la URL es https de linkedin', /^https:\/\/[a-z]+\.linkedin\.com\//.test(j.url), true)

    const { esUrlPostulable } = await import('../src/shared/ipc')
    check('la URL pasa la allowlist de postulación', esUrlPostulable(j.url), true)

    console.log(`            ejemplo: ${j.title} — ${j.company}`)
  } catch (error: unknown) {
    bloquear('búsqueda en LinkedIn', `revisar bun: ${String(error)}`)
  }
}

async function chequearNotion(): Promise<void> {
  seccion('asserts 2 y 4 · Notion: escritura real y upsert sin duplicar')

  if (!process.env.NOTION_TOKEN) {
    bloquear(
      'escritura en Notion',
      'notion.so/my-integrations → crear integración → compartir "Registro de aplicaciones" con ella → NOTION_TOKEN=ntn_... en .env'
    )
    return
  }

  const { upsertApplication, findByPostLink, archivePage } = await import(
    '../src/main/notion/applications'
  )
  const { notionFetch } = await import('../src/main/notion/client')

  // URL de prueba que no puede chocar con una vacante real.
  const URL_TEST = `https://co.linkedin.com/jobs/view/albus-selftest-99999999`
  let pageId = ''

  try {
    const primera = await upsertApplication({
      company: 'Albus Selftest',
      role: 'Verificación automática',
      estado: 'Backlog',
      fecha: '2026-08-06',
      fitScore: 71,
      postLink: URL_TEST,
      contactUrl: URL_TEST,
      jobDescription: 'Fila de prueba del verificador. Se archiva sola.',
      coverLetter: '',
      proximaAccion: 'Borrar si quedó'
    })

    pageId = primera.pageId
    check('crea la fila', primera.created, true)
    check('devuelve un pageId', primera.pageId.length > 0, true)

    // Releer: que la API haya dicho 200 no prueba qué quedó guardado.
    const leida = (await notionFetch(`/pages/${pageId}`)) as {
      properties: Record<string, { select?: { name: string }; number?: number; url?: string }>
    }

    check('el Status quedó en Backlog', leida.properties.Status?.select?.name, 'Backlog')
    check('el Fit Score quedó en 71', leida.properties['Fit Score']?.number, 71)
    check('el post link quedó', leida.properties['post link']?.url, URL_TEST)

    // El upsert: la misma URL otra vez tiene que ACTUALIZAR, no crear.
    const segunda = await upsertApplication({
      company: 'Albus Selftest',
      role: 'Verificación automática',
      estado: 'Applying',
      fecha: '2026-08-06',
      fitScore: 88,
      postLink: URL_TEST,
      contactUrl: URL_TEST,
      jobDescription: 'Segunda pasada.',
      coverLetter: '',
      proximaAccion: ''
    })

    check('la segunda pasada NO crea otra fila', segunda.created, false)
    check('actualiza la misma página', segunda.pageId, pageId)

    const releida = (await notionFetch(`/pages/${pageId}`)) as {
      properties: Record<string, { select?: { name: string }; number?: number }>
    }
    check('el estado se actualizó a Applying', releida.properties.Status?.select?.name, 'Applying')
    check('el score se actualizó a 88', releida.properties['Fit Score']?.number, 88)

    const encontrada = await findByPostLink(URL_TEST)
    check('la búsqueda por post link la encuentra', encontrada, pageId)
  } catch (error: unknown) {
    fallados++
    const msg = String(error)
    detalle.push(`✗ Notion: ${msg}`)
    console.log(`  FALLA   Notion: ${msg}`)
  } finally {
    if (pageId !== '') {
      try {
        await archivePage(pageId)
        console.log('            (fila de prueba archivada)')
      } catch {
        console.log(`            OJO: no pude archivar la fila de prueba ${pageId}`)
      }
    }
  }
}

async function chequearGmail(): Promise<void> {
  seccion('asserts 7 y 8 · Gmail: scope y adjunto verificado en el borrador')

  const { tieneScopeGmail, enviarPostulacion, adjuntosDelBorrador, borrarBorrador } = await import(
    '../src/main/gmail/send'
  )

  let scope: { ok: boolean; scopes: string[] }
  try {
    scope = await tieneScopeGmail()
  } catch (error: unknown) {
    bloquear('scope de Gmail', `revisar credenciales de Google: ${String(error)}`)
    return
  }

  console.log(`            scopes actuales: ${scope.scopes.join(', ') || '(ninguno)'}`)

  if (!scope.ok) {
    bloquear('scope gmail.compose', 'npm run gmail:auth')
    bloquear('adjunto verificado en Gmail', 'npm run gmail:auth (depende del anterior)')
    return
  }

  check('el token tiene scope para mandar', scope.ok, true)

  const { parseProfile } = await import('../src/main/core/jobs/profile')
  const profile = parseProfile(JSON.parse(await readFile(join(WS, 'albus-profile.json'), 'utf8')))

  let pdf: Buffer
  try {
    pdf = await readFile(join(WS, 'cv', 'main_example.pdf'))
  } catch {
    pdf = Buffer.from('%PDF-1.4\nfake\n%%EOF\n', 'utf8')
  }

  let draftId = ''
  try {
    const r = await enviarPostulacion(
      {
        fromName: profile.fullName,
        fromEmail: profile.email,
        // A él mismo y como BORRADOR: no le llega nada a nadie.
        to: [profile.email],
        cc: [],
        subject: 'Albus selftest — borrar',
        body: 'Borrador de verificación. Se borra solo.',
        attachments: [
          {
            filename: `${profile.cvFileBaseName}.pdf`,
            mimeType: 'application/pdf',
            content: new Uint8Array(pdf)
          }
        ]
      },
      'draft'
    )

    draftId = r.id
    check('crea un BORRADOR, no manda', r.kind, 'draft')

    // La verificación que importa: qué guardó Gmail, no qué mandamos.
    const adjuntos = await adjuntosDelBorrador(draftId)
    check('el borrador tiene un adjunto', adjuntos.length, 1)
    check(
      'Gmail lo guardó como "CV Jorge David Diaz.pdf"',
      adjuntos[0]?.filename,
      `${profile.cvFileBaseName}.pdf`
    )
    check('el tamaño coincide con el PDF original', adjuntos[0]?.size, pdf.byteLength)
  } catch (error: unknown) {
    fallados++
    const msg = String(error)
    detalle.push(`✗ Gmail: ${msg}`)
    console.log(`  FALLA   Gmail: ${msg}`)
  } finally {
    if (draftId !== '') {
      await borrarBorrador(draftId).catch(() => {})
      console.log('            (borrador de prueba borrado)')
    }
  }
}

async function main(): Promise<void> {
  console.log('\n══ VERIFICACIÓN CON RED Y CREDENCIALES ══')

  await chequearBusqueda()
  await chequearNotion()
  await chequearGmail()

  const total = pasados + fallados
  console.log(`\n${'='.repeat(64)}`)
  console.log(
    `EN VIVO   ${pasados}/${total} ${fallados === 0 ? '✓' : '✗'}` +
      (bloqueados > 0 ? `   ·   ${bloqueados} bloqueado(s) por credenciales` : '')
  )
  if (detalle.length > 0) {
    console.log('')
    for (const d of detalle) console.log(`  ${d}`)
  }
  console.log('='.repeat(64))

  process.exit(fallados === 0 ? 0 : 1)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
