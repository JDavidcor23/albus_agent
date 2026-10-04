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
  /** Le hablás al agente y él decide qué herramientas usar. Reemplaza a JOBS_CHAT. */
  JOBS_AGENT: 'jobs:agent',
  /**
   * Lo que quedó pendiente, sin buscar nada.
   *
   * Las vacantes que calificaron y todavía no resolviste viven en Notion. Sin
   * esto, la única forma de volver a verlas era disparar un barrido entero —
   * seis minutos de scraping y tokens para recuperar una lista que ya estaba
   * escrita.
   */
  JOBS_BACKLOG: 'jobs:backlog',
  JOBS_LOGIN: 'jobs:login',
  JOBS_HUNT: 'jobs:hunt',
  JOBS_KIT: 'jobs:kit',
  JOBS_APPLY: 'jobs:apply',
  JOBS_EMAIL: 'jobs:email',
  JOBS_CONFIRM: 'jobs:confirm',
  /**
   * El archivo lo elige el MAIN, no el renderer.
   *
   * Un `<input type=file>` en el renderer devuelve un `File`, no una ruta: para
   * mandarle 2,7 GB a ffmpeg habría que pasarlos por el IPC. El diálogo nativo
   * devuelve la ruta y ffmpeg lee del disco.
   */
  VIDEO_PICK: 'video:pick',
  VIDEO_RUN: 'video:run',
  VIDEO_OPEN: 'video:open',
  /**
   * La biblioteca: todos los transcripts que el usuario tiene.
   *
   * Se LISTA del disco en cada pedido, no se cachea en el main. La carpeta es
   * del usuario y él la abre y borra cosas ahí —para eso existe `paths.ts`—, así
   * que cualquier lista guardada en memoria empieza a mentir en cuanto toca un
   * archivo. El disco es la fuente de verdad.
   */
  VIDEO_LIST: 'video:list',
  /** Ponerle nombre a un transcript. Cambia el título, NUNCA la carpeta. */
  VIDEO_RENAME: 'video:rename',

  // ── agents hub: discover, run, install and open external agents ─────────
  // See `.claude/docs/agents-hub.md`. These are separate from AGENTS_* above:
  // those list/rule/answer BOTH builtin and external agents; these run only
  // the external ones (an external agent has no `run` equivalent for a
  // builtin agent — builtins don't spawn a child process).
  HUB_RUN: 'hub:run',
  HUB_CANCEL: 'hub:cancel',
  HUB_RESULTS: 'hub:results',
  HUB_OPEN: 'hub:open',
  HUB_INSTALL: 'hub:install',
  HUB_PICK_FOLDER: 'hub:pick-folder',
  HUB_OPEN_HUB: 'hub:open-hub'
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
   * Lo que el agente va diciendo y haciendo, EN VIVO.
   *
   * `jobs:agent` es un `invoke` y no contesta hasta terminar el pedido entero.
   * "Postulate a todas" son varias vacantes y varios minutos: sin este canal el
   * usuario mira una pantalla quieta sin saber si murió. Mismo motivo por el
   * que existe `connections:step`.
   */
  JOBS_AGENT_STEP: 'jobs:agent-step',
  /**
   * Cada paso de una conexión por navegador, EN VIVO.
   *
   * Existe porque `connections:browser` es un `invoke`: no contesta hasta que
   * termina, y conectar Notion puede tardar minutos. Sin este canal la UI se
   * queda muda todo ese rato y el usuario no distingue "está trabajando" de
   * "se colgó" — que fue exactamente lo que pasó.
   */
  CONNECTIONS_STEP: 'connections:step',
  /**
   * En qué paso va el procesado de un video.
   *
   * Mismo motivo que los otros dos: `video:run` es un `invoke` y transcribir una
   * hora de grabación son DOS horas de CPU. Sin este canal el usuario mira una
   * pantalla quieta durante dos horas y concluye, con razón, que se colgó.
   */
  VIDEO_STEP: 'video:step',
  /**
   * One line of a hub agent's run, in vivo. `hub:run` is an `invoke` and an
   * external agent can run for its whole `timeoutMinutes` — same reasoning as
   * `VIDEO_STEP` and `JOBS_AGENT_STEP`.
   */
  HUB_EVENT: 'hub:event',
  /** One step of `hub:install`, as it happens — cloning or `npm install` can take minutes. */
  HUB_INSTALL_STEP: 'hub:install-step'
} as const

/** En qué anda el procesado de un video. `total: 0` = un paso sin subpasos. */
export interface VideoStepEvent {
  stage: 'probe' | 'extract' | 'split' | 'transcribe' | 'filter' | 'page' | 'done'
  label: string
  done: number
  total: number
}

export interface VideoRunSummary {
  /**
   * El id del transcript en la biblioteca: el nombre de su carpeta.
   *
   * Se devuelve para que el renderer pueda renombrarlo sin volver a listar todo:
   * apenas termina una corrida, lo primero que alguien quiere es ponerle nombre.
   */
  id: string
  /** Con qué nombre quedó guardado. Vacío nunca: si no se pidió uno, se deriva. */
  title: string
  /** La carpeta con todo, para poder abrirla. */
  outDir: string
  pagePath: string
  srtPath: string
  textPath: string
  cues: number
  /**
   * Cuántas líneas se descartaron por caer en silencio.
   *
   * Se muestra a propósito: es la prueba de que el filtro corrió. Un cero acá
   * sobre una grabación larga no quiere decir "salió limpio", quiere decir
   * "revisá el umbral".
   */
  droppedCues: number
  frames: number
  durationSeconds: number
  /** Tramos que fallaron. Más de cero = el transcript tiene un hueco no-silencioso. */
  failedChunks: number
}

/**
 * Una fila de la biblioteca de transcripts.
 *
 * Vive acá y no en `core/video/library.ts` porque es la forma que viaja por el
 * IPC, y `core/` no importa `shared/`. Declararla en los dos lados serían dos
 * copias que se separan — el mismo error que el proyecto ya pagó con los tres
 * `.mjs` sueltos de `scripts/video/`.
 */
export interface TranscriptEntry {
  /** El nombre de la carpeta. Es la identidad, igual que el id de un agente. */
  id: string
  /** Lo que el usuario escribió; si no escribió nada, el nombre derivado. */
  title: string
  dir: string
  pagePath: string
  srtPath: string
  textPath: string
  /** De qué grabación salió, para cuando el título no alcanza. */
  sourceName: string
  /** ISO 8601. Vacío solo si ni el `meta.json` ni el mtime se pudieron leer. */
  createdAt: string
  model: string
  language: string
  durationSeconds: number
  cues: number
  droppedCues: number
  frames: number
  /**
   * `true` = el título es DERIVADO, no lo escribió nadie.
   *
   * Se manda a propósito para que la UI pueda distinguirlos: un transcript sin
   * nombre es trabajo a medio terminar, y esconder esa diferencia es lo que
   * convierte una biblioteca en una lista de timestamps.
   */
  untitled: boolean
}

/** Un paso de una conexión, tal como lo ve el usuario mientras pasa. */
export interface ConnectionStepRow {
  /** Qué servicio se está conectando. */
  id: string
  step: string
  ok: boolean
  detail: string
  /** Ruta absoluta del PNG de cómo se veía la pantalla en ese momento. */
  screenshot?: string
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
  intent: 'tasks' | 'close' | 'ambiguous' | 'help'
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
export const OPENABLE_HOSTS: readonly string[] = [
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
export const OPENABLE_DOMAINS: readonly string[] = ['linkedin.com', 'meetup.com']

function hostUnderDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

// ── postulación laboral ────────────────────────────────────────────────────

export type JobApplyMode = 'dry-run' | 'review' | 'auto'

export interface JobsStatus {
  /** ¿Existe el perfil en la carpeta del agente? No hay nada que configurar. */
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
  missing: string[]
}

// ── búsqueda y triage ──────────────────────────────────────────────────────

/**
 * Un paso del agente, en vivo.
 *
 * `say` es para el usuario y va como mensaje del agente. `tool` es qué está
 * haciendo ahora mismo — se pinta como progreso y se reemplaza, no se acumula:
 * doce postulaciones dejarían el hilo ilegible.
 */
export interface AgentStep {
  kind: 'say' | 'tool' | 'progress'
  text: string
}

export interface AgentResult {
  /** La pantalla como quedó: el agente pudo buscar, descartar o postular. */
  screen: RankedJobRow[]
  /** Cuántas herramientas ejecutó. 0 = solo habló. */
  turns: number
}

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
export interface ChatJob {
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
  | { kind: 'search'; queries: string[]; location: string | null }
  | { kind: 'apply'; id: string }
  /** "postulame a todas": prepara los kits en lote, no abre trece navegadores. */
  | { kind: 'apply-all' }
  | { kind: 'show'; id: string }
  | { kind: 'send'; id: string }
  | { kind: 'discard'; id: string }
  | { kind: 'ambiguous'; candidates: ChatJob[]; term: string }
  | { kind: 'chat'; text: string }
  | { kind: 'help' }

export interface HuntResult {
  found: number
  duplicates: number
  ranked: number
  /** Encontradas y no puntuadas por el techo. Se MUESTRA: callarlo engaña. */
  skipped: number
  qualified: RankedJobRow[]
  rejected: RankedJobRow[]
  notionWrites: number
  notionError: string | null
  summary: string
}

export interface HuntProgress {
  phase: string
  detail: string
}

export interface KitResultRow {
  ok: boolean
  cv: string | null
  cover: string | null
  message: string
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
  group: string
  /** Qué aporta ESTA entrada dentro del grupo. Vacío si el grupo es de una. */
  capability: string
  name: string
  purpose: string
  methods: ('browser' | 'token')[]
  credentialUrl: string
  connected: boolean
  /**
   * `yml` = `albus.yml`, el archivo que el usuario puede abrir y editar.
   * `app` = lo cifrado de antes (legado). `env` = una variable de entorno.
   */
  source: 'yml' | 'app' | 'env' | 'none'
  detail: string
  /**
   * ¿El sistema operativo ofrece cifrado de credenciales?
   *
   * Ya no decide si se guarda o no —eso ahora va a `albus.yml` siempre—, pero
   * se sigue informando: es la diferencia entre "tu token está atado a tu
   * cuenta de Windows" y "está en un archivo de texto". El usuario tiene
   * derecho a saber cuál de las dos es.
   */
  encryptionAvailable: boolean
}

export interface AgentInfo {
  id: string
  name: string
  description: string
  /** `false` = se pinta apagado con el motivo, no se esconde. */
  available: boolean
  reason: string
  /**
   * Qué pantalla usa, elegida en su manifiesto.
   *
   * Viaja hasta acá porque es lo que permite que un agente que el usuario
   * escribió tenga cara. Antes el renderer buscaba el componente por ID, y un
   * agente que no estuviera en ese mapa del código fuente no podía tener
   * pantalla nunca. Vacío = se prueba con el id (manifiestos viejos).
   *
   * An external agent always gets `'external'`: one generic screen for every
   * agent installed through the hub, instead of one component per agent id.
   */
  screen: string
  rules: AgentRulesInfo
  /**
   * `'builtin'` lives in `src/main/agents/` (job-search, and whatever ships
   * with the app next). `'external'` is a folder under `agents-hub/agents/`
   * that Albus only discovers, installs and runs — see `.claude/docs/agents-hub.md`.
   */
  origin: 'builtin' | 'external'
  /** `null` for a builtin agent. Set only for `origin: 'external'`. */
  external: ExternalAgentDetails | null
}

/**
 * What the hub knows about one external agent, beyond the common `AgentInfo`
 * shape. `running` lets the UI show a spinner/cancel button without a second
 * round trip to `hub:run`'s in-flight state.
 */
export interface ExternalAgentDetails {
  /** Where its own code (its own git repo) lives. Shown so the user can find it, never opened blind. */
  dir: string
  /** Where it writes what it produces. */
  resultsDir: string
  version: string
  /** The command names its `agent.json` declares (`run`, `check`, …), not the full line. */
  commands: string[]
  /** Informative only — Albus cannot probe a third party's own session. */
  needs: string[]
  /** Informative only — Albus does not schedule anything. */
  schedule: string
  running: boolean
}

/**
 * The hub's own run protocol, mirrored here so the renderer can type the
 * events it receives without importing `main/core/hub/protocol.ts` (which
 * `shared/ipc.ts` cannot: it imports nothing). `result.path`/the `path` on a
 * `result` event are RELATIVE to the agent's results folder here — the main
 * process turns the absolute path it resolved internally into a relative one
 * before it ever reaches the renderer, same reasoning as `HubResultFile`.
 */
export type HubAgentEvent =
  | { type: 'progress'; message: string; percent?: number }
  | { type: 'result'; path: string | null; message: string }
  | { type: 'question'; question: string; context: string; options: string[] }
  | { type: 'error'; message: string }
  | { type: 'log'; text: string }

export interface HubRunSummary {
  runId: string
  agentId: string
  command: string
  status: 'ok' | 'failed' | 'timeout' | 'cancelled'
  exitCode: number | null
  message: string
  /** `path` is relative to the results folder, or `null`. */
  results: { path: string | null; message: string }[]
  /** Capped to the last 50 — more than that and nobody is reading them live anyway. */
  events: HubAgentEvent[]
}

/** One file already on disk under an agent's results folder. */
export interface HubResultFile {
  relPath: string
  size: number
  modifiedAt: string
}

export interface HubInstallStep {
  step: string
  ok: boolean
  detail: string
}

export interface HubInstallReport {
  ok: boolean
  id: string | null
  dir: string | null
  steps: HubInstallStep[]
}

/** Una referencia que el usuario enlazó en su `.md` de reglas. */
export interface RuleRef {
  id: string
  /** Lo que escribió al lado del link. Un hash de 32 no le dice nada a nadie. */
  label: string
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
  question: string
  /** Dónde apareció: la vacante, el campo. Sin esto es incontestable después. */
  context: string
  createdAt: string
  /** Sugerencias del agente. No obligan: se puede escribir cualquier cosa. */
  options: string[]
}

export interface AgentRulesInfo {
  supported: boolean
  exists: boolean
  path: string
  /** Lo que el agente preguntó y sigue sin respuesta. */
  questions: AgentQuestion[]
  /**
   * Las reglas que el usuario escribió, en sus palabras.
   *
   * Es lo que se muestra. Antes se listaban los links parseados —"Notion ·
   * Registro de aplicaciones"— y eso no le dice nada a nadie: una regla es
   * "si me postulo, guardá el CV en esta carpeta", no un inventario de
   * integraciones.
   */
  summary: string[]
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
export const APPLICABLE_HOSTS: readonly string[] = [
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
export const APPLICABLE_DOMAINS: readonly string[] = ['linkedin.com']

export function isApplicableUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false

    const host = parsed.hostname.toLowerCase()
    if (APPLICABLE_HOSTS.includes(host)) return true
    return APPLICABLE_DOMAINS.some((d) => hostUnderDomain(host, d))
  } catch {
    return false
  }
}

/**
 * Saca el destino REAL de un link de postulación de LinkedIn.
 *
 * ## Por qué existe
 *
 * LinkedIn no linkea al ATS de la empresa: linkea a su propio interstitial
 * `linkedin.com/safety/go?url=<destino>&urlhash=…&mt=…`. Ese wrapper depende del
 * referrer y del contexto de la sesión, así que abrirlo directo con `loadURL`
 * hace que LinkedIn lo rechace, **se coma el parámetro `url=`** y deje
 * `/safety/go/?_l=es_ES`: la pantalla de "Página no encontrada".
 *
 * Pasó tal cual con una vacante de Monks. El agente había hecho todo bien
 * —encontró y clickeó "Solicitar", y hasta diagnosticó el fallo— y el destino
 * viajaba ahí adentro: `www.monks.com/careers/…?gh_src=…`. Sin desenvolverlo,
 * NINGUNA postulación externa de LinkedIn puede funcionar nunca.
 *
 * ## Devuelve `null` si no es uno de esos links
 *
 * Y ahí el llamador sigue con su lógica normal. Esto no decide si se puede
 * navegar: solo traduce. Quién puede seguirlo lo decide el llamador.
 */
export function unwrapLinkedInRedirect(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!hostUnderDomain(parsed.hostname.toLowerCase(), 'linkedin.com')) return null
    if (!parsed.pathname.startsWith('/safety/go')) return null

    // `searchParams` ya decodifica: LinkedIn escapa hasta los puntos
    // (`www%2Emonks%2Ecom`), así que leerlo a mano sería pedir un bug.
    const target = parsed.searchParams.get('url')
    if (target === null || target.trim() === '') return null

    const inner = new URL(target)
    // Solo https. Un `javascript:` o un `file:` metido en ese parámetro sería
    // exactamente el ataque que la allowlist viene a evitar.
    if (inner.protocol !== 'https:') return null

    return inner.toString()
  } catch {
    return null
  }
}

export function isOpenableUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false

    const host = parsed.hostname.toLowerCase()
    if (OPENABLE_HOSTS.includes(host)) return true
    if (OPENABLE_DOMAINS.some((d) => hostUnderDomain(host, d))) return true

    // Invariante: todo lo POSTULABLE es abrible. Si Albus puede navegar ahí con
    // tu sesión adentro, abrirlo en tu navegador es estrictamente menos
    // riesgoso. Se deriva en vez de duplicarse en las dos listas, que era la
    // forma garantizada de que se desincronicen — y ya pasó: el scraper devuelve
    // Greenhouse y Lever, y "ver la vacante" habría fallado igual que con
    // `co.linkedin.com`.
    return isApplicableUrl(url)
  } catch {
    return false
  }
}
