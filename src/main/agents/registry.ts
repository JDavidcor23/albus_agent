import type { AgentInfo } from '../../shared/ipc'
import { abrirReglas, leerReglas } from './rules'
import { pendientes, respondidas } from './questions'
import { hasLinkedInSession } from '../browser/session'
import { isNotionConfigured } from '../notion/client'
import { tieneScopeGmail } from '../gmail/send'
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
  nombre: string
  descripcion: string
  /** Chequea sus propias dependencias. Nunca tira: devuelve el motivo. */
  chequear: () => Promise<{ disponible: boolean; motivo: string }>
  /**
   * El `.md` que el usuario edita para decirle a este agente qué mirar.
   *
   * Es una PLANTILLA, no una configuración: se escribe una vez si el archivo
   * no existe y después manda lo que el usuario ponga. Agregar una regla nueva
   * es escribir una línea ahí, no construir una pantalla — que es la razón por
   * la que esto existe en vez de un formulario.
   */
  plantillaReglas?: string
}

/**
 * La plantilla del agente de trabajo.
 *
 * Los links van comentados con `<!--` a propósito: el parser saltea esas
 * líneas, así que la plantilla NO se autoconfigura con un ejemplo. El usuario
 * pega los suyos y recién ahí empiezan a contar.
 */
const REGLAS_JOB_SEARCH = `# Búsqueda de trabajo — reglas

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

export const AGENTES: AgentDefinition[] = [
  {
    id: 'job-search',
    nombre: 'Búsqueda de trabajo',
    descripcion: 'Busca vacantes, las puntúa contra tu perfil, se postula y actualiza Notion.',
    plantillaReglas: REGLAS_JOB_SEARCH,
    async chequear() {
      const faltan: string[] = []

      try {
        await loadProfile(true)
      } catch (error: unknown) {
        return {
          disponible: false,
          motivo: error instanceof Error ? error.message : String(error)
        }
      }

      if (!(await hasLinkedInSession())) faltan.push('LinkedIn')
      if (!isNotionConfigured()) faltan.push('Notion')

      try {
        if (!(await tieneScopeGmail()).ok) faltan.push('Google')
      } catch {
        faltan.push('Google')
      }

      // Falta algo pero igual está disponible: sin Notion se puede buscar y
      // postular, solo que no se espeja. Apagarlo entero sería exagerado.
      return {
        disponible: true,
        motivo: faltan.length > 0 ? `sin conectar: ${faltan.join(' · ')}` : ''
      }
    }
  }
]

export async function listarAgentes(): Promise<AgentInfo[]> {
  const info: AgentInfo[] = []

  for (const a of AGENTES) {
    let estado: { disponible: boolean; motivo: string }
    try {
      estado = await a.chequear()
    } catch (error: unknown) {
      // Un agente que revienta al chequearse no puede tumbar la pestaña.
      estado = {
        disponible: false,
        motivo: error instanceof Error ? error.message : String(error)
      }
    }

    const reglas = leerReglas(a.id, a.plantillaReglas ?? '')

    info.push({
      id: a.id,
      nombre: a.nombre,
      descripcion: a.descripcion,
      disponible: estado.disponible,
      motivo: estado.motivo,
      reglas: {
        soporta: a.plantillaReglas !== undefined,
        existe: reglas.existe,
        ruta: reglas.ruta,
        preguntas: pendientes(a.id).map((p) => ({
          id: p.id,
          pregunta: p.pregunta,
          contexto: p.contexto,
          creada: p.creada,
          opciones: p.opciones
        })),
        // Lo que el usuario escribió, en sus palabras. Es lo que se muestra.
        resumen: reglas.resumen,
        // Los links van igual, pero como dato secundario: sirven para saber si
        // el agente sabe a dónde escribir, no como resumen de las reglas.
        notion: reglas.notion.map((n) => ({ id: n.id, etiqueta: n.etiqueta })),
        drive: reglas.drive.map((d) => ({ id: d.id, etiqueta: d.etiqueta }))
      }
    })
  }

  return info
}

/** Abre el `.md` de reglas del agente, creándolo con su plantilla si no está. */
export async function abrirReglasDeAgente(agenteId: string): Promise<string> {
  const a = AGENTES.find((x) => x.id === agenteId)
  if (a === undefined) throw new Error(`no conozco el agente "${agenteId}"`)
  if (a.plantillaReglas === undefined) throw new Error(`${a.nombre} no usa archivo de reglas`)

  return await abrirReglas(a.id, a.plantillaReglas)
}

/**
 * Las reglas como TEXTO, para pasárselas al agente cuando trabaja.
 *
 * Es el punto del archivo: lo que el usuario escriba ahí —aunque nadie lo haya
 * programado— le llega al modelo como contexto.
 */
export function reglasDeAgente(agenteId: string): string {
  const a = AGENTES.find((x) => x.id === agenteId)
  if (a?.plantillaReglas === undefined) return ''

  const r = leerReglas(a.id, '')
  const base = r.existe ? r.texto : ''

  /*
   * Lo ya respondido va al final y con título propio.
   *
   * Ya está anexado al `.md`, así que técnicamente se repite. Se repite a
   * propósito: puesto al final y bajo un encabezado explícito, es lo último
   * que el agente lee antes de decidir, y son justo las reglas que nacieron de
   * una duda suya — las que más chance tienen de volver a hacer falta.
   */
  const previas = respondidas(agenteId)
  if (previas.length === 0) return base

  const bloque = previas.map((p) => `- ${p.pregunta} → ${p.respuesta}`).join('\n')
  return `${base}\n\n## Ya me preguntaste esto y te respondí\n${bloque}\n`
}
