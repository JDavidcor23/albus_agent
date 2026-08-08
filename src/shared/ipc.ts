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
  OPEN_EXTERNAL: 'shell:open-external',
  /**
   * Copiar al portapapeles va por el main, igual que abrir un link.
   *
   * `navigator.clipboard` existe en el renderer, pero depende de que el contexto
   * sea seguro y empaquetada la app corre en `file://`. El módulo `clipboard` de
   * Electron no tiene esa duda. Y el criterio ya estaba establecido acá: las
   * capacidades del sistema las tiene el main.
   */
  CLIPBOARD_WRITE: 'clipboard:write',
  /**
   * Postulación laboral. Existen ya aunque la UI todavía no los use: el módulo
   * corre headless desde el main, y cuando llegue la pantalla no hay que tocar
   * el dominio, solo pintar.
   */
  AGENTS_LIST: 'agents:list',
  AGENTS_RULES_OPEN: 'agents:rules-open',
  AGENTS_ANSWER: 'agents:answer',
  CONNECTIONS_LIST: 'connections:list',
  CONNECTIONS_BROWSER: 'connections:browser',
  CONNECTIONS_TOKEN: 'connections:token',
  CONNECTIONS_OPEN: 'connections:open',
  CONNECTIONS_CLEAR: 'connections:clear',
  JOBS_STATUS: 'jobs:status',
  JOBS_CHAT: 'jobs:chat',
  JOBS_LOGIN: 'jobs:login',
  JOBS_HUNT: 'jobs:hunt',
  JOBS_KIT: 'jobs:kit',
  JOBS_APPLY: 'jobs:apply',
  JOBS_EMAIL: 'jobs:email',
  JOBS_CONFIRM: 'jobs:confirm'
} as const

/** Eventos que el main empuja al renderer mientras corre un lote. */
export const IpcEvents = {
  ITEM_START: 'extraction:item-start',
  ITEM_DONE: 'extraction:item-done',
  GRAPH_PROGRESS: 'graph:progress',
  JOBS_STEP: 'jobs:step',
  JOBS_HUNT_PROGRESS: 'jobs:hunt-progress',
  JOBS_KIT_PROGRESS: 'jobs:kit-progress',
  /**
   * Cada paso de una conexión por navegador, EN VIVO.
   *
   * Existe porque `connections:browser` es un `invoke`: no contesta hasta que
   * termina, y conectar Notion puede tardar minutos. Sin este canal la UI se
   * queda muda todo ese rato y el usuario no distingue "está trabajando" de
   * "se colgó" — que fue exactamente lo que pasó.
   */
  CONNECTIONS_STEP: 'connections:step'
} as const

/** Un paso de una conexión, tal como lo ve el usuario mientras pasa. */
export interface ConnectionStepRow {
  /** Qué servicio se está conectando. */
  id: string
  paso: string
  ok: boolean
  detalle: string
  /** Ruta absoluta del PNG de cómo se veía la pantalla en ese momento. */
  captura?: string
}

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
  /**
   * De esas, cuántas son FOTOS de cámara y no capturas de pantalla.
   *
   * Su OCR no viaja: sobre los datos reales las fotos conservan 17% del texto
   * contra 84% de las capturas, y ese 17% son fragmentos inventados.
   */
  photos: number
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

/**
 * Dominios cuyos subdominios TODOS valen.
 *
 * LinkedIn sirve la misma vacante desde `co.`, `es.`, `uk.`, `www.`… según de
 * dónde mires, y el scraper devuelve el regional. Con la lista exacta el botón
 * "ver la vacante" fallaba con "host no permitido" en cada resultado real.
 *
 * El chequeo es por SUFIJO DE ETIQUETA (`.linkedin.com`), nunca `endsWith`
 * pelado: `linkedin.com.malicioso.com` termina en "malicioso.com" pero
 * `evil-linkedin.com` terminaría en "linkedin.com" y pasaría un endsWith
 * ingenuo. Hay un assert para ese caso exacto.
 */
export const DOMINIOS_ABRIBLES: readonly string[] = ['linkedin.com', 'meetup.com']

function hostBajoDominio(host: string, dominio: string): boolean {
  return host === dominio || host.endsWith(`.${dominio}`)
}

// ── postulación laboral ────────────────────────────────────────────────────

export type JobApplyMode = 'dry-run' | 'review' | 'auto'

export interface JobsStatus {
  /** ¿Está configurado `JOB_WORKSPACE_DIR` y existe el perfil? */
  workspaceReady: boolean
  workspaceError: string | null
  /** ¿Hay cookie de LinkedIn guardada en la partición de Albus? */
  linkedInSession: boolean
  /** Nombre con que se subiría el CV. Lo que ve el reclutador. */
  cvUploadName: string
  /** ¿Hay NOTION_TOKEN? Sin esto el tablero no se actualiza. */
  notionReady: boolean
  /** ¿El token de Google alcanza para mandar correos? */
  gmailReady: boolean
  /** Qué correr para arreglar lo que falte. Vacío = está todo. */
  faltantes: string[]
}

// ── búsqueda y triage ──────────────────────────────────────────────────────

export interface RankedJobRow {
  id: string
  title: string
  company: string
  location: string
  date: string
  url: string
  score: number
  gates: string[]
  reason: string
  angle: string
  /** La descripción de la vacante. Se lee en la tarjeta, no hay que salir. */
  description: string
  /** ¿Hay PDF compilado en el workspace para postularse ya? */
  kitReady: boolean
  slug: string
}

/** Lo mínimo que el router necesita para resolver "la primera". */
export interface ChatVacante {
  id: string
  company: string
  title: string
  score: number
}

/**
 * Lo que el usuario quiso decir. Lo resuelve `core/jobs/chat.ts`, que es puro.
 *
 * Vive en el main y no en el renderer porque el dominio es del main — y porque
 * el día que un comando necesite mirar el estado real (qué quedó frenado, qué
 * ya se envió) va a poder hacerlo sin mover nada de lugar.
 */
export type ChatIntent =
  | { kind: 'buscar'; queries: string[]; ubicacion: string | null }
  | { kind: 'postular'; id: string }
  | { kind: 'mostrar'; id: string }
  | { kind: 'enviar'; id: string }
  | { kind: 'descartar'; id: string }
  | { kind: 'ambiguo'; candidatas: ChatVacante[]; termino: string }
  | { kind: 'conversar'; texto: string }
  | { kind: 'ayuda' }

export interface HuntResult {
  encontradas: number
  repetidas: number
  rankeadas: number
  califican: RankedJobRow[]
  descartadas: RankedJobRow[]
  notionEscritas: number
  notionError: string | null
  resumen: string
}

export interface HuntProgress {
  fase: string
  detalle: string
}

export interface KitResultRow {
  ok: boolean
  cv: string | null
  cover: string | null
  mensaje: string
}

export interface EmailApplyResult {
  status: 'draft' | 'sent' | 'blocked' | 'failed'
  to: string[]
  subject: string
  attachedAs: { filename: string; size: number }[]
  message: string
  notionError: string | null
}

// ── el contenedor de agentes ───────────────────────────────────────────────

/**
 * Albus es un contenedor de agentes, no una app de una sola cosa. El registro
 * vive en `shared` porque los dos lados lo necesitan: el renderer para pintar
 * la lista, y el main para saber qué está realmente disponible.
 *
 * Agregar un agente nuevo es una entrada acá y un componente. Nada más.
 */
/**
 * Una conexión a un servicio externo, con las vías disponibles para darla de
 * alta. `origen` dice de dónde salió la credencial para que no haya sorpresas:
 * "está en el .env" y "la pegaste en la app" se resuelven distinto.
 */
export interface ConnectionInfo {
  id: string
  /**
   * Los que comparten cuenta se pintan en una sola tarjeta.
   *
   * Google salía dos veces —token de API y sesión de navegador— y para el
   * usuario eso es una cuenta con dos permisos. Sin grupo, cae en el suyo.
   */
  grupo: string
  /** Qué aporta ESTA entrada dentro del grupo. Vacío si el grupo es de una. */
  capacidad: string
  nombre: string
  paraQue: string
  vias: ('navegador' | 'token')[]
  dondeSacarlo: string
  conectado: boolean
  /**
   * `yml` = `albus.yml`, el archivo que el usuario puede abrir y editar.
   * `app` = lo cifrado de antes (legado). `env` = una variable de entorno.
   */
  origen: 'yml' | 'app' | 'env' | 'ninguno'
  detalle: string
  /**
   * ¿El sistema operativo ofrece cifrado de credenciales?
   *
   * Ya no decide si se guarda o no —eso ahora va a `albus.yml` siempre—, pero
   * se sigue informando: es la diferencia entre "tu token está atado a tu
   * cuenta de Windows" y "está en un archivo de texto". El usuario tiene
   * derecho a saber cuál de las dos es.
   */
  cifradoDisponible: boolean
}

export interface AgentInfo {
  id: string
  nombre: string
  descripcion: string
  /** `false` = se pinta apagado con el motivo, no se esconde. */
  disponible: boolean
  motivo: string
  reglas: AgentRulesInfo
}

/** Una referencia que el usuario enlazó en su `.md` de reglas. */
export interface RuleRef {
  id: string
  /** Lo que escribió al lado del link. Un hash de 32 no le dice nada a nadie. */
  etiqueta: string
}

/**
 * El estado del `.md` de reglas del agente.
 *
 * `existe` y las listas van separadas a propósito: un archivo creado con la
 * plantilla sin tocar existe pero no apunta a nada, y esa es exactamente la
 * diferencia entre que el agente ande y que no.
 */
/**
 * Una duda del agente esperando respuesta.
 *
 * Existe porque el usuario nunca va a escribir todas las reglas de antemano, y
 * las dudas aparecen cuando él no está. El agente no inventa: pregunta, sigue
 * con lo que sí puede, y la respuesta se anexa al `.md` como una regla nueva.
 */
export interface AgentQuestion {
  id: string
  pregunta: string
  /** Dónde apareció: la vacante, el campo. Sin esto es incontestable después. */
  contexto: string
  creada: string
  /** Sugerencias del agente. No obligan: se puede escribir cualquier cosa. */
  opciones: string[]
}

export interface AgentRulesInfo {
  soporta: boolean
  existe: boolean
  ruta: string
  /** Lo que el agente preguntó y sigue sin respuesta. */
  preguntas: AgentQuestion[]
  /**
   * Las reglas que el usuario escribió, en sus palabras.
   *
   * Es lo que se muestra. Antes se listaban los links parseados —"Notion ·
   * Registro de aplicaciones"— y eso no le dice nada a nadie: una regla es
   * "si me postulo, guardá el CV en esta carpeta", no un inventario de
   * integraciones.
   */
  resumen: string[]
  notion: RuleRef[]
  drive: RuleRef[]
}

export interface JobApplyStepRow {
  index: number
  url: string
  filled: number
  unresolved: string[]
  screenshot: string | null
  action: string
}

export interface JobApplyResult {
  notionError: string | null
  notionPageId: string | null
  status: 'planned' | 'filled' | 'submitted' | 'needs-login' | 'blocked' | 'failed'
  mode: JobApplyMode
  message: string
  steps: JobApplyStepRow[]
  /** Etiquetas de los campos que quedaron sin responder. Se muestran, no se ocultan. */
  unresolved: string[]
  uploadedAs: string[]
  cvFound: string | null
  coverFound: string | null
  trackerWritten: boolean
  windowLeftOpen: boolean
}

/**
 * Hosts a los que Albus puede navegar para postularse. Es una allowlist por la
 * misma razón que la de `openExternal`: la URL viene de afuera y abrir un
 * navegador con la sesión del usuario adentro no es una operación inocente.
 */
export const HOSTS_POSTULABLES: readonly string[] = [
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'jobs.lever.co',
  'apply.workable.com',
  'jobs.ashbyhq.com',
  'www.freehire.io',
  'freehire.io'
]

/**
 * Mismo criterio de subdominio que los abribles, y por el mismo motivo: la
 * vacante que el scraper devuelve como `co.linkedin.com` es la misma que
 * `www.linkedin.com` sirve, y enumerar los treinta países es garantizar que
 * falte el que aparezca mañana.
 */
export const DOMINIOS_POSTULABLES: readonly string[] = ['linkedin.com']

export function esUrlPostulable(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false

    const host = parsed.hostname.toLowerCase()
    if (HOSTS_POSTULABLES.includes(host)) return true
    return DOMINIOS_POSTULABLES.some((d) => hostBajoDominio(host, d))
  } catch {
    return false
  }
}

export function esUrlAbrible(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false

    const host = parsed.hostname.toLowerCase()
    if (HOSTS_ABRIBLES.includes(host)) return true
    if (DOMINIOS_ABRIBLES.some((d) => hostBajoDominio(host, d))) return true

    // Invariante: todo lo POSTULABLE es abrible. Si Albus puede navegar ahí con
    // tu sesión adentro, abrirlo en tu navegador es estrictamente menos
    // riesgoso. Se deriva en vez de duplicarse en las dos listas, que era la
    // forma garantizada de que se desincronicen — y ya pasó: el scraper devuelve
    // Greenhouse y Lever, y "ver la vacante" habría fallado igual que con
    // `co.linkedin.com`.
    return esUrlPostulable(url)
  } catch {
    return false
  }
}
