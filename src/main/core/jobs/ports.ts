import type { FormModel, JobPosting } from './types'

/**
 * Lo único que el dominio sabe del navegador. Abajo hay un BrowserWindow de
 * Electron, pero podría haber otra cosa: el bucle de apply.ts no lo sabe ni
 * le importa.
 */
export interface BrowserPort {
  open(url: string): Promise<void>
  currentUrl(): string
  /** Lee el formulario visible y estampa los ids con que después se llena. */
  readForm(): Promise<FormModel>
  /** Setea el valor disparando los eventos que React necesita para enterarse. */
  fill(selector: string, value: string): Promise<void>
  /** Sube un archivo a un `input[type=file]`. Va por CDP: `.value` no se puede setear. */
  uploadFile(selector: string, absolutePath: string): Promise<void>
  click(selector: string): Promise<void>
  /** Devuelve la ruta del PNG escrito. */
  screenshot(destPath: string): Promise<string>
  /**
   * La misma captura pero chica y en `data:` para mandarla por IPC.
   *
   * La ruta de archivo no sirve para mostrarla: el CSP del renderer es
   * `img-src 'self' data:` y un `file://` queda bloqueado. Achicarla no es
   * cosmético — un PNG de 1280×900 en base64 son cientos de KB por paso.
   */
  thumbnail(width?: number): Promise<string>
  /** ¿Hay cookie de sesión para ese dominio? No navega: solo mira el cookie jar. */
  hasSession(domain: string, cookieName: string): Promise<boolean>
  /** Trae la ventana al frente para que el usuario resuelva algo a mano. */
  reveal(): void
  close(): Promise<void>

  // ── primitivas para automatizar una UI ajena ─────────────────────────────
  // Notion y compañía son SPAs con clases generadas: el texto visible es lo
  // único estable. Si el texto también cambia, cambió la UI de verdad y
  // queremos que falle ruidoso, no que adivine.

  /** Click en el primer elemento cuyo texto matchee. Reintenta; tira al vencer. */
  clickText(texts: string[], exact?: boolean, timeoutMs?: number): Promise<string>
  /** Espera a que aparezca alguno de los textos. `false` si se acabó el tiempo. */
  waitForText(texts: string[], timeoutMs: number): Promise<boolean>
  /** Primer match del patrón en la página o en el valor de un input. */
  extractPattern(pattern: string, flags?: string): Promise<string | null>
  /** Escribe en el input que matchee alguna pista (placeholder, aria-label…). */
  typeByLabel(hints: string[], value: string): Promise<void>
  /** El texto visible completo. Para diagnosticar cuando algo no aparece. */
  visibleText(): Promise<string>

  // ── mirar la página en vez de adivinarla ─────────────────────────────────
  // Las primitivas de arriba van con una lista de textos ESPERADOS: sirven
  // mientras el sitio diga lo que creíamos. Estas describen lo que HAY y dejan
  // que otro decida — un modelo, hoy. Es la diferencia entre romperse cuando
  // Notion renombra un botón y enterarse de que lo renombró.

  /** Todo lo clickeable y escribible de la página, con un id nuestro. */
  inventory(): Promise<Inventory>
  /** Click en el elemento que el inventario marcó con ese id. */
  clickById(cid: string): Promise<string>
  /** Escribe en el elemento que el inventario marcó con ese id. */
  typeById(cid: string, value: string): Promise<void>
  /** Abre DevTools sobre esta página. Para poder inspeccionarla de verdad. */
  openDevTools(): void
}

/** Un elemento de la página tal como se lo mostramos a quien tenga que elegir. */
export interface InventoryItem {
  cid: string
  action: 'click' | 'type'
  tag: string
  role: string
  /** Texto visible + aria-label + title + placeholder + name, todo junto. */
  text: string
  value: string
  href: string
  disabled: boolean
  /** Coordenadas en la ventana: es lo que cruza esta lista con la captura. */
  rect: { x: number; y: number; w: number; h: number }
}

export interface Inventory {
  url: string
  title: string
  /** `true` si hay un modal abierto: entonces el inventario es SOLO del modal. */
  inModal: boolean
  text: string
  /**
   * `true` si había más elementos de los que entraron.
   *
   * Se dice en vez de callarse: un inventario truncado en silencio hace que el
   * agente concluya "eso no está en la página" sobre algo que sí está.
   */
  truncated: boolean
  items: InventoryItem[]
}

export interface KitPaths {
  cv: string | null
  cover: string | null
}

/**
 * De dónde salen los PDF ya compilados. Hoy es el workspace de ai-job-search;
 * el dominio solo pide "el kit de esta empresa".
 */
export interface KitSource {
  findKit(posting: JobPosting): Promise<KitPaths>
  /**
   * Copia el PDF a un temporal con el nombre con que debe verlo el reclutador.
   * Devuelve la ruta absoluta del temporal.
   */
  stageForUpload(sourcePath: string, uploadBaseName: string): Promise<string>
}

export interface TrackerRow {
  date: string
  company: string
  sector: string
  role: string
  roleType: string
  channel: string
  status: string
  contactPerson: string
  fitRating: string
  notes: string
  cvFile: string
  coverLetterFile: string
  source: string
}

export interface TrackerSink {
  append(row: TrackerRow): Promise<void>
  /** URLs ya registradas, para no postularse dos veces a lo mismo. */
  seenUrls(): Promise<Set<string>>
}
