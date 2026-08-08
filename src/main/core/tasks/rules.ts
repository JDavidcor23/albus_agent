import type { DetectedTask, TaskCandidate } from './types'
import { isEncrypted, labelOf, identityOf } from './qr-identity'

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
function isContact(payload: Record<string, unknown>): boolean {
  const profiles = payload.profiles
  return Array.isArray(profiles) && profiles.length > 0
}

/** Los codes del payload de un QR, como texto plano y estable. */
function codesOf(payload: Record<string, unknown>): string[] {
  const codes = payload.codes
  if (!Array.isArray(codes)) return []
  return codes.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
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
 */
function encryptedTitle(body: string): string {
  const note = truncate(body, 70)
  return note.length > 0 ? `Usar el QR de: ${note}` : 'Usar el código QR de esta nota'
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
export function deterministicTasks(candidate: TaskCandidate): DetectedTask[] {
  const seen = new Set<string>()
  const out: DetectedTask[] = []

  for (const a of candidate.attachments) {
    if (a.kind !== 'qr') continue
    if (isContact(a.payload)) continue

    for (const code of codesOf(a.payload)) {
      const identity = identityOf(code)
      if (seen.has(identity)) continue
      seen.add(identity)

      const label = labelOf(code)
      const encrypted = isEncrypted(code)

      out.push({
        title: label !== null ? `Usar el QR de ${label}` : encryptedTitle(candidate.body),

        // Sin volcado de datos: el título ya dice qué es, y el ciphertext no le
        // dice nada a nadie. Para un QR cifrado se explica POR QUÉ no hay más —
        // si no, parece que falta información cuando en realidad no existe.
        detail: encrypted ? 'QR cifrado: solo lo puede leer la app del organizador.' : null,

        // Solo los legibles deduplican entre notas distintas. La identidad de un
        // cifrado es una constante: hacerla única por usuario dejaría al usuario
        // con un solo pendiente de entrada de evento para siempre.
        dedupeKey: encrypted ? null : identity,

        // 1.0 y no menos: no es una inferencia sobre la que se pueda dudar,
        // es la regla que pidió el usuario.
        confidence: 1
      })
    }
  }

  return out
}

/** Títulos ya cubiertos por una regla, para que el modelo no los repita. */
export function deterministicTitles(tasks: DetectedTask[]): Set<string> {
  return new Set(tasks.map((t) => t.title.toLowerCase()))
}
