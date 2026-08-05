export const IpcChannels = {
  EXTRACTION_RUN: 'extraction:run',
  EXTRACTION_LIST: 'extraction:list',
  EXTRACTION_RESET: 'extraction:reset',
  CLI_LIST: 'cli:list',
  CLI_REFRESH: 'cli:refresh',
  GRAPH_BUILD: 'graph:build',
  GRAPH_LOAD: 'graph:load',
  GRAPH_REVEAL: 'graph:reveal',
  TASKS_LIST: 'tasks:list',
  TASKS_ASK: 'tasks:ask',
  TASKS_CLOSE: 'tasks:close',
  TASKS_DETAIL: 'tasks:detail',
  OPEN_EXTERNAL: 'shell:open-external'
} as const

/** Eventos que el main empuja al renderer mientras corre un lote. */
export const IpcEvents = {
  ITEM_START: 'extraction:item-start',
  ITEM_DONE: 'extraction:item-done',
  GRAPH_PROGRESS: 'graph:progress'
} as const

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

export type ExtractionKind =
  | 'qr'
  | 'receipt'
  | 'profile'
  | 'document'
  | 'text'
  | 'none'
  | 'failed'

export interface ResultRow {
  id: string
  label: string
  kind: ExtractionKind
  summary: string
  confidence: number
}

export interface ItemStartEvent {
  id: string
  label: string
  index: number
  total: number
}

export interface BatchSummary {
  processed: number
  failed: number
  byKind: Record<string, number>
}

export interface CliModel {
  id: string
  label: string
}

export type DiscoveryMethod = 'seed' | 'listed' | 'probed' | 'cached'

export interface CliProviderInfo {
  id: string
  name: string
  models: CliModel[]
  /** Cómo se supo qué modelos hay. */
  method: DiscoveryMethod
  checkedAt: string
  cliVersion: string
}

/** Qué CLI usar para el escalón 4. null = no escalar, solo lo gratis. */
export interface LlmChoice {
  providerId: string | null
  modelId: string | null
}

export type GraphNodeType =
  | 'person' | 'company' | 'event' | 'payment'
  | 'entity' | 'topic' | 'url' | 'note'

export type Provenance = 'EXTRACTED' | 'INFERRED'

export interface GraphNode {
  id: string
  type: GraphNodeType
  label: string
  provenance: Provenance
  attrs: Record<string, string>
  sources: string[]
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  label: string
  provenance: Provenance
  sources: string[]
}

export interface Graph {
  version: 1
  generatedAt: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: { nodes: number; edges: number; extracted: number; inferred: number }
}

export interface GraphState {
  graph: Graph | null
  path: string
}

// ---------------------------------------------------------------------------
// Pendientes
// ---------------------------------------------------------------------------

export type TaskStatus = 'open' | 'done' | 'dismissed'

export interface TaskRow {
  id: string
  title: string
  detail: string | null
  status: TaskStatus
  /** 'regla:qr' | 'cli:<modelo>'. La UI distingue regla de inferencia. */
  source: string
  confidence: number
  createdAt: string
}

/**
 * Respuesta del chat. `tasks` viene aparte del texto para que la UI las pinte
 * como tarjetas con botón de cerrar, no como un párrafo que hay que releer.
 */
export interface AskAnswer {
  text: string
  tasks: TaskRow[]
  /** Qué entendió. Sirve para no adivinar en silencio cuando no entendió nada. */
  intent: 'pendientes' | 'cerrar' | 'ambiguo' | 'ayuda'
}

/** De dónde salió un pendiente: una de las capturas de su nota. */
export interface TaskSource {
  kind: ExtractionKind
  /** Texto COMPLETO del OCR, sin recortar. El recorte es cosa de la UI. */
  text: string | null
  /** Link para abrir la imagen original en Drive. El OCR pierde cosas; la foto no. */
  driveLink: string | null
  driveFolder: string | null
}

export interface TaskDetail {
  task: TaskRow
  /** Lo que escribiste al capturar. Suele ser la mejor pista de qué es esto. */
  noteBody: string
  sources: TaskSource[]
}
