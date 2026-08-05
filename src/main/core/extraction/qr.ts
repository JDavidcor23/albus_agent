import sharp from 'sharp'
import jsQR from 'jsqr'

/**
 * Intentos ordenados por probabilidad de éxito, no por costo.
 *
 * 1600px es el punto dulce para fotos de celular: un JPEG de 4000px no mejora
 * la detección y multiplica la memoria (4000×3000×4 bytes = 48 MB de RGBA).
 * El tamaño original va segundo por si el QR es chico dentro de la foto.
 * Escala de grises + normalize va último: rescata fotos con poca luz o flash.
 */
interface Attempt {
  maxSide: number // 0 = tamaño original
  greyscale: boolean
}

const ATTEMPTS: Attempt[] = [
  { maxSide: 1600, greyscale: false },
  { maxSide: 0, greyscale: false },
  { maxSide: 1600, greyscale: true },
  { maxSide: 800, greyscale: true }
]

async function decodeOnce(bytes: Uint8Array, attempt: Attempt): Promise<string | null> {
  // .rotate() SIN argumentos auto-orienta según el EXIF. Es obligatorio: las
  // fotos de celular vienen con la orientación en metadata, no en los píxeles,
  // y jsqr ve la imagen acostada.
  let pipeline = sharp(bytes).rotate()

  if (attempt.maxSide > 0) {
    pipeline = pipeline.resize({
      width: attempt.maxSide,
      height: attempt.maxSide,
      fit: 'inside',
      withoutEnlargement: true
    })
  }

  if (attempt.greyscale) {
    // Desaturar con modulate en vez de .greyscale(): greyscale colapsa a 1 canal
    // y con salida raw() ni ensureAlpha() ni toColourspace() lo reexpanden, así
    // que jsqr recibe 1 canal donde espera RGBA y este escalón de rescate queda
    // muerto en silencio. modulate mantiene los 3 canales y normalize estira el
    // contraste, que es lo único que se buscaba.
    pipeline = pipeline.modulate({ saturation: 0 }).normalize()
  }

  const { data, info } = await pipeline
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const channels = data.byteLength / (info.width * info.height)
  if (channels !== 4) {
    throw new Error(`se esperaban 4 canales RGBA y llegaron ${channels}`)
  }

  // jsqr pide RGBA crudo. El Buffer de sharp puede ser una vista sobre un
  // ArrayBuffer del pool de Node, así que hay que respetar offset y longitud.
  const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
  const found = jsQR(rgba, info.width, info.height)

  return found !== null && found.data.length > 0 ? found.data : null
}

/**
 * Devuelve el contenido de los QR encontrados. Array vacío si no hay ninguno.
 * Nunca tira: una imagen ilegible es un caso esperado, no un error del sistema.
 */
export async function readQrCodes(bytes: Uint8Array): Promise<string[]> {
  for (const attempt of ATTEMPTS) {
    try {
      const decoded = await decodeOnce(bytes, attempt)
      if (decoded !== null) return [decoded]
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[qr] intento ${attempt.maxSide}px falló: ${message}`)
    }
  }

  return []
}
