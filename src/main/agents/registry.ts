import type { AgentInfo } from '../../shared/ipc'
import { ensureRules, openRules, readRules } from './rules'
import { pending, answered, toAgentQuestion } from './questions'
import {
  listManifests,
  seedManifest,
  type AgentManifest,
  type AgentNeed
} from './manifest'
import { hasLinkedInSession } from '../browser/session'
import { isNotionConfigured } from '../notion/client'
import { hasGmailScope } from '../gmail/send'
import { loadProfile } from '../jobs/workspace'
import { ffmpegPath } from '../video/ffmpeg'
import { whisperPath } from '../video/whisper'
import { SEEDS } from './seeds'

/**
 * El registro de agentes de Albus. Lee la CARPETA del usuario, no un array.
 *
 * ## Qué cambió y por qué
 *
 * Acá había un `AGENTS: AgentDefinition[]` literal, con el nombre, la
 * descripción, la plantilla de reglas y una función `check()` hardcodeada por
 * agente. Sumar un agente era editar este archivo, editar el mapa `PANELS` del
 * renderer y compilar. Reclamo del usuario, y es correcto: *"esto va a ser una
 * especie de wrapper para múltiples agentes... si alguien un día quiere un
 * agente para postular cosas en LinkedIn, ¿qué va a hacer?"*. Con la definición
 * en el código fuente, la respuesta era "clonar el repo", que no es respuesta.
 *
 * Ahora un agente es `userData/agentes/<id>.agente.json` + su `<id>.md` de
 * reglas. Este archivo no conoce ninguno en particular: lista lo que haya en la
 * carpeta y chequea las dependencias que cada manifiesto declare.
 *
 * ## El de fábrica se instala, no se privilegia
 *
 * El agente de trabajo se PLANTA en la carpeta la primera vez que se abre la
 * pestaña (`seeds.ts`), y desde ahí es un archivo como cualquier otro. Si fuera
 * un caso especial del código, el camino que recorre un agente escrito a mano no
 * se probaría nunca — y sería el único camino que le importa a un segundo
 * usuario.
 *
 * ## Lo que sigue siendo código, a propósito
 *
 * Las SONDAS de cada dependencia. `needs: ["notion"]` es un dato; saber si
 * Notion contesta es una función. Un agente de datos declara qué necesita y
 * compone capacidades que ya existen: no inventa capacidades nuevas. Prometer lo
 * contrario sería vender un formato que no puede cumplirlo.
 */

/** Dependencia declarada → cómo se verifica de verdad. Esto es código y va a serlo. */
const PROBES: Record<AgentNeed, () => Promise<{ ok: boolean; reason: string }>> = {
  linkedin: async () => ({
    ok: await hasLinkedInSession(),
    reason: 'LinkedIn'
  }),

  notion: async () => ({ ok: isNotionConfigured(), reason: 'Notion' }),

  google: async () => {
    try {
      return { ok: (await hasGmailScope()).ok, reason: 'Google' }
    } catch {
      return { ok: false, reason: 'Google' }
    }
  },

  /*
   * El workspace es la única dependencia DURA: sin perfil no hay con qué llenar
   * un formulario, así que el agente se muestra apagado. Las otras tres apenas
   * recortan lo que puede hacer —sin Notion se postula igual, solo que no se
   * espeja— y apagar el agente entero por eso sería exagerado.
   */
  workspace: async () => {
    try {
      await loadProfile(true)
      return { ok: true, reason: '' }
    } catch (error: unknown) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  },

  /*
   * ffmpeg y whisper. Dependencia DURA y sin vuelta: no hay una versión
   * degradada de "transcribir un video" que funcione sin ellos.
   *
   * Esta sonda es la razón por la que `'video-tools'` tuvo que entrar al enum de
   * `AGENT_NEEDS` en vez de escribirse suelto en el manifiesto. El schema
   * DESCARTA en silencio una necesidad que no conoce: un `"needs":
   * ["ffmpeg"]` habría quedado en `needs: []`, y el agente se habría pintado
   * disponible en una máquina sin ninguno de los dos para después explotar
   * corriendo, sin motivo a la vista. Justo lo que `agents.md` prohíbe.
   */
  'video-tools': async () => {
    const missing: string[] = []
    if ((await ffmpegPath()) === null) missing.push('ffmpeg')
    if ((await whisperPath()) === null) missing.push('whisper')

    return missing.length === 0
      ? { ok: true, reason: '' }
      : { ok: false, reason: `falta ${missing.join(' y ')} en el PATH` }
  }
}

const HARD_NEEDS: readonly AgentNeed[] = ['workspace', 'video-tools']

async function checkNeeds(needs: AgentNeed[]): Promise<{ available: boolean; reason: string }> {
  const missing: string[] = []

  for (const need of needs) {
    let result: { ok: boolean; reason: string }
    try {
      result = await PROBES[need]()
    } catch (error: unknown) {
      // Una sonda que revienta no puede tumbar la pestaña de agentes.
      result = { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }

    if (result.ok) continue
    if (HARD_NEEDS.includes(need)) return { available: false, reason: result.reason }
    missing.push(result.reason)
  }

  return {
    available: true,
    reason: missing.length > 0 ? `not connected: ${missing.join(' · ')}` : ''
  }
}

/**
 * Los agentes que el usuario tiene, plantando los de fábrica si es la primera vez.
 *
 * La semilla se intenta en cada llamada y es barata: `seedManifest` no escribe si
 * el archivo ya está. Hacerlo acá y no en el arranque significa que borrar el
 * `.json` a mano y volver a abrir la pestaña lo restaura — que es lo que
 * cualquiera va a intentar cuando lo rompa editándolo.
 */
export function installedAgents(): AgentManifest[] {
  for (const seed of SEEDS) {
    seedManifest(seed.id, seed.manifest)
    ensureRules(seed.id, seed.rulesTemplate)
  }
  return listManifests()
}

export async function listAgents(): Promise<AgentInfo[]> {
  const info: AgentInfo[] = []

  for (const a of installedAgents()) {
    const status = await checkNeeds(a.needs)
    const rules = readRules(a.id, '')

    info.push({
      id: a.id,
      name: a.name,
      description: a.description,
      available: status.available,
      reason: status.reason,
      screen: a.screen,
      rules: {
        // Todo agente usa archivo de reglas: es la forma de hablarle.
        supported: true,
        exists: rules.exists,
        path: rules.path,
        // Del disco al cable: las claves cambian de idioma en un solo lugar.
        questions: pending(a.id).map(toAgentQuestion),
        // Lo que el usuario escribió, en sus palabras. Es lo que se muestra.
        summary: rules.summary,
        // Los links van igual, pero como dato secundario: sirven para saber si
        // el agente sabe a dónde escribir, no como resumen de las reglas.
        notion: rules.notion.map((n) => ({ id: n.id, label: n.label })),
        drive: rules.drive.map((d) => ({ id: d.id, label: d.label }))
      }
    })
  }

  return info
}

/** El manifiesto de uno, para quien necesite sus tools o sus objetivos. */
export function agentManifest(agentId: string): AgentManifest | null {
  return installedAgents().find((a) => a.id === agentId) ?? null
}

/**
 * Las capacidades que ESTE agente puede usar, según su manifiesto.
 *
 * `tools: []` = todas las que la app tenga. Una lista = solo esas, y ahí está la
 * palanca del formato: "un agente de LinkedIn que solo publica contenido" pasa a
 * ser un archivo con `"tools": ["buscar", "subir_a_drive"]` en vez de un fork del
 * repositorio.
 *
 * El recorte no es solo del prompt: `runAgent` verifica contra esta misma lista
 * antes de ejecutar, así que una capacidad que el usuario no habilitó no se corre
 * ni aunque el modelo acierte su nombre.
 *
 * Un nombre que no corresponde a ninguna capacidad se AVISA en vez de ignorarse
 * callado: es un typo del usuario, y su síntoma sería un agente que "no sabe"
 * hacer algo que él cree haberle habilitado.
 */
export function enabledTools<T extends { name: string }>(agentId: string, all: T[]): T[] {
  const manifest = agentManifest(agentId)
  if (manifest === null || manifest.tools.length === 0) return all

  const exists = new Set(all.map((t) => t.name))
  for (const name of manifest.tools) {
    if (!exists.has(name)) {
      console.warn(`[agentes] ${agentId} habilita "${name}", que no es una capacidad de la app`)
    }
  }

  const allowed = new Set(manifest.tools)
  return all.filter((t) => allowed.has(t.name))
}

/** Abre el `.md` de reglas del agente, creándolo vacío si no está. */
export async function openAgentRules(agentId: string): Promise<string> {
  const a = agentManifest(agentId)
  if (a === null) throw new Error(`no conozco el agente "${agentId}"`)

  /*
   * Un agente escrito a mano no tiene plantilla, y eso está bien: se le crea un
   * archivo con el encabezado mínimo. Antes esto tiraba "no usa archivo de
   * reglas" para cualquiera que no estuviera en el array — o sea, para todos los
   * que el usuario escribiera.
   */
  return await openRules(agentId, `# ${a.name} — reglas\n\nEscribí acá lo que querés que respete.\n\n- \n`)
}

/**
 * Las reglas como TEXTO, para pasárselas al agente cuando trabaja.
 *
 * Es el punto del archivo: lo que el usuario escriba ahí —aunque nadie lo haya
 * programado— le llega al modelo como contexto. Y ahora también sus OBJETIVOS,
 * que salen del manifiesto: eso es lo que hace que el flujo del agente sea un
 * dato del usuario y no una secuencia compilada.
 */
export function agentRules(agentId: string): string {
  const manifest = agentManifest(agentId)
  const r = readRules(agentId, '')
  const parts: string[] = []

  if (manifest !== null && manifest.goals.length > 0) {
    parts.push(`## A qué apunta este agente\n${manifest.goals.map((g) => `- ${g}`).join('\n')}`)
  }

  if (r.exists && r.text.trim() !== '') parts.push(r.text)

  /*
   * Lo ya respondido va al final y con título propio.
   *
   * Ya está anexado al `.md`, así que técnicamente se repite. Se repite a
   * propósito: puesto al final y bajo un encabezado explícito, es lo último que
   * el agente lee antes de decidir, y son justo las reglas que nacieron de una
   * duda suya — las que más chance tienen de volver a hacer falta.
   */
  const previous = answered(agentId)
  if (previous.length > 0) {
    const block = previous.map((p) => `- ${p.question} → ${p.answer}`).join('\n')
    parts.push(`## Ya me preguntaste esto y te respondí\n${block}`)
  }

  return parts.join('\n\n')
}
