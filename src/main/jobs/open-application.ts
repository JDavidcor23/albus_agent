import type { BrowserWindow } from 'electron'
import type { BrowserPort } from '../core/jobs/ports'

/**
 * La postulación que quedó ABIERTA esperando al usuario.
 *
 * ## El agujero que tapa
 *
 * En modo `review`, `apply-runner.ts` llena el formulario, hace `browser.reveal()`
 * y retorna. El `browser` era una **const local**: al retornar, nadie se quedaba
 * con el handle. La ventana seguía viva pero **inalcanzable** — no había a qué
 * pedirle nada.
 *
 * Las dos consecuencias, y las dos las reportó el usuario:
 *
 * 1. *"sí manda, pero rellena estos datos"* no se podía cumplir: no hay ventana
 *    que rellenar.
 * 2. El agente contestaba *"¿cuál es el id de la vacante donde estás rellenando el
 *    formulario?"*. No era terquedad: su contexto tenía las vacantes EN PANTALLA y
 *    nada que dijera "hay una postulación de Monks abierta ahora mismo". Literal,
 *    no podía saberlo. Palabras del usuario: *"no está guardando la relación en
 *    cada sesión, no está referenciando la pregunta que me hace con la acción que
 *    estoy realizando"*.
 *
 * ## Una sola, a propósito
 *
 * No es un mapa de postulaciones abiertas. `core/jobs/chat.ts` ya explica por qué:
 * cada `apply` en `review` trae su ventana al frente, así que trece serían trece
 * ventanas peleándose el foco. Si hay una nueva, la anterior se cierra.
 *
 * ## Estado en memoria, y no se persiste
 *
 * Una ventana no sobrevive a cerrar la app, así que guardarla en disco sería
 * prometer un handle que al reabrir ya no existe. Lo que sí es durable —que la
 * vacante quedó llena sin enviar— ya está en Notion y en el tracker.
 */

export interface OpenApplicationJob {
  /** El id de la vacante, el mismo que el agente ve en pantalla. */
  id: string
  company: string
  role: string
  url: string
}

interface OpenApplication {
  job: OpenApplicationJob
  page: BrowserPort
  window: BrowserWindow
  /** Etiquetas que quedaron sin responder. Es lo que el usuario suele venir a pedir. */
  unresolved: string[]
}

let current: OpenApplication | null = null

/**
 * Sigue viva la ventana? Un usuario que la cierra a mano deja el handle podrido, y
 * usarlo tira desde las profundidades de Electron con un error que no dice nada.
 */
function alive(app: OpenApplication | null): app is OpenApplication {
  if (app === null) return false
  try {
    return !app.window.isDestroyed()
  } catch {
    return false
  }
}

/**
 * Se registra la que quedó abierta. Cierra la anterior si había otra.
 *
 * Se llama SOLO cuando el formulario quedó lleno y sin enviar: es el único caso en
 * que la ventana tiene algo que el usuario todavía puede querer tocar.
 */
export function rememberOpenApplication(app: {
  job: OpenApplicationJob
  page: BrowserPort
  window: BrowserWindow
  unresolved: string[]
}): void {
  if (alive(current) && current.window !== app.window) {
    void current.page.close().catch(() => {
      // Cerrar la vieja es prolijidad, no un requisito: si falla, se reemplaza igual.
    })
  }

  current = app
  console.log(`[apply] queda abierta la postulación de ${app.job.company} — ${app.job.role}`)
}

/** La abierta, o `null` si no hay o si el usuario ya cerró la ventana. */
export function openApplication(): OpenApplication | null {
  if (!alive(current)) {
    current = null
    return null
  }
  return current
}

/**
 * Lo que el AGENTE necesita saber, sin el handle.
 *
 * El modelo no recibe objetos con métodos: recibe texto. Y esto es lo que le
 * faltaba para no preguntar de qué vacante le están hablando.
 */
export function openApplicationForAgent(): {
  id: string
  company: string
  role: string
  url: string
  unresolved: string[]
} | null {
  const app = openApplication()
  if (app === null) return null

  return {
    id: app.job.id,
    company: app.job.company,
    role: app.job.role,
    url: app.job.url,
    unresolved: app.unresolved
  }
}

/** Se olvida sin cerrar nada. Para cuando el envío ya se confirmó. */
export function forgetOpenApplication(): void {
  current = null
}
