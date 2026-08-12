/**
 * Lo que el usuario escribió en su `.md` sobre QUÉ buscar y qué NO quiere.
 *
 * ## Por qué esto existe
 *
 * La plantilla de reglas (`agents/registry.ts`) ya le pide al usuario que
 * escriba sus roles bajo `## Qué buscar`, y le promete, textual, que lo de
 * `## Qué NO quiero` *"el agente lo respeta"*. Nada de eso llegaba al
 * buscador: el renderer mandaba dos roles hardcodeados y el ranking solo veía
 * el perfil. El usuario configuraba algo que el código nunca leía.
 *
 * ## Por qué se parsea ESTO y no más
 *
 * `agents/rules.ts` dice que solo se extraen los links, y el motivo sigue en
 * pie: inventar un formato que el usuario tenga que aprender es justo lo que
 * el `.md` viene a evitar. Pero acá no se inventa nada — la sección y las
 * etiquetas ya están en la plantilla que el propio programa genera. Y el CLI
 * de LinkedIn necesita términos concretos: no hay forma de buscar con prosa.
 *
 * Se leen dos cosas y ninguna más. La modalidad está en la plantilla y no se
 * parsea a propósito: hoy nadie la usaría, y un campo que se lee pero no se
 * aplica es exactamente la clase de cable suelto que este archivo viene a
 * cortar.
 *
 * ## Puro
 *
 * Recibe el markdown, no la ruta. El I/O vive en `agents/rules.ts`, que
 * importa `electron` — y este módulo tiene que poder correr bajo
 * `npm run jobs:check`, que no levanta Electron.
 */

export interface SearchPrefs {
  /** Los roles a buscar, en el orden en que los escribió. Vacío = no puso. */
  roles: string[]
  /** Dónde buscar. `null` = no puso, decide el llamador. */
  location: string | null
  /** Lo que hay que descartar aunque puntúe alto. Va al prompt del ranking. */
  avoid: string[]
}

export const EMPTY_PREFS: SearchPrefs = { roles: [], location: null, avoid: [] }

/**
 * Los mismos topes que el contrato IPC (`HuntSchema`), aplicados acá.
 *
 * No es duplicación defensiva: es que un `.md` con quince roles haría que zod
 * rechace el payload entero y el usuario vea "búsqueda inválida" por haber
 * escrito de más en un archivo que lo invita a escribir libre. Se recorta y se
 * busca, que es lo que espera quien escribió la lista.
 */
export const MAX_ROLES = 8
export const MAX_TERM = 80

/** Sin acentos y en minúsculas, para comparar títulos y etiquetas. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

/**
 * "full stack, backend y AI engineer" → tres términos.
 *
 * La barra entra como separador porque "Node/React" es una forma normal de
 * escribir dos cosas, y el guion NO: "full-stack developer" es un término
 * solo y partirlo devolvería basura a LinkedIn.
 */
const SPLIT = /[,;/]|\sy\s|\so\s/

function terms(raw: string): string[] {
  return raw
    .split(SPLIT)
    .map((t) => t.replace(/^[\s-]+|[\s.]+$/g, '').trim())
    .filter((t) => t.length >= 2)
    .map((t) => t.slice(0, MAX_TERM))
}

/** Una viñeta: `- Roles: x, y` → `{ label: 'roles', value: 'x, y' }`. */
function bullet(line: string): { label: string; value: string } | null {
  const m = /^[-*+]\s+(.*)$/.exec(line.trim())
  if (m === null) return null

  const rest = m[1].trim()
  const colon = rest.indexOf(':')
  if (colon === -1) return { label: '', value: rest }

  return { label: fold(rest.slice(0, colon)), value: rest.slice(colon + 1).trim() }
}

/**
 * Qué buscar y qué evitar, sacado del markdown de reglas.
 *
 * Tolera las dos formas de escribir una lista, porque las dos son razonables y
 * que el programa entienda solo una es cómo se pierde media configuración:
 *
 *     - Roles: full stack developer, backend developer
 *
 *     - Roles:
 *       - full stack developer
 *       - backend developer
 */
export function parseSearchPrefs(markdown: string): SearchPrefs {
  // Los comentarios son el instructivo y los ejemplos de la plantilla. Si
  // contaran, un archivo recién creado se configuraría solo — el mismo error
  // que ya se arregló para los links de Notion.
  const clean = markdown.replace(/<!--[\s\S]*?-->/g, '')

  const roles: string[] = []
  const avoid: string[] = []
  let location: string | null = null

  /** En qué sección vamos: la del título `##` más reciente. */
  let section: 'search' | 'avoid' | 'other' = 'other'
  /** Qué etiqueta quedó abierta esperando viñetas debajo. */
  let open: 'roles' | 'location' | null = null

  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue

    if (line.startsWith('#')) {
      const title = fold(line.replace(/^#+/, ''))
      section = title.includes('que buscar')
        ? 'search'
        : title.includes('no quiero')
          ? 'avoid'
          : 'other'
      open = null
      continue
    }

    const b = bullet(line)
    if (b === null) {
      // Prosa: es el instructivo de la plantilla o una nota del usuario. No es
      // un término de búsqueda, y mandarla a LinkedIn es el bug que originó
      // todo esto ("hacé un barrido" como query).
      open = null
      continue
    }

    if (section === 'avoid') {
      if (b.value !== '') avoid.push(b.value.slice(0, 200))
      continue
    }

    if (section !== 'search') continue

    if (b.label === 'roles') {
      // Con valor en la misma línea se cierra; vacío queda abierto esperando
      // las viñetas de abajo.
      if (b.value === '') open = 'roles'
      else {
        roles.push(...terms(b.value))
        open = null
      }
      continue
    }

    if (b.label === 'ubicacion' || b.label === 'location') {
      if (b.value === '') open = 'location'
      else {
        location = b.value.slice(0, MAX_TERM)
        open = null
      }
      continue
    }

    // Una etiqueta que no nos interesa (modalidad, o lo que el usuario haya
    // agregado) cierra lo anterior: sus viñetas no son roles.
    if (b.label !== '') {
      open = null
      continue
    }

    // Viñeta suelta bajo una etiqueta abierta.
    if (open === 'roles') roles.push(...terms(b.value))
    else if (open === 'location' && location === null) location = b.value.slice(0, MAX_TERM)
  }

  const unique: string[] = []
  const seen = new Set<string>()
  for (const r of roles) {
    const key = fold(r)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    unique.push(r)
    if (unique.length === MAX_ROLES) break
  }

  return { roles: unique, location, avoid }
}
