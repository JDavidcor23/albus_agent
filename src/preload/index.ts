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
  type ChatVacante,
  type ConnectionInfo,
  type ConnectionStepRow,
  type EmailApplyResult,
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
  type TaskRow
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
  ): Promise<IpcResult<{ graph: Graph; path: string; lotesFallidos: number }>> =>
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

  onGraphProgress: (cb: (p: { hechos: number; total: number }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { hechos: number; total: number }): void => cb(payload)
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
  openAgentRules: (id: string): Promise<IpcResult<{ ruta: string }>> =>
    ipcRenderer.invoke(IpcChannels.AGENTS_RULES_OPEN, { id }),

  /** Responder una duda del agente. La respuesta se vuelve una regla suya. */
  answerAgentQuestion: (
    id: string,
    preguntaId: string,
    respuesta: string
  ): Promise<IpcResult<{ ok: boolean; agentes: AgentInfo[] }>> =>
    ipcRenderer.invoke(IpcChannels.AGENTS_ANSWER, { id, preguntaId, respuesta }),

  listConnections: (): Promise<IpcResult<ConnectionInfo[]>> =>
    ipcRenderer.invoke(IpcChannels.CONNECTIONS_LIST),

  connectWithBrowser: (
    id: string
  ): Promise<IpcResult<{ ok: boolean; mensaje: string; conexiones: ConnectionInfo[] }>> =>
    ipcRenderer.invoke(IpcChannels.CONNECTIONS_BROWSER, { id }),

  /**
   * Los pasos de una conexión, en vivo.
   *
   * `connectWithBrowser` no resuelve hasta que todo terminó, y eso puede tardar
   * minutos. Sin esto la pantalla se queda muda y no se distingue "trabajando"
   * de "colgado".
   */
  onConnectionStep: (cb: (paso: ConnectionStepRow) => void): (() => void) => {
    const handler = (_e: unknown, payload: ConnectionStepRow): void => cb(payload)
    ipcRenderer.on(IpcEvents.CONNECTIONS_STEP, handler)
    return () => ipcRenderer.removeListener(IpcEvents.CONNECTIONS_STEP, handler)
  },

  connectWithToken: (
    id: string,
    token: string
  ): Promise<IpcResult<{ ok: boolean; mensaje: string; conexiones: ConnectionInfo[] }>> =>
    ipcRenderer.invoke(IpcChannels.CONNECTIONS_TOKEN, { id, token }),

  openTokenPage: (id: string): Promise<IpcResult<{ abierto: boolean }>> =>
    ipcRenderer.invoke(IpcChannels.CONNECTIONS_OPEN, { id }),

  disconnect: (
    id: string
  ): Promise<IpcResult<{ ok: boolean; conexiones: ConnectionInfo[] }>> =>
    ipcRenderer.invoke(IpcChannels.CONNECTIONS_CLEAR, { id }),

  jobsStatus: (): Promise<IpcResult<JobsStatus>> => ipcRenderer.invoke(IpcChannels.JOBS_STATUS),

  jobsHunt: (req: {
    queries: string[]
    location: string
    /** No hay `jobAgeDays`: el rango lo decide y lo amplía el main. */
    maxRank: number
    guardarEnNotion: boolean
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
  jobsChat: (req: {
    texto: string
    vacantes: ChatVacante[]
  }): Promise<IpcResult<ChatIntent>> => ipcRenderer.invoke(IpcChannels.JOBS_CHAT, req),

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

  onKitProgress: (cb: (p: { id: string; linea: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { id: string; linea: string }): void => cb(payload)
    ipcRenderer.on(IpcEvents.JOBS_KIT_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IpcEvents.JOBS_KIT_PROGRESS, handler)
  },

  onJobStep: (cb: (step: JobApplyStepRow) => void): (() => void) => {
    const handler = (_e: unknown, payload: JobApplyStepRow): void => cb(payload)
    ipcRenderer.on(IpcEvents.JOBS_STEP, handler)
    return () => ipcRenderer.removeListener(IpcEvents.JOBS_STEP, handler)
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
