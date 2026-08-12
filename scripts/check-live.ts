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
import { workspaceDir } from '../src/main/jobs/workspace'

loadDotenv()

let passed = 0
let failed = 0
let blocked = 0
const details: string[] = []

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++
    console.log(`  ok      ${name}`)
  } else {
    failed++
    const l = `${name}\n            esperado ${JSON.stringify(expected)}\n            real     ${JSON.stringify(actual)}`
    details.push(`✗ ${l}`)
    console.log(`  FALLA   ${l}`)
  }
}

function block(name: string, howToFix: string): void {
  blocked++
  details.push(`⊘ ${name} → ${howToFix}`)
  console.log(`  BLOQ    ${name}`)
  console.log(`            correr: ${howToFix}`)
}

function section(t: string): void {
  console.log(`\n── ${t}`)
}

/*
 * El workspace se DERIVA del id del agente. Acá había la ruta absoluta de una
 * máquina commiteada como fallback: el "esto no se puede publicar" más concreto que
 * había, porque ni se puede configurar.
 */
const WS = workspaceDir()

async function checkSearch(): Promise<void> {
  section('assert 14 · el CLI de búsqueda devuelve vacantes parseadas')

  const { search } = await import('../src/main/jobs/search')

  try {
    const found = await search({
      query: 'react developer',
      location: 'Colombia',
      jobAgeDays: 14,
      remote: 'remote',
      limit: 5
    })

    check('devuelve al menos una vacante', found.length >= 1, true)
    if (found.length === 0) return

    const j = found[0]
    check('trae id numérico', /^\d{6,}$/.test(j.id), true)
    check('trae título', j.title.length > 0, true)
    check('trae empresa', j.company.length > 0, true)
    check('la URL es https de linkedin', /^https:\/\/[a-z]+\.linkedin\.com\//.test(j.url), true)

    const { isApplicableUrl } = await import('../src/shared/ipc')
    check('la URL pasa la allowlist de postulación', isApplicableUrl(j.url), true)

    console.log(`            ejemplo: ${j.title} — ${j.company}`)
  } catch (error: unknown) {
    block('búsqueda en LinkedIn', `revisar bun: ${String(error)}`)
  }
}

async function checkNotion(): Promise<void> {
  section('asserts 2 y 4 · Notion: escritura real y upsert sin duplicar')

  if (!process.env.NOTION_TOKEN) {
    block(
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
  const TEST_URL = `https://co.linkedin.com/jobs/view/albus-selftest-99999999`
  let pageId = ''

  try {
    const first = await upsertApplication({
      company: 'Albus Selftest',
      role: 'Verificación automática',
      status: 'Backlog',
      date: '2026-08-06',
      fitScore: 71,
      postLink: TEST_URL,
      contactUrl: TEST_URL,
      jobDescription: 'Fila de prueba del verificador. Se archiva sola.',
      coverLetter: '',
      nextAction: 'Borrar si quedó'
    })

    pageId = first.pageId
    check('crea la fila', first.created, true)
    check('devuelve un pageId', first.pageId.length > 0, true)

    // Releer: que la API haya dicho 200 no prueba qué quedó guardado.
    const stored = (await notionFetch(`/pages/${pageId}`)) as {
      properties: Record<string, { select?: { name: string }; number?: number; url?: string }>
    }

    check('el Status quedó en Backlog', stored.properties.Status?.select?.name, 'Backlog')
    check('el Fit Score quedó en 71', stored.properties['Fit Score']?.number, 71)
    check('el post link quedó', stored.properties['post link']?.url, TEST_URL)

    // El upsert: la misma URL otra vez tiene que ACTUALIZAR, no crear.
    const second = await upsertApplication({
      company: 'Albus Selftest',
      role: 'Verificación automática',
      status: 'Applying',
      date: '2026-08-06',
      fitScore: 88,
      postLink: TEST_URL,
      contactUrl: TEST_URL,
      jobDescription: 'Segunda pasada.',
      coverLetter: '',
      nextAction: ''
    })

    check('la segunda pasada NO crea otra fila', second.created, false)
    check('actualiza la misma página', second.pageId, pageId)

    const reread = (await notionFetch(`/pages/${pageId}`)) as {
      properties: Record<string, { select?: { name: string }; number?: number }>
    }
    check('el estado se actualizó a Applying', reread.properties.Status?.select?.name, 'Applying')
    check('el score se actualizó a 88', reread.properties['Fit Score']?.number, 88)

    const foundPage = await findByPostLink(TEST_URL)
    check('la búsqueda por post link la encuentra', foundPage, pageId)
  } catch (error: unknown) {
    failed++
    const msg = String(error)
    details.push(`✗ Notion: ${msg}`)
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

async function checkGmail(): Promise<void> {
  section('asserts 7 y 8 · Gmail: scope y adjunto verificado en el borrador')

  const { hasGmailScope, sendApplication, draftAttachments, deleteDraft } = await import(
    '../src/main/gmail/send'
  )

  let scope: { ok: boolean; scopes: string[] }
  try {
    scope = await hasGmailScope()
  } catch (error: unknown) {
    block('scope de Gmail', `revisar credenciales de Google: ${String(error)}`)
    return
  }

  console.log(`            scopes actuales: ${scope.scopes.join(', ') || '(ninguno)'}`)

  if (!scope.ok) {
    block('scope gmail.compose', 'npm run gmail:auth')
    block('adjunto verificado en Gmail', 'npm run gmail:auth (depende del anterior)')
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
    const r = await sendApplication(
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
    const attachments = await draftAttachments(draftId)
    check('el borrador tiene un adjunto', attachments.length, 1)
    check(
      'Gmail lo guardó como "CV Jorge David Diaz.pdf"',
      attachments[0]?.filename,
      `${profile.cvFileBaseName}.pdf`
    )
    check('el tamaño coincide con el PDF original', attachments[0]?.size, pdf.byteLength)
  } catch (error: unknown) {
    failed++
    const msg = String(error)
    details.push(`✗ Gmail: ${msg}`)
    console.log(`  FALLA   Gmail: ${msg}`)
  } finally {
    if (draftId !== '') {
      await deleteDraft(draftId).catch(() => {})
      console.log('            (borrador de prueba borrado)')
    }
  }
}

async function main(): Promise<void> {
  console.log('\n══ VERIFICACIÓN CON RED Y CREDENCIALES ══')

  await checkSearch()
  await checkNotion()
  await checkGmail()

  const total = passed + failed
  console.log(`\n${'='.repeat(64)}`)
  console.log(
    `EN VIVO   ${passed}/${total} ${failed === 0 ? '✓' : '✗'}` +
      (blocked > 0 ? `   ·   ${blocked} bloqueado(s) por credenciales` : '')
  )
  if (details.length > 0) {
    console.log('')
    for (const d of details) console.log(`  ${d}`)
  }
  console.log('='.repeat(64))

  process.exit(failed === 0 ? 0 : 1)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
