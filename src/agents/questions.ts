import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { agentsDir } from '../paths'
import { rulesPath } from './rules'

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
 *
 * ## Las claves del disco son un contrato
 *
 * Lo que está en `<id>.preguntas.json` en la máquina del usuario tiene las
 * claves en castellano —`pregunta`, `contexto`, `creada`, `opciones`,
 * `respuesta`, `respondida`— y **no se tocan**: renombrarlas no rompe el
 * typecheck, simplemente deja huérfana la cola que el usuario ya tiene.
 */

/** Lo que está EN EL DISCO. Claves en castellano: contrato con el archivo. */
export interface StoredQuestion {
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

const StoredQuestionSchema = z.object({
  id: z.string(),
  pregunta: z.string(),
  contexto: z.string().default(''),
  creada: z.string(),
  opciones: z.array(z.string()).default([]),
  respuesta: z.string().nullable().default(null),
  respondida: z.string().nullable().default(null)
})

/** El archivo es JSON y no markdown: esto es una COLA, no algo que se edite. */
function questionsPath(agentId: string): string {
  const clean = agentId.replace(/[^a-z0-9-]/gi, '')
  return join(agentsDir(), `${clean}.preguntas.json`)
}

export function readQuestions(agentId: string): StoredQuestion[] {
  const path = questionsPath(agentId)
  if (!existsSync(path)) return []

  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(raw)) return []

    // Fila por fila, como todo lo que viene de afuera: una pregunta corrupta
    // no puede hacer que se pierdan las otras nueve.
    const output: StoredQuestion[] = []
    for (const item of raw) {
      const p = StoredQuestionSchema.safeParse(item)
      if (p.success) output.push(p.data)
    }
    return output
  } catch {
    console.warn(`[preguntas] ${path} no se pudo leer, lo ignoro`)
    return []
  }
}

function writeQuestions(agentId: string, list: StoredQuestion[]): void {
  const path = questionsPath(agentId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(list, null, 2), 'utf8')
}

/**
 * El agente pregunta. `now` entra por parámetro para que los chequeos sean
 * deterministas y para no esconder un reloj adentro del dominio.
 */
export function enqueueQuestion(
  agentId: string,
  question: string,
  opts: { context?: string; options?: string[]; now?: string } = {}
): StoredQuestion {
  const list = readQuestions(agentId)
  const text = question.trim()

  /*
   * La misma duda dos veces es UNA pregunta.
   *
   * Si no, veinte postulaciones seguidas con el mismo campo sin resolver
   * generan veinte preguntas idénticas y el usuario abandona el panel — que es
   * la forma más rápida de que este mecanismo no sirva para nada.
   */
  const already = list.find((p) => p.respuesta === null && p.pregunta.trim() === text)
  if (already !== undefined) return already

  const next: StoredQuestion = {
    id: `q${list.length + 1}-${text.slice(0, 12).replace(/\W+/g, '')}`,
    pregunta: text,
    contexto: opts.context ?? '',
    creada: opts.now ?? new Date().toISOString(),
    opciones: opts.options ?? [],
    respuesta: null,
    respondida: null
  }

  list.push(next)
  writeQuestions(agentId, list)
  console.log(`[preguntas] ${agentId}: ${text}`)
  return next
}

/** Lo que se le anexa al `.md`. Separado para poder verificarlo sin tocar disco. */
export function answerBlock(question: string, answer: string, when: string): string {
  const date = when.slice(0, 10)
  return `\n- ${answer.trim()}  <!-- respondiste el ${date} a: ${question.trim()} -->\n`
}

const ANSWERS_SECTION_HEADING = '## Respuestas a lo que el agente preguntó'

/**
 * Responder = escribir una regla.
 *
 * La respuesta se anexa al `.md` bajo su propia sección, con la pregunta
 * original en un comentario. El comentario no cuenta como regla —el parser
 * saltea `<!-- -->`— pero está ahí para cuando el usuario relea el archivo en
 * marzo y no se acuerde por qué escribió eso.
 */
export function answerQuestion(
  agentId: string,
  questionId: string,
  answer: string,
  now = new Date().toISOString()
): StoredQuestion | null {
  const list = readQuestions(agentId)
  const p = list.find((x) => x.id === questionId)
  if (p === undefined) return null

  p.respuesta = answer.trim()
  p.respondida = now
  writeQuestions(agentId, list)

  const path = rulesPath(agentId)
  mkdirSync(dirname(path), { recursive: true })

  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const block = answerBlock(p.pregunta, p.respuesta, now)

  if (current.includes(ANSWERS_SECTION_HEADING)) {
    appendFileSync(path, block, 'utf8')
  } else {
    appendFileSync(path, `\n\n${ANSWERS_SECTION_HEADING}\n${block}`, 'utf8')
  }

  console.log(`[preguntas] ${agentId}: respondida "${p.pregunta}" → regla nueva`)
  return p
}

/** Las que siguen esperando. Es lo que la UI muestra. */
export function pending(agentId: string): StoredQuestion[] {
  return readQuestions(agentId).filter((p) => p.respuesta === null)
}

/**
 * Lo ya respondido, para el prompt del agente.
 *
 * Va aparte del `.md` completo por una razón práctica: cuando el agente vuelve
 * a dudar de algo parecido, esto es lo que hay que ponerle adelante.
 */
export function answered(agentId: string): { question: string; answer: string }[] {
  return readQuestions(agentId)
    .filter((p) => p.respuesta !== null)
    .map((p) => ({ question: p.pregunta, answer: p.respuesta as string }))
}
