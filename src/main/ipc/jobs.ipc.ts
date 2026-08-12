import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { registerHandler } from './register-handler'
import {
  IpcChannels,
  IpcEvents,
  isApplicableUrl,
  type AgentInfo,
  type AgentResult,
  type AgentStep,
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
import { agentRules, enabledTools, listAgents } from '../agents/registry'
import { parseSearchPrefs, EMPTY_PREFS } from '../core/jobs/search-prefs'
import { runAgent } from '../core/jobs/agent'
import { JOB_TOOLS, runTool, toView, type ToolDeps } from '../jobs/agent-tools'
import { openApplicationForAgent } from '../jobs/open-application'
import { appWindow } from '../app-window'
import { confirmApplied, runApplication } from '../jobs/apply-runner'
import { applyByEmail } from '../jobs/email-runner'
import { hunt, DEFAULT_QUERIES } from '../jobs/hunt'
import { trackedApplications } from '../notion/applications'
import { dedupeKey } from '../jobs/search'
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
  url: z.string().url().refine(isApplicableUrl, 'that host is not on the apply allowlist'),
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
  url: z.string().url().refine(isApplicableUrl, 'that host is not on the allowlist'),
  company: z.string().min(1).max(120),
  role: z.string().min(1).max(160),
  slug: z.string().max(80).default('')
})

/**
 * `queries` vacío es un valor VÁLIDO y significa "usá mis reglas".
 *
 * Tenía `.min(1)`, y eso convertía en inexpresable justo lo que el dominio
 * define como el caso normal (`chat.ts` → *"`queries` vacío = usar lo que digan
 * las reglas"*). El renderer, que no podía mandar vacío, mandaba dos roles
 * hardcodeados. Resultado: `DEFAULT_QUERIES` nunca se usó y el `.md` del
 * usuario tampoco — `.default()` solo dispara con `undefined`, que nadie manda.
 *
 * Lo mismo con `location`: vacío = lo que diga el `.md`, y recién si tampoco
 * está ahí, Colombia.
 */
/**
 * Lo que el usuario está viendo, tal cual.
 *
 * Viaja entero —con `url` y `description`— y no en la versión recortada de
 * `JOBS_CHAT`, porque las herramientas postulan y arman CV de verdad: sin la
 * URL no hay a dónde ir. La pantalla la manda el renderer y no la guarda el
 * main a propósito: dos copias del mismo estado es cómo se llega a "acá dice
 * una cosa y allá otra".
 */
const AgentJobSchema = z.object({
  id: z.string().max(80),
  title: z.string().max(200).default(''),
  company: z.string().max(200).default(''),
  location: z.string().max(200).default(''),
  date: z.string().max(40).default(''),
  url: z.string().max(600).default(''),
  score: z.number().min(0).max(100).default(0),
  gates: z.array(z.string().max(40)).max(10).default([]),
  reason: z.string().max(2000).default(''),
  angle: z.string().max(2000).default(''),
  description: z.string().max(8000).default(''),
  kitReady: z.boolean().default(false),
  slug: z.string().max(80).default('')
})

const AgentSchema = z.object({
  text: z.string().min(1).max(2000),
  jobs: z.object({
    screen: z.array(AgentJobSchema).max(60).default([]),
    providerId: z.string().max(40).default(''),
    modelId: z.string().max(60).nullable().default(null)
  })
})

/** La fila del renderer de vuelta a la del dominio. `kitReady` va aparte. */
function toRankedJob(row: z.infer<typeof AgentJobSchema>): RankedJob {
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    location: row.location,
    date: row.date,
    url: row.url,
    description: row.description,
    score: row.score,
    gates: row.gates as RankedJob['gates'],
    reason: row.reason,
    angle: row.angle
  }
}

const HuntSchema = z.object({
  queries: z.array(z.string().min(2).max(80)).max(8).default([]),
  location: z.string().max(80).default(''),
  /*
   * Techo de SEGURIDAD, no una cuota de trabajo.
   *
   * Era 12 y lo mandaba el renderer fijo: con 38 encontradas se puntuaban 12 y
   * 25 quedaban afuera sin que el usuario se enterara. El pedido fue claro —
   * "puntuar todas y cada una y mostrarlas"—, así que el default alcanza para
   * un barrido entero y esto queda solo como freno: cada vacante es una
   * request a LinkedIn y tokens, y un ladder sin tope puede irse a cientos.
   */
  maxRank: z.number().int().min(1).max(120).default(60),
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

/** El agente dueño del `.md` con las reglas de búsqueda. Sale del registro. */
const JOB_SEARCH = 'job-search'

/**
 * Qué buscar, cuando el renderer no lo dijo.
 *
 * Mismo criterio que `resolveLlm`: **el dominio vive en el main**, así que si
 * el renderer no sabe, decide acá. La cadena es una escalera de lo más
 * específico a lo más genérico, y el orden es todo el punto:
 *
 *   1. lo que el usuario acaba de pedir por chat ("buscame trabajo de Go")
 *   2. lo que escribió en `## Qué buscar` de su `.md`
 *   3. `DEFAULT_QUERIES`, la red para quien todavía no escribió reglas
 *
 * El escalón 2 no existía. La plantilla le pedía al usuario que escribiera sus
 * roles, él los escribía, y no los leía nadie: el renderer mandaba dos roles
 * fijos y el `.md` quedaba de adorno. Encontrar el archivo lleno y el buscador
 * ignorándolo es peor que no tener el archivo.
 */
interface ResolvedSearch {
  queries: string[]
  /** Ya resuelta: acá no queda `null` para que lo maneje el de abajo. */
  location: string
  avoid: string[]
}

function resolveSearch(queries: string[], location: string): ResolvedSearch {
  let prefs = EMPTY_PREFS
  try {
    prefs = parseSearchPrefs(agentRules(JOB_SEARCH))
  } catch (error: unknown) {
    // Un `.md` ilegible no puede tumbar la búsqueda: se cae al default y se
    // dice por qué, que es distinto de buscar mal en silencio.
    console.warn(`[jobs] no pude leer las reglas de ${JOB_SEARCH}: ${String(error)}`)
  }

  const resolved =
    queries.length > 0 ? queries : prefs.roles.length > 0 ? prefs.roles : DEFAULT_QUERIES

  const from =
    queries.length > 0 ? 'el chat' : prefs.roles.length > 0 ? 'tus reglas' : 'el default'
  console.log(`[jobs] busco ${resolved.join(' · ')} (de ${from})`)

  return {
    queries: resolved,
    location: location !== '' ? location : (prefs.location ?? 'Colombia'),
    avoid: prefs.avoid
  }
}

/** El mensaje que se le muestra al usuario cuando de verdad no hay ningún CLI. */
const NO_CLI =
  'No AI CLI installed (claude or agy). Triage needs one to score the openings against your profile.'

/**
 * La ventana de la APP, registrada por quien la crea.
 *
 * Acá había `BrowserWindow.getAllWindows()[0]`. Durante una postulación hay dos
 * ventanas y la segunda —la del navegador que llena el formulario, que en `review`
 * queda abierta— NO tiene preload: un `send` hacia ella se descarta en silencio.
 * El agente preguntaba, la pregunta se iba a la página de la empresa, y el usuario
 * miraba un chat vacío sin saber que le habían preguntado algo.
 */
function mainWindow(): BrowserWindow | null {
  return appWindow()
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

  /**
   * Lo pendiente, sin barrer.
   *
   * Se lee de Notion y no se re-puntúa: la base ya tiene el `Fit Score` y el
   * ángulo de cuando se evaluaron. Es la lista con la que el usuario abre la
   * app — "acá está lo que te falta resolver" — en vez de una pantalla vacía
   * que obliga a un barrido de seis minutos para recuperar lo que ya sabíamos.
   */
  registerHandler(IpcChannels.JOBS_BACKLOG, async (): Promise<RankedJobRow[]> => {
    if (!isNotionConfigured()) return []

    const { backlog } = await trackedApplications()
    const rows = backlog.map((row) => ({
      id: dedupeKey(row.url),
      title: row.role,
      company: row.company,
      location: '',
      date: row.date,
      url: row.url,
      description: row.description,
      score: row.score,
      gates: [] as string[],
      reason: row.note !== '' ? row.note : 'left pending from an earlier search',
      angle: row.note
    }))

    rows.sort((a, b) => b.score - a.score)
    return withKit(rows as RankedJob[])
  })

  /**
   * El agente. Le hablás y él decide qué herramientas usar.
   *
   * Reemplaza a `JOBS_CHAT` + `interpret()`: ahí una frase que nadie previó
   * moría en "no lo sé contestar", y cada forma nueva de pedir lo mismo era una
   * línea de código más. Acá el modelo lee las reglas del usuario ENTERAS, ve
   * las herramientas y la pantalla, y elige. "Postulame a todas", "tirale un CV
   * a los de INDI" y "descartá las de Java" son el mismo camino.
   */
  registerHandler(IpcChannels.JOBS_AGENT, async (payload: unknown): Promise<AgentResult> => {
    const { text, jobs } = AgentSchema.parse(payload)

    const llm = await resolveLlm(jobs.providerId, jobs.modelId)
    if (llm === null) throw new Error(NO_CLI)

    const win = mainWindow()
    const emit = (kind: AgentStep['kind'], detail: string): void => {
      // También a la consola: cuando algo tarda veinte minutos, el log de la
      // terminal es lo que el usuario mira para saber si sigue vivo, y ahí no
      // aparecía NADA del agente — solo ruido SSL de trackers ajenos.
      console.log(`[agente] ${kind}: ${detail}`)
      win?.webContents.send(IpcEvents.JOBS_AGENT_STEP, { kind, text: detail })
    }

    // El estado del pedido vive acá y las herramientas lo mutan: `buscar`
    // reemplaza la pantalla, `descartar` saca una. El renderer manda la suya al
    // empezar porque es lo que el usuario está VIENDO — la fuente de verdad de
    // "esa", "la primera", "la de BairesDev".
    const deps: ToolDeps = {
      llm,
      screen: jobs.screen.map(toRankedJob),
      kitReady: new Set(jobs.screen.filter((j) => j.kitReady).map((j) => j.id)),
      onProgress: (phase, detail) => emit('progress', `${phase}: ${detail}`)
    }

    const turns = await runAgent(
      {
        // ENTERAS y sin parsear. Es el punto del archivo de reglas: que valga
        // lo que el usuario escribió aunque nadie haya programado ese campo.
        rules: agentRules(JOB_SEARCH),
        // Recortadas por el manifiesto del agente: qué puede hacer es dato del
        // usuario (`tools` en `<id>.agente.json`), no una constante de acá.
        tools: enabledTools(JOB_SEARCH, JOB_TOOLS),
        screen: toView(deps.screen, deps.kitReady),
        // La que quedó abierta esperando al usuario. Sin esto el agente preguntaba
        // "¿de cuál vacante me hablás?" con una sola abierta. Ver `open-application.ts`.
        openApplication: openApplicationForAgent(),
        /*
         * El perfil. Sin esto preguntaba el nivel de inglés teniéndolo en el JSON.
         *
         * `null` si el workspace no está listo: el agente puede seguir buscando y
         * puntuando sin perfil, solo que no puede contestar campos por su cuenta.
         */
        profile: await loadProfile().catch(() => null),
        message: text
      },
      (prompt) => llm.provider.run(prompt, llm.model),
      (tool, args) => runTool(tool, args, deps),
      {
        onSay: (t) => emit('say', t),
        onTool: (tool) => emit('tool', tool)
      }
    )

    return { screen: await withKit(deps.screen), turns: turns.length }
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
        // Se nombra la CARPETA, no una variable de entorno: ya no hay ninguna que
        // configurar, y mandar a editar un `.env` era mandar a tocar el repo.
        missing: ['el perfil del agente (albus-profile.json)', ...missing]
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

    const search = resolveSearch(req.queries, req.location)

    const win = mainWindow()
    const report = await hunt({
      queries: search.queries,
      location: search.location,
      avoid: search.avoid,
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
      skipped: report.skipped,
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
