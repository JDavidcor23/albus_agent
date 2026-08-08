import { shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { agentsDir } from '../paths'

/**
 * Las reglas de cada agente, en un `.md` que el usuario edita.
 *
 * ## Por qué un archivo y no una pantalla de configuración
 *
 * Pedido textual: *"si quieres, podemos hacerlo directamente en un archivo de
 * reglas en vez de estarle pasando una configuración... solo hagamos un MD y
 * yo pongo las rutas y ya con eso lo voy arreglando"*.
 *
 * Y tiene razón de fondo: construir una pantalla por cada cosa configurable
 * significa que agregar una regla nueva es trabajo de UI. Con un `.md`, sumar
 * una regla es escribir una línea. El agente lee el archivo entero como
 * contexto, así que entiende reglas que nadie programó — el mismo criterio que
 * los objetivos de las conexiones: intención en castellano, no un formulario.
 *
 * ## Lo que SÍ se parsea, y por qué solo eso
 *
 * El código necesita una cosa concreta del archivo: **a qué base de Notion
 * escribir**. Eso hoy era una constante hardcodeada que solo funciona en una
 * cuenta —"¿y cómo sabe qué proyecto va a escoger?", la pregunta era justa—.
 * Las URLs de Notion y Drive se extraen; todo lo demás queda como texto para
 * el agente. Parsear más sería inventar un formato que el usuario tiene que
 * aprender, que es exactamente lo que este archivo viene a evitar.
 *
 * ## Dónde vive
 *
 * `userData/agentes/<id>.md`. **Nunca en el repo**, ni siquiera en desarrollo:
 * lo que el usuario escribe es suyo, no del código fuente. Ver `paths.ts`.
 */

export interface NotionRef {
  /** El id sin guiones, listo para la API. */
  id: string
  url: string
  /** Lo que el usuario escribió al lado del link, si escribió algo. */
  label: string
}

export interface AgentRules {
  agentId: string
  path: string
  /** `false` si el archivo todavía no existe (se devuelve la plantilla). */
  exists: boolean
  /** El markdown completo. Es lo que se le pasa al agente como contexto. */
  text: string
  /** Lo que el usuario escribió, sin títulos ni instructivo. Para mostrarlo. */
  summary: string[]
  /** Las páginas o bases de Notion que el usuario enlazó. */
  notion: NotionRef[]
  /** Las carpetas de Drive que enlazó. */
  drive: NotionRef[]
}

export function rulesDir(): string {
  return agentsDir()
}

export function rulesPath(agentId: string): string {
  // El id sale del registro, no del usuario, pero igual no se concatena algo
  // que pueda tener `..` o barras: un id raro no va a escribir fuera de acá.
  const clean = agentId.replace(/[^a-z0-9-]/gi, '')
  return join(rulesDir(), `${clean}.md`)
}

/**
 * Un id de Notion son 32 hex, con o sin guiones, al final de la URL.
 *
 * Se acepta cualquier host de Notion —`notion.so`, `www.notion.so`,
 * `app.notion.com`— porque el usuario va a pegar lo que le dé el botón de
 * copiar link, y eso cambia según desde dónde lo copie.
 *
 * La forma con guiones va PRIMERO y con los grupos exactos (8-4-4-4-12), no
 * como `[0-9a-f-]{36}`: en `notion.so/otra-1234abcd-5678-…` la `a` de "otra"
 * también es un dígito hex, así que el patrón laxo empezaba a contar una letra
 * antes y devolvía un id corrido. Y `(?![0-9a-f])` al final evita cortar por
 * la mitad un hash más largo.
 */
const RE_NOTION =
  /https?:\/\/(?:[\w-]+\.)*notion\.(?:so|com)\/\S*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})(?![0-9a-f])/gi

/** Carpetas y archivos de Drive. El id es lo que va después de /d/ o /folders/. */
const RE_DRIVE = /https?:\/\/(?:drive|docs)\.google\.com\/\S*?(?:folders|\/d)\/([\w-]{10,})/gi

/**
 * Lo que el usuario escribió en la misma línea, sin el link ni la viñeta.
 *
 * Sirve para que la UI muestre "Registro de aplicaciones" en vez de un hash de
 * 32 caracteres — y para que el usuario reconozca cuál eligió.
 */
function labelFromLine(line: string): string {
  return line
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^[\s>*+-]*\[?/, '')
    .replace(/\]?\(?\)?/g, '')
    .replace(/[:—–-]\s*$/, '')
    .trim()
}

function extract(text: string, re: RegExp): NotionRef[] {
  const output: NotionRef[] = []
  const seen = new Set<string>()

  for (const line of text.split(/\r?\n/)) {
    // Una línea comentada con `<!--` es del ejemplo de la plantilla, no una
    // regla del usuario. Sin esto, la plantilla se autoconfigura sola.
    if (line.trim().startsWith('<!--')) continue

    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      const id = m[1].replace(/-/g, '')
      if (seen.has(id)) continue
      seen.add(id)
      output.push({ id, url: m[0], label: labelFromLine(line) })
    }
  }

  return output
}

/**
 * Las reglas que el usuario ESCRIBIÓ, para mostrárselas.
 *
 * La UI mostraba "Notion · Registro de aplicaciones" —los links parseados— y el
 * reclamo fue exacto: *"eso no me dice ni mierda"*. Y tenía razón: una regla es
 * *"si me postulo a una empresa, guardá el CV en esta carpeta de Drive"*, no un
 * inventario de integraciones. Lo que hay que mostrar es lo que escribió.
 *
 * Se saltean los títulos, los comentarios, las viñetas vacías y el instructivo
 * de la plantilla: si eso contara, un archivo recién creado se vería "lleno"
 * sin que el usuario haya escrito una sola regla.
 */
function summarizeRules(text: string): string[] {
  const output: string[] = []
  let inComment = false

  for (const raw of text.split(/\r?\n/)) {
    /*
     * Un comentario que ABRE Y CIERRA en la misma línea se recorta; solo se
     * entra en modo "saltear" si queda abierto.
     *
     * Antes cualquier línea con `<!--` se descartaba entera, y las respuestas
     * del agente —que se anexan como `- respuesta  <!-- preguntaste: … -->`—
     * desaparecían del panel: el usuario contestaba y no veía nada cambiar.
     */
    let line = raw.replace(/<!--[\s\S]*?-->/g, '').trim()

    if (inComment) {
      // Adentro de un bloque abierto: se sale al ver el cierre, y lo que venga
      // después en esa misma línea sí cuenta.
      const closes = line.indexOf('-->')
      if (closes === -1) continue
      inComment = false
      line = line.slice(closes + 3).trim()
    }

    if (line.includes('<!--')) {
      inComment = true
      line = line.slice(0, line.indexOf('<!--')).trim()
    }

    /*
     * SOLO las viñetas cuentan como regla.
     *
     * Antes se tomaba cualquier línea que no fuera título ni comentario, y el
     * panel terminó mostrando el instructivo de la plantilla —"Pegá acá el
     * link de la base de Notion…"— como si fueran reglas escritas por el
     * usuario. Peor: los párrafos largos se cortan en varias líneas, así que
     * salían partidos por la mitad.
     *
     * Una regla es una viñeta. La prosa explicativa no lo es. Sin listas de
     * frases prohibidas que mantener.
     */
    if (!/^[-*+]\s+/.test(line)) continue

    const withoutBullet = line
      .replace(/^[-*+]\s*/, '')
      // Las URLs se van: son configuración, no una regla que alguien lea. A
      // dónde escribe el agente se muestra en el pie, y un hash de 32
      // caracteres en el medio de la lista es puro ruido.
      .replace(/<?https?:\/\/\S+>?/g, '')
      .replace(/\[([^\]]*)\]\(\s*\)/g, '$1')
      .trim()

    // "Roles:" —o lo que quedó de una línea que solo tenía un link— es un
    // renglón que el usuario todavía no llenó.
    if (withoutBullet === '' || withoutBullet.endsWith(':') || withoutBullet.length < 3) continue

    output.push(withoutBullet.slice(0, 140))
  }

  return output
}

export function parseRules(agentId: string, text: string, path: string, exists: boolean): AgentRules {
  return {
    agentId,
    path,
    exists,
    text,
    summary: summarizeRules(text),
    notion: extract(text, RE_NOTION),
    drive: extract(text, RE_DRIVE)
  }
}

/**
 * Sin archivo, el resumen va VACÍO aunque haya plantilla.
 *
 * La plantilla es papel con renglones, no reglas. Devolver su contenido como
 * resumen hacía que el panel mostrara los ejemplos y las etiquetas del
 * instructivo como si el usuario los hubiera escrito — y el botón dijera
 * "escribir las primeras" arriba de una lista llena.
 */
function noRules(agentId: string, template: string, path: string): AgentRules {
  return { ...parseRules(agentId, template, path, false), summary: [], notion: [], drive: [] }
}

export function readRules(agentId: string, template = ''): AgentRules {
  const path = rulesPath(agentId)

  if (!existsSync(path)) return noRules(agentId, template, path)

  try {
    return parseRules(agentId, readFileSync(path, 'utf8'), path, true)
  } catch (error: unknown) {
    console.warn(`[reglas] no pude leer ${path}: ${String(error)}`)
    return noRules(agentId, template, path)
  }
}

/** Crea el archivo con la plantilla si no está. Devuelve la ruta. */
export function ensureRules(agentId: string, template: string): string {
  const path = rulesPath(agentId)
  if (existsSync(path)) return path

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, template, 'utf8')
  console.log(`[reglas] creado ${path}`)
  return path
}

/** Abre el `.md` en el editor por defecto del sistema. */
export async function openRules(agentId: string, template: string): Promise<string> {
  const path = ensureRules(agentId, template)
  await shell.openPath(path)
  return path
}
