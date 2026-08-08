import { app } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runApply } from '../core/jobs/apply'
import { parseProfile } from '../core/jobs/profile'
import { cvUploadName } from '../core/jobs/cv-name'
import { createBrowserPage } from '../browser/page'
import { jobsSession } from '../browser/session'
import { createWorkspaceKitSource, workspaceDir } from '../jobs/workspace'

/**
 * Los asserts que necesitan un Chromium vivo. `npx tsx` no puede levantar un
 * BrowserWindow, así que esto corre adentro de la app:
 *
 *   ALBUS_JOBS_SELFTEST=1 npm run dev
 *
 * Trabaja contra `resources/job-form-fixture.html`, un formulario sintético
 * que imita LinkedIn + Greenhouse. Nada toca la red, nada toca una vacante
 * real y nada escribe en el tracker del usuario.
 */

let passed = 0
let failed = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    console.log(`  FALLA ${name}`)
    console.log(`          esperado ${JSON.stringify(expected)}`)
    console.log(`          real     ${JSON.stringify(actual)}`)
  }
}

/** PDF mínimo pero válido: alcanza para que el input lo acepte y lo nombre. */
const MINIMAL_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8'
)

export async function runJobsSelfTest(): Promise<boolean> {
  console.log('\n══ AUTOCHEQUEO DE POSTULACIÓN (navegador real, formulario sintético) ══')

  const tmp = join(app.getPath('userData'), 'selftest')
  await rm(tmp, { recursive: true, force: true })
  await mkdir(join(tmp, 'cv'), { recursive: true })
  await writeFile(join(tmp, 'cv', 'main_examplecorp.pdf'), MINIMAL_PDF)

  let profile
  try {
    profile = parseProfile(JSON.parse(await readFile(join(workspaceDir(), 'albus-profile.json'), 'utf8')))
  } catch (error: unknown) {
    console.log(`  FALLA no pude leer el perfil: ${String(error)}`)
    return false
  }

  // ── ASSERT 5 · la sesión persiste en la partición ────────────────────────
  console.log('\n── assert 5 · la partición guarda cookies entre corridas')

  const cookies = jobsSession().cookies
  const previous = await cookies.get({ url: 'https://albus.selftest.invalid', name: 'albus_probe' })

  await cookies.set({
    url: 'https://albus.selftest.invalid',
    name: 'albus_probe',
    value: 'ok',
    expirationDate: Math.floor(Date.now() / 1000) + 86_400
  })
  const written = await cookies.get({ url: 'https://albus.selftest.invalid', name: 'albus_probe' })

  check('la cookie se escribe en la partición', written.length, 1)
  if (previous.length > 0) {
    check('la cookie sobrevivió a la corrida anterior', previous[0].value, 'ok')
  } else {
    console.log('  info  primera corrida: volvé a correr el autochequeo para probar persistencia')
  }

  // ── el kit se prepara con el nombre correcto ─────────────────────────────
  console.log('\n── assert 3 · el archivo llega al formulario con el nombre del candidato')

  const kitSource = createWorkspaceKitSource(join(tmp, 'staging'))

  // El perfil ya está leído del workspace real; de acá en adelante el "workspace"
  // es la carpeta temporal, para no depender de que exista un PDF compilado de
  // una empresa concreta ni de tocar nada del repo del usuario.
  const realWorkspace = process.env.JOB_WORKSPACE_DIR
  process.env.JOB_WORKSPACE_DIR = tmp

  const kit = await kitSource.findKit({
    url: '',
    company: 'ExampleCorp',
    role: 'Frontend',
    slug: 'examplecorp'
  })
  process.env.JOB_WORKSPACE_DIR = realWorkspace

  check('encuentra el CV compilado del workspace', kit.cv !== null, true)

  const staged =
    kit.cv !== null ? await kitSource.stageForUpload(kit.cv, profile.cvFileBaseName) : null
  const stagedName = staged === null ? null : staged.replace(/\\/g, '/').split('/').pop()
  check('la copia se llama como el candidato', stagedName, cvUploadName(profile, 'x.pdf'))

  // ── el bucle completo contra el fixture ──────────────────────────────────
  console.log('\n── assert 4 + 6 · leer el formulario, llenarlo y NO enviarlo')

  const fixture = pathToFileURL(join(app.getAppPath(), 'resources', 'job-form-fixture.html')).href
  const browser = createBrowserPage({ visible: false })

  try {
    await browser.open(fixture)
    const form = await browser.readForm()

    check('el buscador del header no entra como campo', form.fields.some((f) => f.name === 'search'), false)
    // 22 campos + el archivo + el checkbox de consentimiento. Los tres grupos
    // de radios cuentan como uno cada uno, no como seis inputs.
    check('lee los 24 controles del modal', form.fields.length, 24)
    check(
      'el label del grupo de radios es la pregunta, no "Yes"',
      form.fields.find((f) => f.name === 'authorized')?.label,
      'Are you legally authorized to work in Colombia?'
    )
    check(
      'el select trae sus opciones (4 niveles + el "Select" vacío)',
      form.fields.find((f) => f.name === 'english')?.options.length,
      5
    )
    check(
      'detecta el input de archivo',
      form.fields.find((f) => f.name === 'resume')?.kind,
      'file'
    )
    check(
      'clasifica el botón de envío',
      form.buttons.find((b) => b.label === 'Submit application')?.kind,
      'submit'
    )

    const outcome = await runApply(
      {
        browser,
        profile,
        kit: { cvSource: kit.cv, cvUpload: staged, coverSource: null, coverUpload: null },
        // Sin LLM a propósito: este chequeo mide las reglas y el freno, no el modelo.
        llm: null,
        mode: 'review',
        screenshotDir: join(tmp, 'shots')
      },
      { url: fixture, company: 'ExampleCorp', role: 'Frontend', slug: 'examplecorp' },
      fixture
    )

    check('el bucle termina en "llenado", no en "enviado"', outcome.status, 'filled')
    check('llenó al menos 18 campos', (outcome.steps[0]?.filled ?? 0) >= 18, true)
    check('dejó un screenshot como evidencia', outcome.steps[0]?.screenshot !== null, true)

    // El assert que importa: el flag del fixture sigue sin tocarse.
    const submitted = await browser.window.webContents.executeJavaScript(
      'JSON.stringify(!!window.__albusSubmitted)'
    )
    check('NUNCA se apretó el submit', JSON.parse(submitted as string), false)

    // Y este es el assert 3 de verdad: qué nombre ve la página, no qué nombre
    // calculamos nosotros.
    const nameOnPage = await browser.window.webContents.executeJavaScript(
      `JSON.stringify((() => { const i = document.querySelector('input[name=resume]'); return i && i.files[0] ? i.files[0].name : null })())`
    )
    check(
      'el formulario recibió "CV Jorge David Diaz.pdf"',
      JSON.parse(nameOnPage as string),
      cvUploadName(profile, 'x.pdf')
    )

    // Verificación de valores escritos, leídos del DOM y no de nuestro plan.
    const domJson = await browser.window.webContents.executeJavaScript(
      `JSON.stringify((() => {
        const v = (n) => { const e = document.querySelector('[name="' + n + '"]'); return e ? e.value : null }
        const r = (n) => { const e = document.querySelector('input[name="' + n + '"]:checked'); return e ? e.value : null }
        return {
          first: v('first_name'), email: v('email'), city: v('city'),
          country: v('country'), code: v('phone_country_code'), english: v('english'),
          react: v('years_react'), python: v('years_python'),
          auth: r('authorized'), sponsor: r('sponsorship'), relocate: r('relocate'),
          privacy: document.querySelector('input[name=privacy]').checked,
          education: v('education')
        }
      })())`
    )
    const dom = JSON.parse(domJson as string) as Record<string, unknown>

    console.log('\n── lo que quedó escrito en el DOM')
    check('nombre', dom.first, profile.firstName)
    check('email', dom.email, profile.email)
    check('ciudad', dom.city, `${profile.city}, ${profile.country}`)
    check('país', dom.country, 'co')
    check('código de país', dom.code, 'co')
    check('inglés', dom.english, 'conv')
    check('años con React', dom.react, String(profile.yearsExperience.react))
    check('años con Python → vacío, no inventado', dom.python, '')
    check('autorizado', dom.auth, 'Yes')
    check('sponsorship', dom.sponsor, 'No')
    check('reubicación', dom.relocate, 'No')
    check('el consentimiento sigue SIN tildar', dom.privacy, false)
    check('nivel académico → vacío, no un título falso', dom.education, '')
  } catch (error: unknown) {
    failed++
    console.log(`  FALLA excepción en el bucle: ${String(error)}`)
  } finally {
    await browser.close()
  }

  const total = passed + failed
  console.log(`\n${'='.repeat(60)}`)
  console.log(`NAVEGADOR   ${passed}/${total} ${failed === 0 ? '✓' : '✗'}`)
  console.log(`${'='.repeat(60)}\n`)

  return failed === 0
}
