import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { agentsDir } from '../paths'

/**
 * Un agente es un ARCHIVO del usuario, no una entrada en el código fuente.
 *
 * ## El problema que resuelve
 *
 * Hasta acá, `AGENTS` era un array literal en `registry.ts`: para sumar un
 * agente había que editar ese array, editar el mapa `PANELS` del renderer y
 * escribir un runner. O sea, **bajarse el código fuente y compilar**. Reclamo
 * textual del usuario, y es correcto: *"esto va a ser una especie de wrapper
 * para múltiples agentes... si alguien un día quiere un agente para postular
 * cosas en LinkedIn, ¿qué va a hacer?"*.
 *
 * Es el mismo principio que ya está escrito en `paths.ts` —*"el repo tiene
 * código, no estado"*— aplicado un nivel más arriba: si las REGLAS del agente
 * son del usuario, su DEFINICIÓN también.
 *
 * Y es la misma conclusión que `.claude/docs/connections.md` sacó para los
 * servicios: *"no existe `notion-auto.ts`, ni va a existir `supabase-auto.ts`.
 * Existió: 459 líneas con los pasos de Notion a mano"*. La solución fue una fila
 * de datos y un motor. Acá la fila vive en el disco del usuario.
 *
 * ## Qué es dato y qué sigue siendo código
 *
 * Dato (`<id>.agente.json`): quién es el agente, qué conexiones necesita, qué
 * capacidades puede usar y a qué apunta.
 *
 * Código: las CAPACIDADES en sí. Alguien tiene que escribir "subí este archivo
 * al input" y "leé la pantalla". Un agente de datos COMPONE primitivas; no las
 * inventa. Decirlo ahora evita prometer algo que el formato no puede cumplir.
 *
 * ## JSON y no markdown
 *
 * Las reglas son `.md` porque las escribe una persona en prosa. Esto lo lee el
 * programa para armar una lista y chequear dependencias, así que es JSON con
 * zod — el mismo criterio que `<id>.preguntas.json`, que ya vive al lado.
 */

/**
 * Las conexiones que un agente puede pedir. Es un enum cerrado a propósito: cada
 * una tiene una sonda de verdad en `registry.ts`, y un nombre que no esté ahí
 * sería una dependencia que nadie verifica — o sea, una que siempre pasa.
 */
export const AGENT_NEEDS = ['linkedin', 'notion', 'google', 'workspace'] as const
export type AgentNeed = (typeof AGENT_NEEDS)[number]

/**
 * Exportado para que `check-agents.ts` pueda validar las semillas con el MISMO
 * schema con el que se leen los archivos del usuario.
 *
 * No es un detalle de testing: es la prueba de que el agente que trae la app no
 * tiene un camino privilegiado. Si la semilla no pasara esta validación, sería un
 * caso especial del código disfrazado de archivo.
 */
export const AgentManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  /**
   * Lo que necesita para trabajar. Un nombre desconocido se DESCARTA en vez de
   * invalidar el archivo entero: un manifiesto viejo con una necesidad que ya no
   * existe tiene que seguir abriendo el agente, no borrarlo de la lista.
   */
  needs: z
    .array(z.string())
    .default([])
    .transform((list) => list.filter((n): n is AgentNeed => (AGENT_NEEDS as readonly string[]).includes(n))),
  /** Capacidades habilitadas. Vacío = todas las que la app tenga. */
  tools: z.array(z.string()).default([]),
  /**
   * Lo que el agente tiene que lograr, en castellano. Se le suma a las reglas
   * cuando decide.
   *
   * Un objetivo dice QUÉ tiene que ser verdad al terminar, no qué botón apretar
   * —misma regla que los objetivos de `connections/services.ts`—. Acá no hay un
   * assert que lo verifique porque el archivo es del usuario: si escribe un
   * selector adentro, se lo lleva el modelo y se rompe solo.
   */
  goals: z.array(z.string()).default([])
})

export interface AgentManifest {
  /** Sale del nombre del archivo, no del contenido: la ruta es la identidad. */
  id: string
  path: string
  name: string
  description: string
  needs: AgentNeed[]
  tools: string[]
  goals: string[]
}

const SUFFIX = '.agente.json'

export function manifestPath(agentId: string): string {
  // Igual que `rulesPath`: el id no se concatena crudo ni cuando viene del
  // propio nombre de un archivo. Un `..` no escribe fuera de la carpeta.
  const clean = agentId.replace(/[^a-z0-9-]/gi, '')
  return join(agentsDir(), `${clean}${SUFFIX}`)
}

function parseManifest(id: string, path: string, raw: string): AgentManifest | null {
  try {
    const parsed = AgentManifestSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      console.warn(`[agentes] ${path} está mal formado, lo ignoro: ${parsed.error.message}`)
      return null
    }
    return { id, path, ...parsed.data }
  } catch (error: unknown) {
    console.warn(`[agentes] ${path} no es JSON válido, lo ignoro: ${String(error)}`)
    return null
  }
}

/**
 * Todos los agentes que el usuario tenga en su carpeta.
 *
 * Archivo por archivo, como todo lo que viene de afuera: un manifiesto corrupto
 * no puede hacer desaparecer los otros cuatro agentes. Es la misma regla que
 * `readQuestions` y que la validación por fila de Supabase.
 */
export function listManifests(): AgentManifest[] {
  const dir = agentsDir()
  if (!existsSync(dir)) return []

  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error: unknown) {
    console.warn(`[agentes] no pude leer ${dir}: ${String(error)}`)
    return []
  }

  const output: AgentManifest[] = []
  for (const name of names) {
    if (!name.endsWith(SUFFIX)) continue

    const id = name.slice(0, -SUFFIX.length)
    if (id === '') continue

    const path = join(dir, name)
    try {
      const m = parseManifest(id, path, readFileSync(path, 'utf8'))
      if (m !== null) output.push(m)
    } catch (error: unknown) {
      console.warn(`[agentes] no pude abrir ${path}: ${String(error)}`)
    }
  }

  // Orden estable por id: `readdirSync` no lo garantiza entre sistemas, y la
  // lista de agentes que baila sola en cada arranque se ve como un bug.
  return output.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Escribe un manifiesto si todavía no está. Devuelve `true` si lo creó.
 *
 * Es una SEMILLA, no una configuración: se planta una vez y desde ahí manda el
 * archivo. Que el agente que viene con la app se instale así —en vez de vivir en
 * el array de `registry.ts`— es lo que hace que el que trae la app y el que se
 * escriba a mano sean exactamente la misma cosa. Si el que viene de fábrica
 * fuera un caso especial, el camino del usuario nunca se probaría.
 */
export function seedManifest(agentId: string, manifest: Omit<AgentManifest, 'id' | 'path'>): boolean {
  const path = manifestPath(agentId)
  if (existsSync(path)) return false

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`[agentes] creado ${path}`)
  return true
}
