import { app } from 'electron'
import { join } from 'node:path'
import { runApply, type StagedKit } from '../core/jobs/apply'
import type { LlmTier } from '../core/jobs/answers-llm'
import type { ApplyMode, ApplyOutcome, ApplyStep, JobPosting } from '../core/jobs/types'
import type { TrackerRow } from '../core/jobs/ports'
import { createBrowserPage } from '../browser/page'
import { hasLinkedInSession } from '../browser/session'
import { notionStatus, scrubPii, type NotionRow } from '../core/jobs/notion-map'
import { isNotionConfigured } from '../notion/client'
import { upsertApplication } from '../notion/applications'
import { createCsvTracker } from './tracker'
import { createWorkspaceKitSource, loadProfile, slugify } from './workspace'

/**
 * Junta las piezas: perfil, kit compilado, navegador y el bucle del dominio.
 * Es el equivalente de `extraction.ipc` para postulaciones — el lugar donde
 * los adaptadores se enchufan y el dominio sigue sin conocer a ninguno.
 */

export interface ApplyRequest {
  url: string
  company: string
  role: string
  /** Vacío = se deriva de la empresa. */
  slug: string
  mode: ApplyMode
  llm: LlmTier | null
  sector: string
  fitRating: string
  /** Texto de la vacante, para el espejo en Notion. Vacío si no se tiene. */
  jobDescription: string
  onStep?: (step: ApplyStep) => void
}

export interface NotionMirror {
  /** `null` = no se intentó (Notion apagado). */
  pageId: string | null
  created: boolean
  error: string | null
}

export interface ApplyReport {
  outcome: ApplyOutcome
  /** Kit encontrado en el workspace. `null` en cada campo = no había PDF. */
  kit: { cv: string | null; cover: string | null }
  /** Cómo se llamaron los archivos al subirlos. Lo que ve el reclutador. */
  uploadedAs: string[]
  /** La fila que corresponde al tracker. Escrita solo si ya se envió. */
  trackerRow: TrackerRow
  trackerWritten: boolean
  notion: NotionMirror
  /** En modo review la ventana queda abierta esperando el click del usuario. */
  windowLeftOpen: boolean
}

const NO_NOTION: NotionMirror = { pageId: null, created: false, error: null }

/**
 * El espejo en Notion. Nunca tira: la postulación ya pasó, y perder el
 * registro es feo pero perder el resultado por no poder registrarlo es peor.
 */
async function mirrorInNotion(
  req: ApplyRequest,
  outcome: ApplyOutcome,
  fitScore: number | null,
  description: string
): Promise<NotionMirror> {
  if (!isNotionConfigured()) {
    return { pageId: null, created: false, error: 'falta NOTION_TOKEN en .env' }
  }

  const status = notionStatus(outcome.status)
  if (status === null) {
    // Antes que inventar una opción en el select del usuario, no escribimos.
    return { pageId: null, created: false, error: `estado "${outcome.status}" sin mapear` }
  }

  try {
    const profile = await loadProfile()
    const pending =
      outcome.unresolved.length > 0
        ? `Completar a mano: ${outcome.unresolved.slice(0, 6).join('; ')}`
        : outcome.status === 'filled'
          ? 'Formulario lleno esperando tu click de enviar'
          : ''

    const row: NotionRow = {
      company: req.company,
      role: req.role,
      status,
      date: new Date().toISOString().slice(0, 10),
      fitScore,
      postLink: req.url,
      contactUrl: req.url,
      jobDescription: scrubPii(description, profile),
      coverLetter: '',
      nextAction: scrubPii(pending, profile)
    }

    const r = await upsertApplication(row)
    return { pageId: r.pageId, created: r.created, error: null }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[jobs] no se pudo espejar en Notion: ${message}`)
    return { pageId: null, created: false, error: message }
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function screenshotDir(slug: string): string {
  return join(app.getPath('userData'), 'job-screenshots', `${today()}_${slug}`)
}

/** Los temporales van al userData de la app, no al workspace del usuario. */
export function uploadStagingDir(): string {
  return join(app.getPath('userData'), 'job-uploads')
}

export async function runApplication(req: ApplyRequest): Promise<ApplyReport> {
  const profile = await loadProfile()
  const slug = req.slug !== '' ? req.slug : slugify(req.company)

  const posting: JobPosting = {
    url: req.url,
    company: req.company,
    role: req.role,
    slug
  }

  // LinkedIn sin sesión devuelve un muro de login y el bucle leería ESE
  // formulario. Cortamos antes, con un mensaje que dice qué hacer.
  if (/linkedin\.com/i.test(req.url) && !(await hasLinkedInSession())) {
    const empty: ApplyOutcome = {
      status: 'needs-login',
      url: req.url,
      mode: req.mode,
      steps: [],
      unresolved: [],
      uploadedAs: [],
      message: 'no hay sesión de LinkedIn en Albus — corré el login una vez desde jobs:login'
    }
    return {
      outcome: empty,
      kit: { cv: null, cover: null },
      uploadedAs: [],
      trackerRow: toTrackerRow(req, posting, null, null, empty),
      trackerWritten: false,
      notion: NO_NOTION,
      windowLeftOpen: false
    }
  }

  const kitSource = createWorkspaceKitSource(uploadStagingDir())
  const found = await kitSource.findKit(posting)

  const staged: StagedKit = {
    cvSource: found.cv,
    cvUpload:
      found.cv !== null ? await kitSource.stageForUpload(found.cv, profile.cvFileBaseName) : null,
    coverSource: found.cover,
    coverUpload:
      found.cover !== null
        ? await kitSource.stageForUpload(found.cover, profile.coverFileBaseName)
        : null
  }

  // En `review` la ventana tiene que quedar visible: el envío lo hace el
  // usuario. En `auto` también se muestra, porque una postulación enviándose
  // sola sin que se vea es exactamente lo que nadie quiere descubrir después.
  const browser = createBrowserPage({ visible: req.mode !== 'dry-run' })

  let outcome: ApplyOutcome
  try {
    outcome = await runApply(
      {
        browser,
        profile,
        kit: staged,
        llm: req.llm,
        mode: req.mode,
        screenshotDir: screenshotDir(slug),
        onStep: req.onStep
      },
      posting,
      req.url
    )
  } catch (error: unknown) {
    // El bucle ya atrapa lo suyo; esto es el cinturón por si el adaptador
    // explota antes de entrar. Un fallo no puede dejar la ventana colgada.
    const message = error instanceof Error ? error.message : String(error)
    outcome = {
      status: 'failed',
      url: req.url,
      mode: req.mode,
      steps: [],
      unresolved: [],
      uploadedAs: [],
      message
    }
  }

  const leaveOpen = outcome.status === 'filled' && req.mode === 'review'
  if (leaveOpen) browser.reveal()
  else await browser.close()

  const row = toTrackerRow(req, posting, staged.cvSource, staged.coverSource, outcome)

  let trackerWritten = false
  if (outcome.status === 'submitted') {
    try {
      await createCsvTracker().append(row)
      trackerWritten = true
    } catch (error: unknown) {
      // No perdemos la postulación por no poder escribir el CSV. Se reporta.
      console.warn(`[jobs] no se pudo escribir el tracker: ${String(error)}`)
    }
  }

  // Notion se espeja SIEMPRE que la corrida haya llegado a algo, no solo
  // cuando se envió: una vacante llena esperando tu click también es estado
  // que querés ver en el tablero.
  const notion =
    outcome.status === 'failed'
      ? NO_NOTION
      : await mirrorInNotion(req, outcome, numberOrNull(req.fitRating), req.jobDescription)

  return {
    outcome,
    kit: found,
    uploadedAs: outcome.uploadedAs,
    trackerRow: row,
    trackerWritten,
    notion,
    windowLeftOpen: leaveOpen
  }
}

function numberOrNull(value: string): number | null {
  const n = Number(value)
  return value.trim() !== '' && Number.isFinite(n) ? n : null
}

/** Se registra lo que pasó, no lo que uno querría que hubiera pasado. */
function toTrackerRow(
  req: ApplyRequest,
  posting: JobPosting,
  cv: string | null,
  cover: string | null,
  outcome: ApplyOutcome
): TrackerRow {
  const pending =
    outcome.unresolved.length > 0
      ? ` | sin responder: ${outcome.unresolved.slice(0, 6).join('; ')}`
      : ''

  const relative = (p: string | null): string =>
    p === null ? '' : p.replace(/\\/g, '/').split('/').slice(-2).join('/')

  return {
    date: today(),
    company: req.company,
    sector: req.sector,
    role: req.role,
    roleType: '',
    channel: /linkedin\.com/i.test(req.url) ? 'LinkedIn' : 'Portal',
    status: outcome.status === 'submitted' ? 'applied' : outcome.status,
    contactPerson: '',
    fitRating: req.fitRating,
    notes: `${today()}: Albus (${outcome.mode}) — ${outcome.message}${pending}`,
    cvFile: relative(cv),
    coverLetterFile: relative(cover),
    source: posting.url
  }
}

/** Para cerrar el círculo cuando el envío lo hizo el usuario en modo review. */
export async function confirmApplied(row: TrackerRow): Promise<void> {
  await createCsvTracker().append({ ...row, status: 'applied' })
}
