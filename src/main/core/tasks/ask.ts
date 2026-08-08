import type { Task } from './types'

/**
 * Interpreta lo que el usuario escribió en el chat.
 *
 * Función PURA: recibe el texto y los pendientes, devuelve qué hacer. No toca
 * red, base ni CLI — por eso se puede probar sin levantar nada.
 *
 * Por qué esto NO le pregunta a un modelo: "¿qué tengo pendiente?" es una
 * CONSULTA, no una conversación. Resolverla con IA sería pagar cuota y esperar
 * segundos para ejecutar el equivalente a un SELECT. El modelo se guarda para
 * lo que una regla no puede — que en este chat, todavía, no es nada.
 */

export type Intent =
  | { kind: 'tasks' }
  /** Cerrar uno concreto: ya se resolvió a cuál se refiere. */
  | { kind: 'close'; taskId: string; asDismissed: boolean }
  /** Dijo "ya hice X" pero X matchea con varios (o con ninguno). */
  | { kind: 'ambiguous'; candidates: Task[]; term: string }
  | { kind: 'help' }

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

const WANTS_TASKS =
  /\b(pendiente|pendientes|que me falta|que tengo que|que hago|todo|tareas|tarea|deberes)\b/

/**
 * En español el marcador de "ya está hecho" es **"ya"**, no un verbo concreto:
 * "ya me postulé", "ya usé el QR", "ya fui", "ya pagué". La primera versión
 * listaba verbos ("ya hice", "listo", "terminé") y se perdía todo lo demás —
 * "ya me postulé" caía en ayuda.
 */
const SAYS_DONE =
  /\bya\b|\b(hecho|listo|termine|complete|cerra|cerrar|marca|marcar|resolvi|resuelto)\b/

const SAYS_DROP = /\b(no va|descarta|descartar|ignora|ignorar|no me interesa|olvidalo)\b/

/**
 * "Todavía no lo hice" contiene "hice" y "no": sin esta guarda cerraría una
 * tarea justo cuando el usuario dice lo contrario. Cerrar de más es el peor
 * error posible acá — el pendiente desaparece y él cree que lo resolvió.
 */
const NEGATED = /\b(todavia no|aun no|no lo hice|no he|nunca|falta)\b/

/**
 * Palabras del mensaje que sirven para buscar, sin las de relleno.
 * Sin esto, "ya hice lo de los cursos" matchearía cualquier task por el "lo".
 */
const FILLER = new Set([
  'ya', 'lo', 'la', 'el', 'los', 'las', 'de', 'del', 'que', 'hice', 'hecho',
  'listo', 'termine', 'complete', 'cerra', 'cerrar', 'marca', 'marcar', 'como',
  'resolvi', 'resuelto', 'esto', 'eso', 'un', 'una', 'mi', 'me', 'a', 'en',
  'no', 'va', 'descarta', 'descartar', 'ignora', 'ignorar', 'y', 'con', 'para',
  // Verbos de acción genérica: son el "hice" de cada dominio, no el objeto.
  // Sin ellos acá, "ya usé el qr" puntuaba por el "use" escondido dentro de
  // "aws-user-group" en una URL, y cerraba la tarea equivocada.
  'usar', 'use', 'uso', 'usado', 'ver', 'vi', 'visto', 'ir', 'fui', 'hacer'
])

/**
 * Longitud mínima 2 y no 3: "qr" e "ia" son de dos letras y son justo los
 * términos que más discriminan en estos títulos.
 */
function termsOf(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= 2 && !FILLER.has(p))
}

/**
 * ¿El término aparece en el título?
 *
 * No alcanza con `includes`: el usuario escribe "postulé" y el título dice
 * "Postularme". No comparten substring pero sí la raíz. Se comparan prefijos
 * de al menos 5 caracteres, que es donde las conjugaciones del español todavía
 * coinciden ("postul-é" / "postul-arme").
 */
function appearsIn(title: string, term: string): boolean {
  if (title.includes(term)) return true
  if (term.length < 5) return false

  const stem = term.slice(0, 5)
  return title.split(/[^a-z0-9]+/).some((word) => word.startsWith(stem))
}

/** Cuántos términos del mensaje aparecen en el título de la tarea. */
function scoreOf(task: Task, terms: string[]): number {
  const title = normalize(task.title)
  return terms.filter((t) => appearsIn(title, t)).length
}

export function interpret(message: string, openTasks: Task[]): Intent {
  const text = normalize(message)
  if (text.length === 0) return { kind: 'help' }

  // La negación gana sobre cualquier marcador de completado.
  const negated = NEGATED.test(text)
  const wantsClose = !negated && SAYS_DONE.test(text)
  const wantsDrop = !negated && SAYS_DROP.test(text)

  if (wantsClose || wantsDrop) {
    const terms = termsOf(message)

    // "listo" a secas no alcanza para cerrar nada: no dice QUÉ.
    if (terms.length === 0) {
      return { kind: 'ambiguous', candidates: openTasks, term: '' }
    }

    const scored = openTasks
      .map((t) => ({ task: t, score: scoreOf(t, terms) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)

    if (scored.length === 0) {
      return { kind: 'ambiguous', candidates: [], term: terms.join(' ') }
    }

    // Solo cierra solo si hay UN ganador claro. Ante empate pregunta: cerrar la
    // tarea equivocada es peor que preguntar de más, porque el usuario cree que
    // resolvió algo que sigue abierto.
    const best = scored[0]
    const tied = scored.length > 1 && scored[1].score === best.score
    if (tied) {
      return {
        kind: 'ambiguous',
        candidates: scored.filter((x) => x.score === best.score).map((x) => x.task),
        term: terms.join(' ')
      }
    }

    return { kind: 'close', taskId: best.task.id, asDismissed: wantsDrop }
  }

  if (WANTS_TASKS.test(text)) return { kind: 'tasks' }

  return { kind: 'help' }
}

/** Texto de la respuesta. Separado de la decisión para poder probar cada uno. */
export function compose(intent: Intent, tasks: Task[]): string {
  switch (intent.kind) {
    case 'tasks':
      if (tasks.length === 0) return 'No te queda nada pendiente.'
      return `Tenés ${tasks.length} ${tasks.length === 1 ? 'cosa' : 'cosas'} pendientes:`

    case 'close': {
      const t = tasks.find((x) => x.id === intent.taskId)
      return intent.asDismissed
        ? `Descartado: "${t?.title ?? ''}".`
        : `Listo, lo tacho: "${t?.title ?? ''}".`
    }

    case 'ambiguous':
      if (intent.candidates.length === 0) {
        return intent.term.length > 0
          ? `No encontré ningún pendiente que hable de "${intent.term}".`
          : 'No tenés pendientes abiertos.'
      }
      return '¿Cuál de estos? Tocá el que corresponda:'

    case 'help':
      return (
        'Preguntame "¿qué tengo pendiente?" y te los listo. ' +
        'Para cerrar uno, decime "ya hice X" o tocá el botón de la tarjeta.'
      )
  }
}
