import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { carpetaAgentes } from '../paths'
import { rutaReglas } from './rules'

/**
 * Las preguntas del agente, y cómo una respuesta se vuelve regla.
 *
 * ## El problema
 *
 * El usuario escribe reglas, pero nunca las va a escribir todas: *"se me
 * olvidó poner algo, como si el agente me pregunta ¿qué formato quieres que
 * guarde los archivos? ¿el mismo nombre o le cambio?"*. Y esas dudas aparecen
 * a las 7 de la mañana, cuando no hay nadie mirando.
 *
 * ## La forma
 *
 * El agente **no inventa** cuando duda: encola la pregunta y sigue con lo que
 * sí puede. Después el usuario contesta en la app, y la respuesta se **anexa
 * al `.md` de reglas** como una regla más.
 *
 * Eso es todo el mecanismo de aprendizaje, y es a propósito que sea tan
 * aburrido: la memoria del agente es un archivo de texto que el usuario puede
 * abrir, leer, corregir y borrar. Una "memoria" que solo el programa entiende
 * es una que el usuario no puede auditar el día que el agente haga algo raro.
 *
 * ## Por qué NO se responde en el chat
 *
 * Porque la respuesta se perdería. Contestada acá, queda en el archivo y vale
 * para siempre — incluso para la corrida de mañana a las 7, con el usuario
 * durmiendo.
 */

export interface PreguntaAgente {
  id: string
  /** La pregunta, en castellano. */
  pregunta: string
  /**
   * Dónde apareció la duda: la vacante, el campo, la pantalla.
   * Sin esto, "¿qué nombre le pongo?" es incontestable dos días después.
   */
  contexto: string
  /** ISO. Se pasa desde afuera: acá no se inventan relojes. */
  creada: string
  /** Opciones sugeridas, si el agente las tiene. No obligan. */
  opciones: string[]
  /** La respuesta del usuario. `null` mientras esté pendiente. */
  respuesta: string | null
  respondida: string | null
}

const PreguntaSchema = z.object({
  id: z.string(),
  pregunta: z.string(),
  contexto: z.string().default(''),
  creada: z.string(),
  opciones: z.array(z.string()).default([]),
  respuesta: z.string().nullable().default(null),
  respondida: z.string().nullable().default(null)
})

/** El archivo es JSON y no markdown: esto es una COLA, no algo que se edite. */
function rutaPreguntas(agenteId: string): string {
  const limpio = agenteId.replace(/[^a-z0-9-]/gi, '')
  return join(carpetaAgentes(), `${limpio}.preguntas.json`)
}

export function leerPreguntas(agenteId: string): PreguntaAgente[] {
  const ruta = rutaPreguntas(agenteId)
  if (!existsSync(ruta)) return []

  try {
    const crudo: unknown = JSON.parse(readFileSync(ruta, 'utf8'))
    if (!Array.isArray(crudo)) return []

    // Fila por fila, como todo lo que viene de afuera: una pregunta corrupta
    // no puede hacer que se pierdan las otras nueve.
    const salida: PreguntaAgente[] = []
    for (const item of crudo) {
      const p = PreguntaSchema.safeParse(item)
      if (p.success) salida.push(p.data)
    }
    return salida
  } catch {
    console.warn(`[preguntas] ${ruta} no se pudo leer, lo ignoro`)
    return []
  }
}

function escribirPreguntas(agenteId: string, lista: PreguntaAgente[]): void {
  const ruta = rutaPreguntas(agenteId)
  mkdirSync(dirname(ruta), { recursive: true })
  writeFileSync(ruta, JSON.stringify(lista, null, 2), 'utf8')
}

/**
 * El agente pregunta. `ahora` entra por parámetro para que los chequeos sean
 * deterministas y para no esconder un reloj adentro del dominio.
 */
export function encolarPregunta(
  agenteId: string,
  pregunta: string,
  opciones: { contexto?: string; opciones?: string[]; ahora?: string } = {}
): PreguntaAgente {
  const lista = leerPreguntas(agenteId)
  const texto = pregunta.trim()

  /*
   * La misma duda dos veces es UNA pregunta.
   *
   * Si no, veinte postulaciones seguidas con el mismo campo sin resolver
   * generan veinte preguntas idénticas y el usuario abandona el panel — que es
   * la forma más rápida de que este mecanismo no sirva para nada.
   */
  const ya = lista.find((p) => p.respuesta === null && p.pregunta.trim() === texto)
  if (ya !== undefined) return ya

  const nueva: PreguntaAgente = {
    id: `q${lista.length + 1}-${texto.slice(0, 12).replace(/\W+/g, '')}`,
    pregunta: texto,
    contexto: opciones.contexto ?? '',
    creada: opciones.ahora ?? new Date().toISOString(),
    opciones: opciones.opciones ?? [],
    respuesta: null,
    respondida: null
  }

  lista.push(nueva)
  escribirPreguntas(agenteId, lista)
  console.log(`[preguntas] ${agenteId}: ${texto}`)
  return nueva
}

/** Lo que se le anexa al `.md`. Separado para poder verificarlo sin tocar disco. */
export function bloqueDeRespuesta(pregunta: string, respuesta: string, cuando: string): string {
  const fecha = cuando.slice(0, 10)
  return `\n- ${respuesta.trim()}  <!-- respondiste el ${fecha} a: ${pregunta.trim()} -->\n`
}

const TITULO_SECCION = '## Respuestas a lo que el agente preguntó'

/**
 * Responder = escribir una regla.
 *
 * La respuesta se anexa al `.md` bajo su propia sección, con la pregunta
 * original en un comentario. El comentario no cuenta como regla —el parser
 * saltea `<!-- -->`— pero está ahí para cuando el usuario relea el archivo en
 * marzo y no se acuerde por qué escribió eso.
 */
export function responderPregunta(
  agenteId: string,
  preguntaId: string,
  respuesta: string,
  ahora = new Date().toISOString()
): PreguntaAgente | null {
  const lista = leerPreguntas(agenteId)
  const p = lista.find((x) => x.id === preguntaId)
  if (p === undefined) return null

  p.respuesta = respuesta.trim()
  p.respondida = ahora
  escribirPreguntas(agenteId, lista)

  const ruta = rutaReglas(agenteId)
  mkdirSync(dirname(ruta), { recursive: true })

  const actual = existsSync(ruta) ? readFileSync(ruta, 'utf8') : ''
  const bloque = bloqueDeRespuesta(p.pregunta, p.respuesta, ahora)

  if (actual.includes(TITULO_SECCION)) {
    appendFileSync(ruta, bloque, 'utf8')
  } else {
    appendFileSync(ruta, `\n\n${TITULO_SECCION}\n${bloque}`, 'utf8')
  }

  console.log(`[preguntas] ${agenteId}: respondida "${p.pregunta}" → regla nueva`)
  return p
}

/** Las que siguen esperando. Es lo que la UI muestra. */
export function pendientes(agenteId: string): PreguntaAgente[] {
  return leerPreguntas(agenteId).filter((p) => p.respuesta === null)
}

/**
 * Lo ya respondido, para el prompt del agente.
 *
 * Va aparte del `.md` completo por una razón práctica: cuando el agente vuelve
 * a dudar de algo parecido, esto es lo que hay que ponerle adelante.
 */
export function respondidas(agenteId: string): { pregunta: string; respuesta: string }[] {
  return leerPreguntas(agenteId)
    .filter((p) => p.respuesta !== null)
    .map((p) => ({ pregunta: p.pregunta, respuesta: p.respuesta as string }))
}
