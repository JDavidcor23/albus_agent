import { app } from 'electron'
import { z } from 'zod'
import { isApplicableUrl } from '../../shared/ipc'
import { hasLinkedInSession, openLoginWindow } from '../browser/session'
import { getProvider } from '../providers/registry'
import type { LlmTier } from '../core/jobs/answers-llm'
import { runApplication } from './apply-runner'
import { runJobsSelfTest } from '../devtools/selftest'
import { loadProfile } from './workspace'

/**
 * Albus como worker, sin ventana de aplicación.
 *
 * El pedido fue explícito: primero que corra en background, la pantalla
 * después. Todo esto entra por `runJobsCommand`, que lee una variable de
 * entorno y decide. Cuando llegue la UI no cambia nada acá: el renderer va a
 * llamar a `runApplication` por IPC, que es la misma función.
 *
 * Se maneja con `npm run jobs:login`, `jobs:apply` y `jobs:selftest`.
 */

const ApplyEnvSchema = z.object({
  url: z.string().url().refine(isApplicableUrl, 'host fuera de la allowlist de postulación'),
  company: z.string().min(1),
  role: z.string().min(1),
  slug: z.string().default(''),
  mode: z.enum(['dry-run', 'review', 'auto']).default('review'),
  sector: z.string().default(''),
  fitRating: z.string().default(''),
  jobDescription: z.string().max(8000).default(''),
  providerId: z.string().nullable().default('claude-code'),
  modelId: z.string().nullable().default(null)
})

function tier(providerId: string | null, modelId: string | null): LlmTier | null {
  if (providerId === null) return null
  const provider = getProvider(providerId)
  if (provider === null) {
    console.warn(`[jobs] el proveedor "${providerId}" no está instalado — voy solo con reglas`)
    return null
  }
  return { provider, model: modelId }
}

function heading(text: string): void {
  console.log(`\n${'═'.repeat(64)}\n${text}\n${'═'.repeat(64)}`)
}

async function loginCommand(): Promise<number> {
  heading('LOGIN DE LINKEDIN — una sola vez, después queda guardado')

  if (await hasLinkedInSession()) {
    console.log('Ya hay sesión guardada en la partición de Albus. No hace falta nada.')
    return 0
  }

  console.log('Se abre una ventana. Entrá a LinkedIn a mano y cerrala cuando estés adentro.')
  console.log('Albus no automatiza el login: ni guarda tu contraseña ni la escribe por script.\n')

  const ok = await openLoginWindow()
  console.log(ok ? '\nSesión guardada. No te la vuelve a pedir.' : '\nNo se guardó ninguna sesión.')
  return ok ? 0 : 1
}

async function applyCommand(raw: string): Promise<number> {
  let req: z.infer<typeof ApplyEnvSchema>
  try {
    req = ApplyEnvSchema.parse(JSON.parse(raw))
  } catch (error: unknown) {
    console.error(`[jobs] la petición no es válida: ${String(error)}`)
    return 1
  }

  heading(`POSTULACIÓN — ${req.company} · ${req.role}   [modo ${req.mode}]`)

  const profile = await loadProfile()
  console.log(`Perfil: ${profile.fullName} · el CV se sube como "${profile.cvFileBaseName}.pdf"`)
  console.log(`URL: ${req.url}\n`)

  const report = await runApplication({
    url: req.url,
    company: req.company,
    role: req.role,
    slug: req.slug,
    mode: req.mode,
    sector: req.sector,
    fitRating: req.fitRating,
    jobDescription: req.jobDescription,
    llm: tier(req.providerId, req.modelId),
    onStep: (s) =>
      console.log(`  paso ${s.index + 1}: ${s.filled} campos llenados — ${s.action}`)
  })

  console.log(`\nKit encontrado:`)
  console.log(`  CV    ${report.kit.cv ?? '(no hay PDF compilado para esta empresa)'}`)
  console.log(`  Carta ${report.kit.cover ?? '(no hay)'}`)

  if (report.uploadedAs.length > 0) {
    console.log(`\nAdjuntado como: ${report.uploadedAs.join(', ')}`)
  }

  if (report.outcome.unresolved.length > 0) {
    console.log(`\nSin responder — completalos vos antes de enviar:`)
    for (const u of report.outcome.unresolved) console.log(`  · ${u}`)
  }

  for (const s of report.outcome.steps) {
    if (s.screenshot !== null) console.log(`\nCaptura: ${s.screenshot}`)
  }

  console.log(`\nEstado: ${report.outcome.status} — ${report.outcome.message}`)
  console.log(`Tracker: ${report.trackerWritten ? 'fila escrita' : 'sin escribir (todavía no se envió)'}`)

  if (report.windowLeftOpen) {
    console.log(`\nLa ventana queda abierta con el formulario lleno. Revisá y apretá enviar vos.`)
    console.log(`Cuando lo hagas, registralo con: npm run jobs:confirm`)
    // No cerramos la app: el usuario todavía tiene que mirar la pantalla.
    return -1
  }

  return report.outcome.status === 'failed' || report.outcome.status === 'needs-login' ? 1 : 0
}

/**
 * Devuelve el código de salida, o `null` si no había ningún comando (arranque
 * normal de la app), o -1 para "no salgas, el usuario está mirando".
 */
export async function runJobsCommand(): Promise<number | null> {
  if (process.env.ALBUS_JOBS_SELFTEST === '1') {
    return (await runJobsSelfTest()) ? 0 : 1
  }

  if (process.env.ALBUS_NAV_CHECK === '1') {
    const { runNavSelfTest } = await import('../devtools/nav-selftest')
    return (await runNavSelfTest()) ? 0 : 1
  }

  const inspectUrl = process.env.ALBUS_NAV_INSPECT
  if (inspectUrl !== undefined && inspectUrl.trim() !== '') {
    const { inspectPage: inspect } = await import('../devtools/inspect')
    return (await inspect(inspectUrl.trim())) ? 0 : 1
  }

  if (process.env.ALBUS_SUPA_REPRO === '1') {
    const { reproSupabase } = await import('../devtools/repro')
    return (await reproSupabase()) ? 0 : 1
  }

  if (process.env.ALBUS_NOTION_PROBE === '1') {
    const { probeNotion } = await import('../devtools/probe-notion')
    return (await probeNotion()) ? 0 : 1
  }

  if (process.env.ALBUS_UI_DEMO === '1') {
    const { runUiDemo } = await import('../devtools/ui-demo')
    return (await runUiDemo()) ? 0 : 1
  }

  if (process.env.ALBUS_UI_SELFTEST === '1') {
    const { runUiSelfTest } = await import('../devtools/ui-selftest')
    return (await runUiSelfTest()) ? 0 : 1
  }

  if (process.env.ALBUS_JOBS_LOGIN === '1') {
    return loginCommand()
  }

  const apply = process.env.ALBUS_JOBS_APPLY
  if (apply !== undefined && apply.trim() !== '') {
    try {
      return await applyCommand(apply)
    } catch (error: unknown) {
      console.error(`\n[jobs] la corrida falló: ${String(error)}`)
      return 1
    }
  }

  return null
}

/** Ata el comando al ciclo de vida de Electron. Lo llama `main/index.ts`. */
export function maybeRunJobsCommand(): boolean {
  const hasCommand =
    process.env.ALBUS_JOBS_SELFTEST === '1' ||
    process.env.ALBUS_NAV_CHECK === '1' ||
    (process.env.ALBUS_NAV_INSPECT ?? '').trim() !== '' ||
    process.env.ALBUS_UI_SELFTEST === '1' ||
    process.env.ALBUS_UI_DEMO === '1' ||
    process.env.ALBUS_NOTION_PROBE === '1' ||
    process.env.ALBUS_SUPA_REPRO === '1' ||
    process.env.ALBUS_JOBS_LOGIN === '1' ||
    (process.env.ALBUS_JOBS_APPLY ?? '').trim() !== ''

  if (!hasCommand) return false

  void runJobsCommand().then((code) => {
    if (code === null || code === -1) return
    app.exit(code)
  })

  return true
}
