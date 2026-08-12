import type { BrowserWindow } from 'electron'

/**
 * CUÁL es la ventana de Albus. No "la primera que devuelva Electron".
 *
 * ## El bug que esto elimina
 *
 * `jobs.ipc.ts` mandaba los eventos de progreso así:
 *
 *     BrowserWindow.getAllWindows()[0]
 *
 * Y durante una postulación hay DOS ventanas: la app y la del navegador que llena
 * el formulario —que en modo `review` queda ABIERTA a propósito—. Esa segunda se
 * crea sin preload y con `sandbox: true`, así que no tiene `ipcRenderer`: un
 * `webContents.send` hacia ella **se descarta en silencio**.
 *
 * Resultado, y es el reclamo textual del usuario: *"la última vez me hizo una
 * pregunta y no me la mostraste en pantalla. Entonces yo me quedé como que, ajá,
 * ¿y qué hago?"*. El agente preguntaba, la pregunta viajaba a la página de Monks,
 * y el usuario miraba un chat que no decía nada. Después de esperar, la completó a
 * mano.
 *
 * Es el peor modo de falla que hay en un agente conversacional: rompe el turno.
 * El agente cumple su parte —pregunta— y la respuesta nunca llega, porque la
 * pregunta nunca se vio.
 *
 * ## Por qué un registro y no una heurística mejor
 *
 * Se podría filtrar por "la que tiene preload", o por título, o por la que no
 * pertenezca a la partición del scraper. Todas son formas de ADIVINAR cuál es la
 * ventana de la app. Quien la crea la conoce: `index.ts` la registra acá y el resto
 * la pide. Un dato, no una inferencia.
 */

let appWin: BrowserWindow | null = null

/** La registra quien la crea. Se llama una vez, desde `index.ts`. */
export function setAppWindow(win: BrowserWindow): void {
  appWin = win
  win.on('closed', () => {
    if (appWin === win) appWin = null
  })
}

/**
 * La ventana de la app, o `null` si no hay.
 *
 * `null` es un resultado normal —la app puede estar cerrándose, o correr headless
 * en un comando de terminal— y todos los llamadores lo tratan como "no hay a quién
 * avisarle", nunca como un error.
 */
export function appWindow(): BrowserWindow | null {
  if (appWin === null) return null
  try {
    return appWin.isDestroyed() ? null : appWin
  } catch {
    return null
  }
}
