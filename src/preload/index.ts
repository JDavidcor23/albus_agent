import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  IpcChannels,
  IpcEvents,
  type BatchSummary,
  type IpcResult,
  type CliProviderInfo,
  type AskAnswer,
  type Graph,
  type GraphState,
  type AgentInfo,
  type ChatIntent,
  type AgentResult,
  type AgentStep,
  type RankedJobRow,
  type ChatJob,
  type ConnectionInfo,
  type ConnectionStepRow,
  type EmailApplyResult,
  type HubAgentEvent,
  type HubInstallReport,
  type HubInstallStep,
  type HubResultFile,
  type HubRunSummary,
  type HuntProgress,
  type HuntResult,
  type ItemStartEvent,
  type JobApplyMode,
  type JobApplyResult,
  type JobApplyStepRow,
  type JobsStatus,
  type KitResultRow,
  type ResultRow,
  type TaskDetail,
  type TaskRow,
  type TranscriptEntry,
  type VideoRunSummary,
  type VideoStepEvent
} from '../shared/ipc'

const api = {
  listCliProviders: (): Promise<IpcResult<CliProviderInfo[]>> =>
    ipcRenderer.invoke(IpcChannels.CLI_LIST),

  refreshCliProviders: (): Promise<IpcResult<CliProviderInfo[]>> =>
    ipcRenderer.invoke(IpcChannels.CLI_REFRESH),

  runExtraction: (opts?: {
    limit?: number
    providerId?: string | null
    modelId?: string | null
  }): Promise<IpcResult<BatchSummary>> => ipcRenderer.invoke(IpcChannels.EXTRACTION_RUN, opts ?? {}),

  listResults: (): Promise<IpcResult<ResultRow[]>> =>
    ipcRenderer.invoke(IpcChannels.EXTRACTION_LIST),

  resetResults: (): Promise<IpcResult<{ deleted: number }>> =>
    ipcRenderer.invoke(IpcChannels.EXTRACTION_RESET),

  loadGraph: (): Promise<IpcResult<GraphState>> => ipcRenderer.invoke(IpcChannels.GRAPH_LOAD),

  buildGraph: (
    providerId: string,
    modelId: string | null
  ): Promise<IpcResult<{ graph: Graph; path: string; failedBatches: number }>> =>
    ipcRenderer.invoke(IpcChannels.GRAPH_BUILD, { providerId, modelId }),

  revealGraph: (): Promise<IpcResult<{ path: string }>> =>
    ipcRenderer.invoke(IpcChannels.GRAPH_REVEAL),

  listTasks: (): Promise<IpcResult<TaskRow[]>> => ipcRenderer.invoke(IpcChannels.TASKS_LIST),

  askTasks: (message: string): Promise<IpcResult<AskAnswer>> =>
    ipcRenderer.invoke(IpcChannels.TASKS_ASK, { message }),

  closeTask: (id: string, status: 'done' | 'dismissed'): Promise<IpcResult<TaskRow[]>> =>
    ipcRenderer.invoke(IpcChannels.TASKS_CLOSE, { id, status }),

  taskDetail: (id: string): Promise<IpcResult<TaskDetail>> =>
    ipcRenderer.invoke(IpcChannels.TASKS_DETAIL, { id }),

  openExternal: (url: string): Promise<IpcResult<{ opened: boolean }>> =>
    ipcRenderer.invoke(IpcChannels.OPEN_EXTERNAL, { url }),

  copyToClipboard: (text: string): Promise<IpcResult<{ copied: boolean }>> =>
    ipcRenderer.invoke(IpcChannels.CLIPBOARD_WRITE, { text }),

  onGraphProgress: (cb: (p: { done: number; total: number }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { done: number; total: number }): void => cb(payload)
    ipcRenderer.on(IpcEvents.GRAPH_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IpcEvents.GRAPH_PROGRESS, handler)
  },

  /** Devuelven la función para desuscribirse; sin eso el StrictMode duplica handlers. */
  onItemStart: (cb: (e: ItemStartEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: ItemStartEvent): void => cb(payload)
    ipcRenderer.on(IpcEvents.ITEM_START, handler)
    return () => ipcRenderer.removeListener(IpcEvents.ITEM_START, handler)
  },

  onItemDone: (cb: (row: ResultRow) => void): (() => void) => {
    const handler = (_e: unknown, payload: ResultRow): void => cb(payload)
    ipcRenderer.on(IpcEvents.ITEM_DONE, handler)
    return () => ipcRenderer.removeListener(IpcEvents.ITEM_DONE, handler)
  },

  // ── postulación laboral ──────────────────────────────────────────────────
  // Expuesto desde ya aunque la UI todavía no lo llame: el contrato es lo que
  // tarda en discutirse, no el componente que lo consume.

  listAgents: (): Promise<IpcResult<AgentInfo[]>> => ipcRenderer.invoke(IpcChannels.AGENTS_LIST),

  // ── conexiones ───────────────────────────────────────────────────────────
  // El token viaja de acá al main y nunca vuelve: la UI sabe SI hay, no cuál.

  /**
   * Abre el `.md` de reglas del agente en el editor del sistema.
   *
   * Se abre el archivo y no una pantalla de configuración porque agregar una
   * regla nueva tiene que ser escribir una línea, no construir un formulario.
   */
  openAgentRules: (id: string): Promise<IpcResult<{ path: string }>> =>
    ipcRenderer.invoke(IpcChannels.AGENTS_RULES_OPEN, { id }),

  /** Responder una duda del agente. La respuesta se vuelve una regla suya. */
  answerAgentQuestion: (
    id: string,
    questionId: string,
    answer: string
  ): Promise<IpcResult<{ ok: boolean; agents: AgentInfo[] }>> =>
    ipcRenderer.invoke(IpcChannels.AGENTS_ANSWER, { id, questionId, answer }),

  listConnections: (): Promise<IpcResult<ConnectionInfo[]>> =>
    ipcRenderer.invoke(IpcChannels.CONNECTIONS_LIST),

  connectWithBrowser: (
    id: string
  ): Promise<IpcResult<{ ok: boolean; message: string; connections: ConnectionInfo[] }>> =>
    ipcRenderer.invoke(IpcChannels.CONNECTIONS_BROWSER, { id }),

  /**
   * Los pasos de una conexión, en vivo.
   *
   * `connectWithBrowser` no resuelve hasta que todo terminó, y eso puede tardar
   * minutos. Sin esto la pantalla se queda muda y no se distingue "trabajando"
   * de "colgado".
   */
  onConnectionStep: (cb: (step: ConnectionStepRow) => void): (() => void) => {
    const handler = (_e: unknown, payload: ConnectionStepRow): void => cb(payload)
    ipcRenderer.on(IpcEvents.CONNECTIONS_STEP, handler)
    return () => ipcRenderer.removeListener(IpcEvents.CONNECTIONS_STEP, handler)
  },

  connectWithToken: (
    id: string,
    token: string
  ): Promise<IpcResult<{ ok: boolean; message: string; connections: ConnectionInfo[] }>> =>
    ipcRenderer.invoke(IpcChannels.CONNECTIONS_TOKEN, { id, token }),

  openTokenPage: (id: string): Promise<IpcResult<{ opened: boolean }>> =>
    ipcRenderer.invoke(IpcChannels.CONNECTIONS_OPEN, { id }),

  disconnect: (
    id: string
  ): Promise<IpcResult<{ ok: boolean; connections: ConnectionInfo[] }>> =>
    ipcRenderer.invoke(IpcChannels.CONNECTIONS_CLEAR, { id }),

  jobsStatus: (): Promise<IpcResult<JobsStatus>> => ipcRenderer.invoke(IpcChannels.JOBS_STATUS),

  jobsHunt: (req: {
    /** Vacío es VÁLIDO y significa "usá mis reglas". Lo resuelve el main. */
    queries: string[]
    /** Vacío = la de las reglas, y si tampoco está, Colombia. */
    location: string
    /** No hay `jobAgeDays`: el rango lo decide y lo amplía el main. */
    /** Opcional: sin esto manda el techo del main. No es una cuota a repartir. */
    maxRank?: number
    saveToNotion: boolean
    providerId: string
    modelId: string | null
  }): Promise<IpcResult<HuntResult>> => ipcRenderer.invoke(IpcChannels.JOBS_HUNT, req),

  jobsEmail: (req: {
    to: string
    cc?: string[]
    company: string
    role: string
    slug?: string
    subject?: string
    body?: string
    mode?: JobApplyMode
    postUrl?: string
    fitRating?: string
    jobDescription?: string
  }): Promise<IpcResult<EmailApplyResult>> => ipcRenderer.invoke(IpcChannels.JOBS_EMAIL, req),

  onHuntProgress: (cb: (p: HuntProgress) => void): (() => void) => {
    const handler = (_e: unknown, payload: HuntProgress): void => cb(payload)
    ipcRenderer.on(IpcEvents.JOBS_HUNT_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IpcEvents.JOBS_HUNT_PROGRESS, handler)
  },

  /** Interpretar lo que el usuario le escribió al agente. Puro, sin cuota. */
  /** Lo que quedó pendiente en Notion. No busca ni puntúa: solo lee. */
  jobsBacklog: (): Promise<IpcResult<RankedJobRow[]>> =>
    ipcRenderer.invoke(IpcChannels.JOBS_BACKLOG),

  /**
   * Hablarle al agente. Él decide qué hacer y lo hace.
   *
   * `jobs.screen` va COMPLETO —con url y descripción— porque las herramientas
   * postulan de verdad. Las claves de acá tienen que coincidir con `AgentSchema`
   * del main: `typecheck` no cruza el IPC, y un `{jobs:[...]}` contra un schema
   * que espera `{jobs:{screen:[...]}}` compila limpio y falla recién al enviar.
   */
  jobsAgent: (req: {
    text: string
    jobs: { screen: RankedJobRow[]; providerId: string; modelId: string | null }
  }): Promise<IpcResult<AgentResult>> => ipcRenderer.invoke(IpcChannels.JOBS_AGENT, req),

  /** Lo que el agente dice y hace mientras trabaja. Devuelve el `off`. */
  onAgentStep: (cb: (step: AgentStep) => void): (() => void) => {
    const listener = (_e: unknown, step: AgentStep): void => cb(step)
    ipcRenderer.on(IpcEvents.JOBS_AGENT_STEP, listener)
    return () => ipcRenderer.removeListener(IpcEvents.JOBS_AGENT_STEP, listener)
  },

  jobsChat: (req: { text: string; jobs: ChatJob[] }): Promise<IpcResult<ChatIntent>> =>
    ipcRenderer.invoke(IpcChannels.JOBS_CHAT, req),

  jobsLogin: (): Promise<IpcResult<{ linkedInSession: boolean }>> =>
    ipcRenderer.invoke(IpcChannels.JOBS_LOGIN),

  jobsApply: (req: {
    url: string
    company: string
    role: string
    slug?: string
    mode?: JobApplyMode
    sector?: string
    fitRating?: string
    jobDescription?: string
    providerId?: string | null
    modelId?: string | null
  }): Promise<IpcResult<JobApplyResult>> => ipcRenderer.invoke(IpcChannels.JOBS_APPLY, req),

  jobsConfirm: (row: {
    url: string
    company: string
    role: string
    sector?: string
    fitRating?: string
    notes?: string
    cvFile?: string
    coverLetterFile?: string
  }): Promise<IpcResult<{ logged: boolean }>> =>
    ipcRenderer.invoke(IpcChannels.JOBS_CONFIRM, row),

  jobsKit: (req: {
    id?: string
    url: string
    company: string
    role: string
    slug?: string
  }): Promise<IpcResult<KitResultRow>> => ipcRenderer.invoke(IpcChannels.JOBS_KIT, req),

  onKitProgress: (cb: (p: { id: string; line: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { id: string; line: string }): void => cb(payload)
    ipcRenderer.on(IpcEvents.JOBS_KIT_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IpcEvents.JOBS_KIT_PROGRESS, handler)
  },

  onJobStep: (cb: (step: JobApplyStepRow) => void): (() => void) => {
    const handler = (_e: unknown, payload: JobApplyStepRow): void => cb(payload)
    ipcRenderer.on(IpcEvents.JOBS_STEP, handler)
    return () => ipcRenderer.removeListener(IpcEvents.JOBS_STEP, handler)
  },

  // ── extracción de video ──────────────────────────────────────────────────

  /** Abre el diálogo nativo. `path: null` = el usuario canceló, no es un error. */
  pickVideo: (): Promise<IpcResult<{ path: string | null }>> =>
    ipcRenderer.invoke(IpcChannels.VIDEO_PICK),

  runVideo: (req: {
    path: string
    model?: 'tiny' | 'base' | 'small' | 'medium'
    language?: string
    silenceDb?: number
    title?: string
  }): Promise<IpcResult<VideoRunSummary>> => ipcRenderer.invoke(IpcChannels.VIDEO_RUN, req),

  /** Abre la página o la carpeta. El main verifica que caiga dentro de su salida. */
  openVideoOutput: (path: string): Promise<IpcResult<{ path: string }>> =>
    ipcRenderer.invoke(IpcChannels.VIDEO_OPEN, { path }),

  /** Todos los transcripts guardados, del más nuevo al más viejo. */
  listTranscripts: (): Promise<IpcResult<{ transcripts: TranscriptEntry[] }>> =>
    ipcRenderer.invoke(IpcChannels.VIDEO_LIST),

  /**
   * Le pone nombre a un transcript. Devuelve la fila ya actualizada para que la
   * UI no tenga que volver a listar la biblioteca entera por un título.
   */
  renameTranscript: (
    id: string,
    title: string
  ): Promise<IpcResult<{ transcript: TranscriptEntry }>> =>
    ipcRenderer.invoke(IpcChannels.VIDEO_RENAME, { id, title }),

  onVideoStep: (cb: (step: VideoStepEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: VideoStepEvent): void => cb(payload)
    ipcRenderer.on(IpcEvents.VIDEO_STEP, handler)
    return () => ipcRenderer.removeListener(IpcEvents.VIDEO_STEP, handler)
  },

  // ── agents hub: discover, run, install and open external agents ─────────
  // `listAgents()` already returns these mixed in with the builtin ones
  // (`origin: 'external'`); what follows is specific to running and managing
  // the hub's own code and results. See `.claude/docs/agents-hub.md`.

  runHubAgent: (agentId: string, command = 'run'): Promise<IpcResult<HubRunSummary>> =>
    ipcRenderer.invoke(IpcChannels.HUB_RUN, { agentId, command }),

  cancelHubAgent: (agentId: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke(IpcChannels.HUB_CANCEL, { agentId }),

  listHubResults: (agentId: string): Promise<IpcResult<HubResultFile[]>> =>
    ipcRenderer.invoke(IpcChannels.HUB_RESULTS, { agentId }),

  /**
   * Opens the agent's own code folder, its results folder, or one file
   * inside the results folder (`relPath`, required for `target: 'file'`).
   * The main process re-checks that a `file` target falls inside the
   * results folder — it never trusts a path the renderer hands back.
   */
  openHubPath: (
    agentId: string,
    target: 'code' | 'results' | 'file',
    relPath?: string
  ): Promise<IpcResult<{ opened: boolean }>> =>
    ipcRenderer.invoke(IpcChannels.HUB_OPEN, { agentId, target, relPath }),

  /** `link: true` installs as a filesystem junction instead of copying/cloning. */
  installHubAgent: (source: string, link: boolean): Promise<IpcResult<HubInstallReport>> =>
    ipcRenderer.invoke(IpcChannels.HUB_INSTALL, { source, link }),

  /** Native folder picker, for choosing a local agent folder to install. `null` = cancelled. */
  pickHubAgentFolder: (): Promise<IpcResult<string | null>> =>
    ipcRenderer.invoke(IpcChannels.HUB_PICK_FOLDER),

  /** Opens `agents-hub/` itself in the system file explorer. */
  openAgentsHub: (): Promise<IpcResult<{ opened: boolean }>> =>
    ipcRenderer.invoke(IpcChannels.HUB_OPEN_HUB),

  /** One line of a hub agent's run, live. `hub:run` does not resolve until the agent finishes. */
  onHubEvent: (cb: (payload: { agentId: string; event: HubAgentEvent }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { agentId: string; event: HubAgentEvent }): void => cb(payload)
    ipcRenderer.on(IpcEvents.HUB_EVENT, handler)
    return () => ipcRenderer.removeListener(IpcEvents.HUB_EVENT, handler)
  },

  /** One step of `hub:install`, live — cloning or `npm install` can take minutes. */
  onHubInstallStep: (cb: (step: HubInstallStep) => void): (() => void) => {
    const handler = (_e: unknown, payload: HubInstallStep): void => cb(payload)
    ipcRenderer.on(IpcEvents.HUB_INSTALL_STEP, handler)
    return () => ipcRenderer.removeListener(IpcEvents.HUB_INSTALL_STEP, handler)
  }
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
