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
  /**
   * `yyyy-mm-dd`, o `null`. HOY solo alimenta el botón de Calendar.
   *
   * NO ordena la lista y NO se muestra en la tarjeta: eso se probó, se revirtió,
   * y volver a meterlo es una decisión del usuario, no un efecto colateral de
   * tener el dato disponible.
   */
  dueDate: string | null
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

/**
 * De dónde salió un pendiente: las capturas de su nota, agrupadas POR TIPO.
 *
 * Agrupadas y no una por archivo. Tres fotos del mismo QR daban tres bloques
 * casi idénticos, que el usuario leyó como "tres links".
 */
export interface TaskSource {
  kind: ExtractionKind
  /** Cuántas capturas se fusionaron en este bloque. */
  captures: number
  /** Texto fusionado y limpio de chrome. `null` = el OCR no dejó nada legible. */
  text: string | null
  /** El crudo, para auditar detrás de un toggle. Nunca se muestra por defecto. */
  rawText: string | null
  /** Links a las originales en Drive. El OCR pierde cosas; la foto no. */
  driveLinks: string[]
}

/** Emails y links que estaban enterrados en el OCR, ya sin el mail del dueño. */
export interface TaskContacts {
  emails: string[]
  urls: string[]
}

export interface TaskDetail {
  task: TaskRow
  /** Lo que escribiste al capturar, completo. */
  noteBody: string
  /**
   * La misma nota en una o dos oraciones. `null` cuando no hacía falta o cuando
   * la nota nunca pasó por el modelo. La UI muestra esto primero y deja el body
   * detrás de un "ver todo".
   */
  noteSummary: string | null
  contacts: TaskContacts
  sources: TaskSource[]
}

/**
 * Hosts a los que se puede abrir el navegador del sistema.
 *
 * Vive en `shared` porque lo necesitan los DOS lados y por razones distintas: el
 * main lo aplica como frontera de seguridad al recibir un `openExternal`, y el
 * renderer lo consulta para no dibujar un botón que va a fallar. Duplicar la
 * lista era garantizar que se desincronicen.
 *
 * Allowlist de host y no "empieza con https": un `https://malicioso.com` pasaría
 * ese chequeo igual.
 */
export const HOSTS_ABRIBLES: readonly string[] = [
  'drive.google.com',
  'docs.google.com',
  // Para el botón de agendar. Es una allowlist, así que agregar un host es una
  // decisión consciente: abre el navegador del sistema con lo que le pasemos.
  // Acá el destino es el formulario de Google, y lo que viaja en la URL es el
  // título del pendiente — nada de lo que hay en la base.
  'calendar.google.com',
  'www.linkedin.com',
  'linkedin.com',
  'www.meetup.com',
  'meetup.com'
]

export function esUrlAbrible(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && HOSTS_ABRIBLES.includes(parsed.hostname)
  } catch {
    return false
  }
}
