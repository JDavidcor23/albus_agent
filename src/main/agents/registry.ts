import type { AgentInfo } from '../../shared/ipc'
import { openRules, readRules } from './rules'
import { pending, answered, toAgentQuestion } from './questions'
import { hasLinkedInSession } from '../browser/session'
import { isNotionConfigured } from '../notion/client'
import { hasGmailScope } from '../gmail/send'
import { loadProfile } from '../jobs/workspace'

/**
 * El registro de agentes de Albus.
 *
 * Albus no es "la app que extrae datos de notas": es el contenedor donde viven
 * los agentes del usuario. Hoy hay uno. Mañana hay uno de gastos, otro de
 * contenido para LinkedIn, otro de lo que se le ocurra.
 *
 * Por eso esto es una LISTA y no un `if`. Sumar un agente es agregar una
 * entrada acá y un componente en el renderer — no tocar el shell, no tocar la
 * navegación, no tocar los otros agentes.
 *
 * Cada agente reporta si está disponible y POR QUÉ no lo está. Un agente que
 * desaparece de la lista cuando le falta una credencial es un agente que el
 * usuario cree que nunca existió.
 */

export interface AgentDefinition {
  id: string
  name: string
  description: string
  /** Chequea sus propias dependencias. Nunca tira: devuelve el motivo. */
  check: () => Promise<{ available: boolean; reason: string }>
  /**
   * El `.md` que el usuario edita para decirle a este agente qué mirar.
   *
   * Es una PLANTILLA, no una configuración: se escribe una vez si el archivo
   * no existe y después manda lo que el usuario ponga. Agregar una regla nueva
   * es escribir una línea ahí, no construir una pantalla — que es la razón por
   * la que esto existe en vez de un formulario.
   */
  rulesTemplate?: string
}

/**
 * La plantilla del agente de trabajo.
 *
 * El contenido queda en castellano a propósito: esto no es código, es lo que el
 * USUARIO abre y lee en su editor.
 *
 * Los links van comentados con `<!--` a propósito: el parser saltea esas
 * líneas, así que la plantilla NO se autoconfigura con un ejemplo. El usuario
 * pega los suyos y recién ahí empiezan a contar.
 */
const JOB_SEARCH_RULES_TEMPLATE = `# Búsqueda de trabajo — reglas

Este archivo lo leés vos y lo lee el agente. Escribí en castellano: no hay
formato que aprender. Lo único que el código extrae son los **links** de Notion
y de Google Drive; el resto del texto le llega al agente como contexto.

## Dónde registrar las postulaciones

Pegá acá el link de la base de Notion donde llevás el tracker. El primero de la
lista es el que se usa para escribir.

<!-- Ejemplo (borrá el comentario y pegá el tuyo):
- Registro de aplicaciones: https://www.notion.so/00000000000000000000000000000000
-->

## Carpetas de Drive

Dónde dejar los CV y las cartas, si querés archivarlos.

<!-- - CVs: https://drive.google.com/drive/folders/xxxxxxxxxxxxxxxxx -->

## Qué buscar

- Roles:
- Ubicación:
- Modalidad:

## Qué NO quiero

Escribí acá lo que hay que descartar aunque puntúe alto. El agente lo respeta.

-

## Notas para el agente

Cualquier cosa que quieras que tenga en cuenta al puntuar o al postularse.

-
`

export const AGENTS: AgentDefinition[] = [
  {
    id: 'job-search',
    name: 'Búsqueda de trabajo',
    description: 'Busca vacantes, las puntúa contra tu perfil, se postula y actualiza Notion.',
    rulesTemplate: JOB_SEARCH_RULES_TEMPLATE,
    async check() {
      const missing: string[] = []

      try {
        await loadProfile(true)
      } catch (error: unknown) {
        return {
          available: false,
          reason: error instanceof Error ? error.message : String(error)
        }
      }

      if (!(await hasLinkedInSession())) missing.push('LinkedIn')
      if (!isNotionConfigured()) missing.push('Notion')

      try {
        if (!(await hasGmailScope()).ok) missing.push('Google')
      } catch {
        missing.push('Google')
      }

      // Falta algo pero igual está disponible: sin Notion se puede buscar y
      // postular, solo que no se espeja. Apagarlo entero sería exagerado.
      return {
        available: true,
        reason: missing.length > 0 ? `sin conectar: ${missing.join(' · ')}` : ''
      }
    }
  }
]

export async function listAgents(): Promise<AgentInfo[]> {
  const info: AgentInfo[] = []

  for (const a of AGENTS) {
    let status: { available: boolean; reason: string }
    try {
      status = await a.check()
    } catch (error: unknown) {
      // Un agente que revienta al chequearse no puede tumbar la pestaña.
      status = {
        available: false,
        reason: error instanceof Error ? error.message : String(error)
      }
    }

    const rules = readRules(a.id, a.rulesTemplate ?? '')

    info.push({
      id: a.id,
      name: a.name,
      description: a.description,
      available: status.available,
      reason: status.reason,
      rules: {
        supported: a.rulesTemplate !== undefined,
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

/** Abre el `.md` de reglas del agente, creándolo con su plantilla si no está. */
export async function openAgentRules(agentId: string): Promise<string> {
  const a = AGENTS.find((x) => x.id === agentId)
  if (a === undefined) throw new Error(`no conozco el agente "${agentId}"`)
  if (a.rulesTemplate === undefined) throw new Error(`${a.name} no usa archivo de reglas`)

  return await openRules(a.id, a.rulesTemplate)
}

/**
 * Las reglas como TEXTO, para pasárselas al agente cuando trabaja.
 *
 * Es el punto del archivo: lo que el usuario escriba ahí —aunque nadie lo haya
 * programado— le llega al modelo como contexto.
 */
export function agentRules(agentId: string): string {
  const a = AGENTS.find((x) => x.id === agentId)
  if (a?.rulesTemplate === undefined) return ''

  const r = readRules(a.id, '')
  const base = r.exists ? r.text : ''

  /*
   * Lo ya respondido va al final y con título propio.
   *
   * Ya está anexado al `.md`, así que técnicamente se repite. Se repite a
   * propósito: puesto al final y bajo un encabezado explícito, es lo último
   * que el agente lee antes de decidir, y son justo las reglas que nacieron de
   * una duda suya — las que más chance tienen de volver a hacer falta.
   */
  const previous = answered(agentId)
  if (previous.length === 0) return base

  const block = previous.map((p) => `- ${p.question} → ${p.answer}`).join('\n')
  return `${base}\n\n## Ya me preguntaste esto y te respondí\n${block}\n`
}
