import sharp from 'sharp'
import { createWorker, type Worker } from 'tesseract.js'

/**
 * Más de 2000px no mejora el reconocimiento y multiplica el tiempo. Tesseract
 * trabaja sobre glifos, no sobre resolución: lo que importa es el contraste.
 */
const MAX_SIDE = 2000

/**
 * El worker de tesseract descarga y compila los modelos de idioma la primera
 * vez (segundos). Se crea una sola vez y se reusa; sin esto, procesar 23 fotos
 * paga ese costo 23 veces.
 */
let workerPromise: Promise<Worker> | null = null

function getWorker(): Promise<Worker> {
  if (workerPromise === null) {
    workerPromise = createWorker('spa+eng')
  }
  return workerPromise
}

/**
 * Texto reconocido en la imagen. Cadena vacía si no hay nada legible.
 * Nunca tira: una imagen sin texto es un resultado válido, no un error.
 */
export async function readText(bytes: Uint8Array): Promise<string> {
  try {
    // Mismo .rotate() que en qr.ts, por el mismo motivo: EXIF.
    const prepared = await sharp(bytes)
      .rotate()
      .greyscale()
      .normalize()
      .resize({
        width: MAX_SIDE,
        height: MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true
      })
      .png()
      .toBuffer()

    const worker = await getWorker()
    const { data } = await worker.recognize(prepared)
    return data.text.trim()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[ocr] falló: ${message}`)

    // Un worker que reventó queda inservible: se descarta para que el próximo
    // llamado cree uno limpio en vez de arrastrar el error.
    workerPromise = null
    return ''
  }
}

/** Cierra el worker. Llamar al salir de la app; si no, el proceso no termina. */
export async function terminateOcr(): Promise<void> {
  if (workerPromise === null) return

  const pending = workerPromise
  workerPromise = null

  try {
    const worker = await pending
    await worker.terminate()
  } catch {
    // Cerrar un worker ya muerto no es un problema que valga reportar.
  }
}
