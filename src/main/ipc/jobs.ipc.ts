import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { registerHandler } from './register-handler'
import {
  IpcChannels,
  IpcEvents,
  isApplicableUrl,
  type AgentInfo,
  type HuntResult,
  type EmailApplyResult,
  type JobApplyResult,
  type JobsStatus,
  type ChatIntent,
  type KitResultRow,
  type RankedJobRow
} from '../../shared/ipc'
import { cvUploadName } from '../core/jobs/cv-name'
import type { RankedJob } from '../core/jobs/rank'
import { hasLinkedInSession, openLoginWindow } from '../browser/session'
import { hasGmailScope } from '../gmail/send'
import { isNotionConfigured } from '../notion/client'
import { listAgents } from '../agents/registry'
import { confirmApplied, runApplication } from '../jobs/apply-runner'
import { applyByEmail } from '../jobs/email-runner'
import { hunt, DEFAULT_QUERIES } from '../jobs/hunt'
import { createWorkspaceKitSource, loadProfile, slugify } from '../jobs/workspace'
import { uploadStagingDir } from '../jobs/apply-runner'
import { getProvider } from '../providers/registry'
import type { LlmTier } from '../core/jobs/answers-llm'

/**
 * El main nunca confía en el renderer: todo payload pasa por zod, y la URL
 * además por la allowlist de hosts. Que el renderer sea nuestro no cambia
 * nada — es la frontera, y las fronteras se chequean de este lado.
 */

const ApplySchema = z.object({
  url: z.string().url().refine(isApplicableUrl, 'ese host no está en la allowlist de postulación'),
  company: z.string().min(1).max(120),
  role: z.string().min(1).max(160),
  slug: z.string().max(80).default(''),
  mode: z.enum(['dry-run', 'review', 'auto']).default('review'),
  sector: z.string().max(120).default(''),
  fitRating: z.string().max(10).default(''),
  jobDescription: z.string().max(8000).default(''),
  providerId: z.string().max(40).nullable().default(null),
  modelId: z.string().max(60).nullable().default(null)
})

const KitSchema = z.object({
  /** Id de la vacante en la lista, para que el progreso vaya a su tarjeta. */
  id: z.string().max(40).default(''),
  url: z.string().url().refine(isApplicableUrl, 'ese host no está en la allowlist'),
  company: z.string().min(1).max(120),
  role: z.string().min(1).max(160),
  slug: z.string().max(80).default('')
})

const HuntSchema = z.object({
  queries: z.array(z.string().min(2).max(80)).min(1).max(8).default(DEFAULT_QUERIES),
  location: z.string().min(2).max(80).default('Colombia'),
  maxRank: z.number().int().min(1).max(25).default(12),
  saveToNotion: z.boolean().default(true),
  providerId: z.string().max(40),
  modelId: z.string().max(60).nullable().default(null)
})

const EmailSchema = z.object({
  to: z.string().email(),
  cc: z.array(z.string().email()).max(5).default([]),
  company: z.string().min(1).max(120),
  role: z.string().min(1).max(160),
  slug: z.string().max(80).default(''),
  subject: z.string().max(200).default(''),
  body: z.string().max(8000).default(''),
  mode: z.enum(['dry-run', 'review', 'auto']).default('review'),
  postUrl: z.string().max(500).default(''),
  fitRating: z.string().max(10).default(''),
  jobDescription: z.string().max(8000).default('')
})

const ConfirmSchema = z.object({
  url: z.string().url(),
  company: z.string().min(1).max(120),
  role: z.string().min(1).max(160),
  sector: z.string().max(120).default(''),
  fitRating: z.string().max(10).default(''),
  notes: z.string().max(2000).default(''),
  cvFile: z.string().max(300).default(''),
  coverLetterFile: z.string().max(300).default('')
})

/**
 * Qué CLI usar. Si el renderer no eligió ninguno, lo resuelve el main.
 *
 * Antes esto devolvía `null` con un `providerId` vacío y el error era
 * `el CLI "" no está disponible` — incomprensible, y encima culpaba al usuario
 * de algo que era una carrera: `cli:list` tarda hasta 16 segundos en detectar
 * los binarios, y si escribís antes de que termine, la UI todavía no tiene
 * ningún provider que mandar.
 *
 * Que el main elija cuando el renderer no sabe es lo correcto: el dominio vive
 * acá, y hacer que la app funcione dependa de si un `useEffect` ya terminó es
 * frágil por definición.
 */
async function resolveLlm(
  providerId: string | null,
  modelId: string | null
): Promise<LlmTier | null> {
  if (providerId !== null && providerId.trim() !== '') {
    const provider = getProvider(providerId)
    if (provider !== null) return { provider, model: modelId }
  }

  const { firstAvailableProvider } = await import('../providers/registry')
  const auto = await firstAvailableProvider(modelId ?? 'sonnet')
  if (auto === null) return null

  const provider = getProvider(auto.id)
  return provider === null ? null : { provider, model: modelId ?? auto.model }
}

/** El mensaje que se le muestra al usuario cuando de verdad no hay ningún CLI. */
const NO_CLI =
  'No encontré ningún CLI de IA instalado (claude o agy). El triage los necesita para puntuar las vacantes contra tu perfil.'

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

/** ¿Hay PDF compilado para esta empresa? Decide si el botón "postular" sirve. */
async function withKit(ranked: RankedJob[]): Promise<RankedJobRow[]> {
  const kitSource = createWorkspaceKitSource(uploadStagingDir())
  const rows: RankedJobRow[] = []

  for (const j of ranked) {
    const slug = slugify(j.company)
    let kitReady = false
    try {
      kitReady = (await kitSource.findKit({ url: j.url, company: j.company, role: j.title, slug })).cv !== null
    } catch {
      kitReady = false
    }
    rows.push({
      id: j.id,
      title: j.title,
      company: j.company,
      location: j.location,
      date: j.date,
      url: j.url,
      score: j.score,
      gates: j.gates,
      reason: j.reason,
      angle: j.angle,
      description: j.description,
      kitReady,
      slug
    })
  }

  return rows
}

export function registerJobHandlers(): void {
  registerHandler(IpcChannels.AGENTS_LIST, async (): Promise<AgentInfo[]> => listAgents())

  /**
   * Responder una pregunta ESCRIBE una regla. No es un formulario que se
   * guarda en algún lado opaco: la respuesta se anexa al `.md` del agente y
   * vale para siempre, incluso para la corrida de mañana a las 7.
   */
  registerHandler(IpcChannels.AGENTS_ANSWER, async (payload: unknown) => {
    const { id, questionId, answer } = z
      .object({
        id: z.string().min(1).max(40),
        questionId: z.string().min(1).max(80),
        answer: z.string().min(1).max(2000)
      })
      .parse(payload)

    const { answerQuestion } = await import('../agents/questions')
    const question = answerQuestion(id, questionId, answer)
    if (question === null) throw new Error('esa pregunta ya no existe')

    return { ok: true, agents: await listAgents() }
  })

  registerHandler(IpcChannels.AGENTS_RULES_OPEN, async (payload: unknown) => {
    const { id } = z.object({ id: z.string().min(1).max(40) }).parse(payload)
    const { openAgentRules } = await import('../agents/registry')
    // Devuelve la ruta: si el editor no abre —pasa—, el usuario al menos sabe
    // qué archivo tiene que buscar.
    return { path: await openAgentRules(id) }
  })

  /**
   * Interpretar lo que el usuario escribió. Sin red, sin CLI, sin cuota.
   *
   * Las vacantes vienen del renderer porque "la primera" significa la primera
   * de LA PANTALLA, y la pantalla la conoce él. Igual se validan: todo lo que
   * cruza el IPC es input externo.
   */
  registerHandler(IpcChannels.JOBS_CHAT, async (payload: unknown): Promise<ChatIntent> => {
    const { text, jobs } = z
      .object({
        text: z.string().min(1).max(2000),
        jobs: z
          .array(
            z.object({
              id: z.string(),
              company: z.string(),
              title: z.string(),
              score: z.number()
            })
          )
          .max(50)
      })
      .parse(payload)

    const { interpret } = await import('../core/jobs/chat')
    return interpret(text, jobs)
  })

  registerHandler(IpcChannels.JOBS_STATUS, async (): Promise<JobsStatus> => {
    const linkedInSession = await hasLinkedInSession()
    const notionReady = isNotionConfigured()

    let gmailReady = false
    try {
      gmailReady = (await hasGmailScope()).ok
    } catch {
      gmailReady = false
    }

    // Los faltantes ya no mandan a la terminal: todo se conecta desde la UI.
    const missing: string[] = []
    if (!linkedInSession) missing.push('LinkedIn')
    if (!notionReady) missing.push('Notion')
    if (!gmailReady) missing.push('Google')

    try {
      const profile = await loadProfile(true)
      return {
        workspaceReady: true,
        workspaceError: null,
        linkedInSession,
        cvUploadName: cvUploadName(profile, 'x.pdf'),
        notionReady,
        gmailReady,
        missing
      }
    } catch (error: unknown) {
      return {
        workspaceReady: false,
        workspaceError: error instanceof Error ? error.message : String(error),
        linkedInSession,
        cvUploadName: '',
        notionReady,
        gmailReady,
        missing: ['JOB_WORKSPACE_DIR + albus-profile.json', ...missing]
      }
    }
  })

  registerHandler(IpcChannels.JOBS_LOGIN, async () => {
    const ok = await openLoginWindow()
    return { linkedInSession: ok }
  })

  registerHandler(IpcChannels.JOBS_HUNT, async (payload: unknown): Promise<HuntResult> => {
    const req = HuntSchema.parse(payload)

    const llm = await resolveLlm(req.providerId, req.modelId)
    if (llm === null) throw new Error(NO_CLI)

    const win = mainWindow()
    const report = await hunt({
      queries: req.queries,
      location: req.location,
      maxRank: req.maxRank,
      saveToNotion: req.saveToNotion,
      llm,
      onProgress: (phase, detail) =>
        win?.webContents.send(IpcEvents.JOBS_HUNT_PROGRESS, { phase, detail })
    })

    return {
      found: report.found,
      duplicates: report.duplicates,
      ranked: report.ranked,
      qualified: await withKit(report.qualified),
      rejected: await withKit(report.rejected),
      notionWrites: report.notion.writes,
      notionError: report.notion.error,
      summary: report.summary
    }
  })

  registerHandler(IpcChannels.JOBS_KIT, async (payload: unknown): Promise<KitResultRow> => {
    const req = KitSchema.parse(payload)
    const win = mainWindow()

    const { generateKit } = await import('../jobs/kit')
    return generateKit({
      url: req.url,
      company: req.company,
      role: req.role,
      slug: req.slug,
      onLine: (line) => win?.webContents.send(IpcEvents.JOBS_KIT_PROGRESS, { id: req.id, line })
    })
  })

  registerHandler(IpcChannels.JOBS_APPLY, async (payload: unknown): Promise<JobApplyResult> => {
    const req = ApplySchema.parse(payload)
    const win = mainWindow()

    const report = await runApplication({
      url: req.url,
      company: req.company,
      role: req.role,
      slug: req.slug,
      mode: req.mode,
      sector: req.sector,
      fitRating: req.fitRating,
      jobDescription: req.jobDescription,
      // Acá `null` NO es fatal: sin CLI el formulario igual se llena con las
      // reglas puras, solo que los campos que necesitan criterio quedan
      // vacíos. Es el escalón 4 de la cascada, y es opcional a propósito.
      llm: await resolveLlm(req.providerId, req.modelId),
      onStep: (step) =>
        win?.webContents.send(IpcEvents.JOBS_STEP, {
          index: step.index,
          url: step.url,
          filled: step.filled,
          unresolved: step.unresolved,
          screenshot: step.screenshot,
          action: step.action
        })
    })

    return {
      status: report.outcome.status,
      mode: report.outcome.mode,
      message: report.outcome.message,
      steps: report.outcome.steps.map((s) => ({
        index: s.index,
        url: s.url,
        filled: s.filled,
        unresolved: s.unresolved,
        screenshot: s.screenshot,
        action: s.action
      })),
      unresolved: report.outcome.unresolved,
      uploadedAs: report.uploadedAs,
      cvFound: report.kit.cv,
      coverFound: report.kit.cover,
      trackerWritten: report.trackerWritten,
      notionError: report.notion.error,
      notionPageId: report.notion.pageId,
      windowLeftOpen: report.windowLeftOpen
    }
  })

  registerHandler(IpcChannels.JOBS_EMAIL, async (payload: unknown): Promise<EmailApplyResult> => {
    const req = EmailSchema.parse(payload)
    const report = await applyByEmail(req)

    return {
      status: report.status,
      to: report.to,
      subject: report.subject,
      attachedAs: report.attachedAs,
      message: report.message,
      notionError: report.notion.error
    }
  })

  registerHandler(IpcChannels.JOBS_CONFIRM, async (payload: unknown) => {
    const r = ConfirmSchema.parse(payload)

    await confirmApplied({
      date: new Date().toISOString().slice(0, 10),
      company: r.company,
      sector: r.sector,
      role: r.role,
      roleType: '',
      channel: /linkedin\.com/i.test(r.url) ? 'LinkedIn' : 'Portal',
      status: 'applied',
      contactPerson: '',
      fitRating: r.fitRating,
      notes: r.notes,
      cvFile: r.cvFile,
      coverLetterFile: r.coverLetterFile,
      source: r.url
    })

    return { logged: true }
  })
}
