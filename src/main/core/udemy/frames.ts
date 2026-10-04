/**
 * Cuándo dos frames son la MISMA slide, y cuándo cambió.
 *
 * ## Por qué esto reemplaza al "cada N segundos"
 *
 * El pedido original fue capturar cada cinco segundos. Es razonable de intuir
 * y está mal por un número: una clase de 6:29 da **78 capturas**, y como las
 * slides de Maarek duran entre treinta y sesenta segundos, unas setenta de esas
 * setenta y ocho son duplicados exactos. La máquina aguanta; el que no aguanta
 * es el que después tiene que mirar tres mil imágenes.
 *
 * Tampoco alcanzaba con los deícticos de `deictic.ts`: si el tipo cambia de
 * slide sin decir "as you can see", esa slide se perdía. Una slide nueva es
 * contenido nuevo aunque nadie la señale.
 *
 * Así que la señal correcta no es el tiempo ni lo que dice: **es que la imagen
 * cambió.** Se muestrea seguido, se compara con la anterior, y se guarda solo
 * cuando cambió. Una captura por slide.
 *
 * Los deícticos no se tiran: siguen diciendo CUÁL de esas slides es la
 * importante. Cambio de slide dice *qué* capturar; deíctico dice *qué mirar
 * primero*.
 *
 * ## Por qué las firmas entran desde afuera
 *
 * Calcularlas necesita un `<canvas>` o un `NativeImage`, o sea I/O. Acá entra
 * el resultado ya reducido, y por eso todo esto se prueba con arrays a mano y
 * sin abrir un navegador.
 */

/**
 * Un frame reducido a una grilla de grises, 0-255.
 *
 * Reducir ANTES de comparar es lo que hace que esto sirva: a 32×24 el puntero
 * del mouse y el ruido de compresión desaparecen, y un cambio de slide sigue
 * siendo evidente.
 */
export type FrameSignature = number[]

/**
 * Cuánto cambió una celda para que cuente como cambiada.
 *
 * 12 sobre 255 es ~5%. Por debajo quedan el ruido del códec y los degradés del
 * fondo; por encima, texto que aparece o un diagrama que cambia.
 */
const CELL_DELTA = 12

/**
 * Qué proporción de celdas tiene que cambiar para llamarlo slide nueva.
 *
 * **Este número es de calibración, no de teoría.** 8% deja pasar el cursor
 * moviéndose y una animación de aparición, y agarra un cambio de slide real —
 * que mueve medio cuadro. Si en la práctica se escapan slides parecidas, baja;
 * si salen duplicados, sube.
 */
export const DEFAULT_CHANGE_RATIO = 0.08

/**
 * Proporción de celdas que cambiaron, de 0 a 1.
 *
 * Proporción de celdas y NO diferencia promedio: el promedio lo mueve un
 * cambio global de brillo —un fade, el video que arranca oscuro— y eso no es
 * una slide nueva. Contar celdas mide *cuánta pantalla* cambió, que es la
 * pregunta real.
 *
 * Firmas de distinto largo se tratan como cambio total: comparar peras con
 * manzanas y devolver un número chico sería decir "no cambió" sobre algo que
 * ni siquiera se pudo medir.
 */
export function changeRatio(a: FrameSignature, b: FrameSignature): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 1

  let changed = 0
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > CELL_DELTA) changed++
  }
  return changed / a.length
}

export function isSlideChange(
  a: FrameSignature,
  b: FrameSignature,
  ratio: number = DEFAULT_CHANGE_RATIO
): boolean {
  return changeRatio(a, b) >= ratio
}

/**
 * De una lista de firmas, los índices que son slide nueva.
 *
 * **El primero entra siempre.** No hay con qué compararlo, y descartarlo
 * perdería la slide de apertura — que en este curso es la que da el título de
 * la sección.
 *
 * Se compara contra la última GUARDADA y no contra la anterior a secas. Con un
 * fade largo, comparar de a pares vecinos nunca supera el umbral y la slide
 * nueva no se detecta nunca, aunque el principio y el final del fade no se
 * parezcan en nada.
 */
export function pickChanges(
  signatures: FrameSignature[],
  ratio: number = DEFAULT_CHANGE_RATIO
): number[] {
  if (signatures.length === 0) return []

  const picked = [0]
  let last = signatures[0]

  for (let i = 1; i < signatures.length; i++) {
    if (isSlideChange(last, signatures[i], ratio)) {
      picked.push(i)
      last = signatures[i]
    }
  }

  return picked
}

/**
 * Los momentos a muestrear de un video.
 *
 * ## Por qué no hay que reproducirlo
 *
 * Esto es `video.currentTime = t`, no mirar la clase. Una clase de seis
 * minutos con muestreo cada cinco segundos son 78 saltos de ~200 ms: veinte
 * segundos de reloj contra seis minutos de reproducción. Es la diferencia
 * entre barrer cincuenta clases en una tarde o en una semana.
 *
 * El último medio segundo se saltea: ahí el player ya montó la pantalla de
 * "siguiente clase" y esa captura no es de la clase.
 */
export function sampleTimes(durationSeconds: number, everySeconds: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return []
  if (!Number.isFinite(everySeconds) || everySeconds <= 0) return []

  const end = Math.max(0, durationSeconds - 0.5)
  const times: number[] = []
  for (let t = 0; t < end; t += everySeconds) times.push(Number(t.toFixed(2)))

  return times
}
