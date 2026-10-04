/**
 * Qué clase de cosa es cada fila del índice.
 *
 * ## Por qué esto existe
 *
 * `curriculum.ts` trataba todas las filas igual, y eso está mal. Una sección
 * del curso tiene cuatro cosas distintas y solo una tiene transcript:
 *
 * ```
 * 8. Traditional IT Overview            ▶ 6min      video
 * 12. [Important] AWS Console UI Update ▶ 1min      video, pero es una NOTA
 * Quiz 1: What is Cloud Computing Quiz  (sin tiempo) quiz
 * Role Play 1: Explaining AWS…          badge        role play
 * ```
 *
 * Mandar un quiz por el camino del video no falla ruidoso: falla con "no pude
 * leer el transcript", que suena a DOM cambiado y hace perder media hora
 * buscando un selector que estaba bien.
 *
 * ## Y por qué el quiz NO se saltea
 *
 * Es lo contrario: un quiz es lo más parecido al examen que hay en el curso.
 * Vale más que tres clases. Se clasifica aparte para poder guardarlo distinto,
 * no para descartarlo.
 */

export type ItemKind = 'video' | 'nota' | 'quiz' | 'roleplay' | 'otro'

/**
 * Las notas se marcan en el TÍTULO, no en el DOM.
 *
 * Maarek las nombra `[Important]`, `[NOTE]`, `[Note]`. Son lecciones cortas
 * —un minuto— que avisan de un cambio en la consola o una trampa del examen, y
 * casi todo su valor está en la pantalla, no en lo que dice. Por eso se
 * capturan aunque nadie señale nada.
 */
const NOTA = /^\[\s*(important|note|nota|update|aviso)\s*\]/i

const QUIZ = /^(quiz|cuestionario|practice test|examen de práctica)\b/i
const ROLEPLAY = /^(role\s*play|juego de rol)\b/i

/**
 * De qué tipo es esta fila.
 *
 * Decide por TEXTO y no por el ícono. El ícono es un `<svg>` con clases
 * generadas que cambian entre deploys —la apuesta que este repo ya perdió dos
 * veces—; el texto "Quiz 1:" es lo que el usuario lee, y si eso cambia cambió
 * el curso de verdad.
 *
 * `hasDuration` desempata el caso feo: un título que no dice nada y no tiene
 * duración no es una lección de video, sea lo que sea.
 */
export function classifyItem(title: string, hasDuration: boolean): ItemKind {
  const t = title.trim()

  if (QUIZ.test(t)) return 'quiz'
  if (ROLEPLAY.test(t)) return 'roleplay'
  if (NOTA.test(t)) return 'nota'
  return hasDuration ? 'video' : 'otro'
}

/**
 * ¿La fila declara una duración? `6min`, `1hr 23min`, `2:05`.
 *
 * Se mira en el texto COMPLETO de la fila y no solo en la primera línea: la
 * duración vive en un renglón aparte, que es justamente el renglón que
 * `parseLectureText` descarta para no ensuciar el título.
 */
export function hasDuration(rowText: string): boolean {
  return /\b\d+\s*(min|hr|hour|h)\b/i.test(rowText) || /\b\d{1,2}:\d{2}\b/.test(rowText)
}

/**
 * Lo que hay que bajar de cada tipo.
 *
 * Un `roleplay` es una conversación con un modelo: no hay texto fijo que
 * guardar, y fingir que sí produciría un archivo vacío que parece un bug. Se
 * reporta como salteado, que es la verdad.
 */
export function shouldCapture(kind: ItemKind): { transcript: boolean; screens: boolean } {
  switch (kind) {
    case 'video':
      return { transcript: true, screens: true }
    case 'nota':
      // Una nota dura un minuto y casi todo su valor está en la pantalla.
      return { transcript: true, screens: true }
    case 'quiz':
      // No tiene transcript. Lo que importa son las preguntas, que son texto.
      return { transcript: false, screens: true }
    default:
      return { transcript: false, screens: false }
  }
}
