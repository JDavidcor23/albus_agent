import { shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { carpetaAgentes } from '../paths'

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

export interface ReferenciaNotion {
  /** El id sin guiones, listo para la API. */
  id: string
  url: string
  /** Lo que el usuario escribió al lado del link, si escribió algo. */
  etiqueta: string
}

export interface ReglasAgente {
  agenteId: string
  ruta: string
  /** `false` si el archivo todavía no existe (se devuelve la plantilla). */
  existe: boolean
  /** El markdown completo. Es lo que se le pasa al agente como contexto. */
  texto: string
  /** Lo que el usuario escribió, sin títulos ni instructivo. Para mostrarlo. */
  resumen: string[]
  /** Las páginas o bases de Notion que el usuario enlazó. */
  notion: ReferenciaNotion[]
  /** Las carpetas de Drive que enlazó. */
  drive: ReferenciaNotion[]
}

export function carpetaReglas(): string {
  return carpetaAgentes()
}

export function rutaReglas(agenteId: string): string {
  // El id sale del registro, no del usuario, pero igual no se concatena algo
  // que pueda tener `..` o barras: un id raro no va a escribir fuera de acá.
  const limpio = agenteId.replace(/[^a-z0-9-]/gi, '')
  return join(carpetaReglas(), `${limpio}.md`)
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
function etiquetaDeLinea(linea: string): string {
  return linea
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^[\s>*+-]*\[?/, '')
    .replace(/\]?\(?\)?/g, '')
    .replace(/[:—–-]\s*$/, '')
    .trim()
}

function extraer(texto: string, re: RegExp): ReferenciaNotion[] {
  const salida: ReferenciaNotion[] = []
  const vistos = new Set<string>()

  for (const linea of texto.split(/\r?\n/)) {
    // Una línea comentada con `<!--` es del ejemplo de la plantilla, no una
    // regla del usuario. Sin esto, la plantilla se autoconfigura sola.
    if (linea.trim().startsWith('<!--')) continue

    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(linea)) !== null) {
      const id = m[1].replace(/-/g, '')
      if (vistos.has(id)) continue
      vistos.add(id)
      salida.push({ id, url: m[0], etiqueta: etiquetaDeLinea(linea) })
    }
  }

  return salida
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
function resumirReglas(texto: string): string[] {
  const salida: string[] = []
  let enComentario = false

  for (const cruda of texto.split(/\r?\n/)) {
    /*
     * Un comentario que ABRE Y CIERRA en la misma línea se recorta; solo se
     * entra en modo "saltear" si queda abierto.
     *
     * Antes cualquier línea con `<!--` se descartaba entera, y las respuestas
     * del agente —que se anexan como `- respuesta  <!-- preguntaste: … -->`—
     * desaparecían del panel: el usuario contestaba y no veía nada cambiar.
     */
    let linea = cruda.replace(/<!--[\s\S]*?-->/g, '').trim()

    if (enComentario) {
      // Adentro de un bloque abierto: se sale al ver el cierre, y lo que venga
      // después en esa misma línea sí cuenta.
      const cierre = linea.indexOf('-->')
      if (cierre === -1) continue
      enComentario = false
      linea = linea.slice(cierre + 3).trim()
    }

    if (linea.includes('<!--')) {
      enComentario = true
      linea = linea.slice(0, linea.indexOf('<!--')).trim()
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
    if (!/^[-*+]\s+/.test(linea)) continue

    const sinVineta = linea
      .replace(/^[-*+]\s*/, '')
      // Las URLs se van: son configuración, no una regla que alguien lea. A
      // dónde escribe el agente se muestra en el pie, y un hash de 32
      // caracteres en el medio de la lista es puro ruido.
      .replace(/<?https?:\/\/\S+>?/g, '')
      .replace(/\[([^\]]*)\]\(\s*\)/g, '$1')
      .trim()

    // "Roles:" —o lo que quedó de una línea que solo tenía un link— es un
    // renglón que el usuario todavía no llenó.
    if (sinVineta === '' || sinVineta.endsWith(':') || sinVineta.length < 3) continue

    salida.push(sinVineta.slice(0, 140))
  }

  return salida
}

export function parsearReglas(agenteId: string, texto: string, ruta: string, existe: boolean): ReglasAgente {
  return {
    agenteId,
    ruta,
    existe,
    texto,
    resumen: resumirReglas(texto),
    notion: extraer(texto, RE_NOTION),
    drive: extraer(texto, RE_DRIVE)
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
function sinReglas(agenteId: string, plantilla: string, ruta: string): ReglasAgente {
  return { ...parsearReglas(agenteId, plantilla, ruta, false), resumen: [], notion: [], drive: [] }
}

export function leerReglas(agenteId: string, plantilla = ''): ReglasAgente {
  const ruta = rutaReglas(agenteId)

  if (!existsSync(ruta)) return sinReglas(agenteId, plantilla, ruta)

  try {
    return parsearReglas(agenteId, readFileSync(ruta, 'utf8'), ruta, true)
  } catch (error: unknown) {
    console.warn(`[reglas] no pude leer ${ruta}: ${String(error)}`)
    return sinReglas(agenteId, plantilla, ruta)
  }
}

/** Crea el archivo con la plantilla si no está. Devuelve la ruta. */
export function asegurarReglas(agenteId: string, plantilla: string): string {
  const ruta = rutaReglas(agenteId)
  if (existsSync(ruta)) return ruta

  mkdirSync(dirname(ruta), { recursive: true })
  writeFileSync(ruta, plantilla, 'utf8')
  console.log(`[reglas] creado ${ruta}`)
  return ruta
}

/** Abre el `.md` en el editor por defecto del sistema. */
export async function abrirReglas(agenteId: string, plantilla: string): Promise<string> {
  const ruta = asegurarReglas(agenteId, plantilla)
  await shell.openPath(ruta)
  return ruta
}
