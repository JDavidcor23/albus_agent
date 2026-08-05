import type { DetectedTask, TaskCandidate } from './types'
import { esCifrado, etiquetaDe, identidadDe } from './qr-identity'
import { fechaLimiteDe } from './due-date'
import { fusionarCapturas } from '../extraction/clean-ocr'

/**
 * Pendientes que se deciden por REGLA, sin preguntarle a ningún modelo.
 *
 * Todo lo que se pueda resolver acá no gasta cuota y no depende de que el CLI
 * esté vivo. Mismo criterio que la cascada de extracción: lo barato primero.
 *
 * Hoy hay una sola regla y viene del usuario:
 *
 *   "Si te paso un QR y no lo he escaneado aún, tienes que marcarme como
 *    pendiente. Explícitamente yo te tengo que decir: márcalo como resuelto."
 *
 * O sea: un QR es una acción que todavía no tomaste. Nace pendiente y solo se
 * cierra a mano. Eso NO es una inferencia — es una regla, y las reglas van en
 * código.
 *
 * Qué ES un QR y cuándo dos son el mismo vive en `qr-identity.ts`. Acá solo se
 * decide qué pendiente escribir.
 */

/** Un QR de LinkedIn no es una acción: es un contacto. Ese lo maneja el modelo. */
function esContacto(payload: Record<string, unknown>): boolean {
  const profiles = payload.profiles
  return Array.isArray(profiles) && profiles.length > 0
}

/** Los codes del payload de un QR, como texto plano y estable. */
function codigosDe(payload: Record<string, unknown>): string[] {
  const codes = payload.codes
  if (!Array.isArray(codes)) return []
  return codes.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
}

function recortar(texto: string, max: number): string {
  const limpio = texto.replace(/\s+/g, ' ').trim()
  return limpio.length > max ? `${limpio.slice(0, max)}…` : limpio
}

/**
 * El título de un QR cifrado sale de la NOTA, y sin ningún discriminador.
 *
 * La versión anterior le pegaba un hash del código (`(101v)`, `(1cp6)`) para que
 * dos QR de la misma nota no colisionaran. Era exactamente al revés: colisionar
 * es lo que hace que dos capturas de la misma entrada sean un solo pendiente.
 *
 * Sin nota tampoco hay hash. Si la identidad ya colapsó todos los cifrados de la
 * nota en uno, no hay con qué colisionar.
 *
 * Se le saca el "código QR" del principio: la nota decía "Código QR del evento de
 * cripto..." y el título salía "Usar el QR de: Código QR del evento..." — decía
 * QR dos veces en once caracteres.
 */
function tituloDeCifrado(body: string): string {
  const sinPrefijo = body.replace(/^\s*(?:c[óo]digo\s+)?qr\s*(?:de[l]?\s+)?/i, '')
  const nota = recortar(sinPrefijo, 70)
  return nota.length > 0 ? `Usar el QR del ${nota}` : 'Usar el código QR de esta nota'
}

/**
 * Pendientes deterministas de una entry.
 *
 * Deduplica por IDENTIDAD del código, no por adjunto ni por bytes:
 *
 *   - un QR legible se identifica por su URL normalizada, así que la misma
 *     pantalla fotografiada dos veces da un solo pendiente;
 *   - todos los QR cifrados de una nota comparten identidad y colapsan en uno,
 *     porque la sal hace imposible distinguirlos y son la misma entrada.
 *
 * En los datos reales había 5 adjuntos con QR, 3 códigos distintos y 2 eventos
 * repetidos. Con esto quedan 2 pendientes: el grupo de Meetup y la entrada.
 */
export function deterministicTasks(candidate: TaskCandidate, hoy: string): DetectedTask[] {
  const vistos = new Set<string>()
  const out: DetectedTask[] = []

  // La fecha se busca en la nota Y en el OCR de las capturas: la nota decía
  // "27 y 28 de agosto" y la captura del ticket, "26 Agosto: Business Day".
  // Gana la más temprana, que es cuando hay que tener la entrada a mano.
  //
  // El OCR va LIMPIO, y esto no es cosmético. Con el crudo, la línea
  // "/ No 1/4 ARE HERAT RE AENA NR NL Nags mr" — basura de una foto — se leyó
  // como el 1 de abril y mandó al tope de la lista un pendiente sin fecha real.
  // El mismo `esLegible` que decide si mostrarle el texto al usuario decide si
  // creerle una fecha: si no se puede leer, no se le cree.
  const ocrLimpio = fusionarCapturas(
    candidate.attachments
      .map((a) => (typeof a.payload.text === 'string' ? a.payload.text : ''))
      .filter((t) => t.length > 0)
  )
  const fecha = fechaLimiteDe(`${candidate.body}\n${ocrLimpio}`, hoy)

  for (const a of candidate.attachments) {
    if (a.kind !== 'qr') continue
    if (esContacto(a.payload)) continue

    for (const code of codigosDe(a.payload)) {
      const identidad = identidadDe(code)
      if (vistos.has(identidad)) continue
      vistos.add(identidad)

      const etiqueta = etiquetaDe(code)
      const cifrado = esCifrado(code)

      out.push({
        title: etiqueta !== null ? `Usar el QR de ${etiqueta}` : tituloDeCifrado(candidate.body),

        // Sin volcado de datos: el título ya dice qué es, y el ciphertext no le
        // dice nada a nadie. Para un QR cifrado se explica POR QUÉ no hay más —
        // si no, parece que falta información cuando en realidad no existe.
        //
        // Corto a propósito: la tarjeta corta el subtítulo a ~44 caracteres, y la
        // versión anterior ("...solo lo puede leer la app del organizador.") se
        // cortaba justo en "del …", que es peor que no decir nada.
        detail: cifrado ? 'cifrado, lo lee la app del organizador' : null,

        dueDate: fecha,

        // Solo los legibles deduplican entre notas distintas. La identidad de un
        // cifrado es una constante: hacerla única por usuario dejaría al usuario
        // con un solo pendiente de entrada de evento para siempre.
        dedupeKey: cifrado ? null : identidad,

        // 1.0 y no menos: no es una inferencia sobre la que se pueda dudar,
        // es la regla que pidió el usuario.
        confidence: 1
      })
    }
  }

  return out
}

/** Títulos ya cubiertos por una regla, para que el modelo no los repita. */
export function titulosDeterministas(tasks: DetectedTask[]): Set<string> {
  return new Set(tasks.map((t) => t.title.toLowerCase()))
}
