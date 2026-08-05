import type { DetectedTask, TaskCandidate } from './types'

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

/**
 * Un QR cifrado no se puede mostrar: no le dice nada a nadie.
 * `U2FsdGVkX1` es el base64 de "Salted__", la firma de OpenSSL — así vienen las
 * entradas de evento, que solo sirven escaneadas por la app del organizador.
 */
function esIlegible(code: string): boolean {
  return code.startsWith('U2FsdGVkX1') || !/^[\x20-\x7E]+$/.test(code)
}

/** Discriminador corto y estable. Sin esto dos QR de la misma nota colisionan. */
function sufijo(code: string): string {
  let h = 0
  for (let i = 0; i < code.length; i++) h = (Math.imul(31, h) + code.charCodeAt(i)) | 0
  return (h >>> 0).toString(36).slice(0, 4)
}

function recortar(texto: string, max: number): string {
  const limpio = texto.replace(/\s+/g, ' ').trim()
  return limpio.length > max ? `${limpio.slice(0, max)}…` : limpio
}

/**
 * El título sale del CÓDIGO cuando se puede leer, y recién si no, de la nota.
 *
 * Al revés no sirve: el QR de meetup lleva la URL del grupo — eso es específico y
 * accionable. La nota de esa misma captura decía "Screenshots fotos y videos de
 * aws serverless día también hay links de linkedin...", que como título es ruido.
 */
function etiquetaDe(code: string, contexto: string): string {
  if (!esIlegible(code)) return recortar(code, 80)

  const nota = recortar(contexto, 60)
  // Cifrado: la nota es lo único que hay, más un sufijo para no colisionar con
  // el otro QR de la misma nota.
  return nota.length > 0 ? `${nota} (${sufijo(code)})` : `código QR ${sufijo(code)}`
}

/**
 * Pendientes deterministas de una entry.
 *
 * Deduplica por CONTENIDO del QR, no por adjunto: la misma pantalla fotografiada
 * dos veces es una sola cosa por hacer. En los datos reales había 5 adjuntos con
 * QR y solo 3 payloads distintos — sin deduplicar arrancabas con dos tareas
 * repetidas el primer día.
 */
export function deterministicTasks(candidate: TaskCandidate): DetectedTask[] {
  const vistos = new Set<string>()
  const out: DetectedTask[] = []

  for (const a of candidate.attachments) {
    if (a.kind !== 'qr') continue
    if (esContacto(a.payload)) continue

    for (const code of codigosDe(a.payload)) {
      if (vistos.has(code)) continue
      vistos.add(code)

      out.push({
        title: `Usar el QR de: ${etiquetaDe(code, candidate.body)}`,
        detail: esIlegible(code) ? candidate.body.trim() || null : code,
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
