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
  | { kind: 'pendientes' }
  /** Cerrar uno concreto: ya se resolvió a cuál se refiere. */
  | { kind: 'cerrar'; taskId: string; comoDismissed: boolean }
  /** Dijo "ya hice X" pero X matchea con varios (o con ninguno). */
  | { kind: 'ambiguo'; candidatos: Task[]; termino: string }
  | { kind: 'ayuda' }

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

const PIDE_PENDIENTES =
  /\b(pendiente|pendientes|que me falta|que tengo que|que hago|todo|tareas|tarea|deberes)\b/

/**
 * En español el marcador de "ya está hecho" es **"ya"**, no un verbo concreto:
 * "ya me postulé", "ya usé el QR", "ya fui", "ya pagué". La primera versión
 * listaba verbos ("ya hice", "listo", "terminé") y se perdía todo lo demás —
 * "ya me postulé" caía en ayuda.
 */
const DICE_HECHO =
  /\bya\b|\b(hecho|listo|termine|complete|cerra|cerrar|marca|marcar|resolvi|resuelto)\b/

const DICE_NO_VA = /\b(no va|descarta|descartar|ignora|ignorar|no me interesa|olvidalo)\b/

/**
 * "Todavía no lo hice" contiene "hice" y "no": sin esta guarda cerraría una
 * tarea justo cuando el usuario dice lo contrario. Cerrar de más es el peor
 * error posible acá — el pendiente desaparece y él cree que lo resolvió.
 */
const NEGADO = /\b(todavia no|aun no|no lo hice|no he|nunca|falta)\b/

/**
 * Palabras del mensaje que sirven para buscar, sin las de relleno.
 * Sin esto, "ya hice lo de los cursos" matchearía cualquier task por el "lo".
 */
const RELLENO = new Set([
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
function terminosDe(texto: string): string[] {
  return normalizar(texto)
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= 2 && !RELLENO.has(p))
}

/**
 * ¿El término aparece en el título?
 *
 * No alcanza con `includes`: el usuario escribe "postulé" y el título dice
 * "Postularme". No comparten substring pero sí la raíz. Se comparan prefijos
 * de al menos 5 caracteres, que es donde las conjugaciones del español todavía
 * coinciden ("postul-é" / "postul-arme").
 */
function apareceEn(titulo: string, termino: string): boolean {
  if (titulo.includes(termino)) return true
  if (termino.length < 5) return false

  const raiz = termino.slice(0, 5)
  return titulo.split(/[^a-z0-9]+/).some((palabra) => palabra.startsWith(raiz))
}

/** Cuántos términos del mensaje aparecen en el título de la tarea. */
function puntaje(task: Task, terminos: string[]): number {
  const titulo = normalizar(task.title)
  return terminos.filter((t) => apareceEn(titulo, t)).length
}

export function interpretar(mensaje: string, abiertos: Task[]): Intent {
  const texto = normalizar(mensaje)
  if (texto.length === 0) return { kind: 'ayuda' }

  // La negación gana sobre cualquier marcador de completado.
  const negado = NEGADO.test(texto)
  const quiereCerrar = !negado && DICE_HECHO.test(texto)
  const quiereDescartar = !negado && DICE_NO_VA.test(texto)

  if (quiereCerrar || quiereDescartar) {
    const terminos = terminosDe(mensaje)

    // "listo" a secas no alcanza para cerrar nada: no dice QUÉ.
    if (terminos.length === 0) {
      return { kind: 'ambiguo', candidatos: abiertos, termino: '' }
    }

    const conPuntaje = abiertos
      .map((t) => ({ task: t, score: puntaje(t, terminos) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)

    if (conPuntaje.length === 0) {
      return { kind: 'ambiguo', candidatos: [], termino: terminos.join(' ') }
    }

    // Solo cierra solo si hay UN ganador claro. Ante empate pregunta: cerrar la
    // tarea equivocada es peor que preguntar de más, porque el usuario cree que
    // resolvió algo que sigue abierto.
    const mejor = conPuntaje[0]
    const hayEmpate = conPuntaje.length > 1 && conPuntaje[1].score === mejor.score
    if (hayEmpate) {
      return {
        kind: 'ambiguo',
        candidatos: conPuntaje.filter((x) => x.score === mejor.score).map((x) => x.task),
        termino: terminos.join(' ')
      }
    }

    return { kind: 'cerrar', taskId: mejor.task.id, comoDismissed: quiereDescartar }
  }

  if (PIDE_PENDIENTES.test(texto)) return { kind: 'pendientes' }

  return { kind: 'ayuda' }
}

/** Texto de la respuesta. Separado de la decisión para poder probar cada uno. */
export function redactar(intent: Intent, tasks: Task[]): string {
  switch (intent.kind) {
    case 'pendientes':
      if (tasks.length === 0) return 'No te queda nada pendiente.'
      return `Tenés ${tasks.length} ${tasks.length === 1 ? 'cosa' : 'cosas'} pendientes:`

    case 'cerrar': {
      const t = tasks.find((x) => x.id === intent.taskId)
      return intent.comoDismissed
        ? `Descartado: "${t?.title ?? ''}".`
        : `Listo, lo tacho: "${t?.title ?? ''}".`
    }

    case 'ambiguo':
      if (intent.candidatos.length === 0) {
        return intent.termino.length > 0
          ? `No encontré ningún pendiente que hable de "${intent.termino}".`
          : 'No tenés pendientes abiertos.'
      }
      return '¿Cuál de estos? Tocá el que corresponda:'

    case 'ayuda':
      return (
        'Preguntame "¿qué tengo pendiente?" y te los listo. ' +
        'Para cerrar uno, decime "ya hice X" o tocá el botón de la tarjeta.'
      )
  }
}
