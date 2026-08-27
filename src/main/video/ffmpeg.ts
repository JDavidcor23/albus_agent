import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { resolveBinary } from '../providers/cli-common'

/**
 * ffmpeg y ffprobe. El único lugar del proyecto que los corre.
 *
 * Reglas de CLI del proyecto, todas presentes acá: binario resuelto con `where`,
 * flags como ARRAY (nunca un string que la shell reinterprete), timeout duro.
 *
 * ## Los dos gotchas que costaron tiempo
 *
 * 1. **`volumedetect` escribe en stderr y ffmpeg sale con 0.** Un wrapper que
 *    solo devuelve stderr cuando el proceso falla no ve NADA y el filtro de
 *    alucinaciones queda mudo sin decir por qué. Por eso `run()` devuelve las
 *    dos salidas siempre.
 * 2. **`-ss` va ANTES de `-i`.** Después de `-i` decodifica desde el principio:
 *    con un archivo de 2,7 GB son minutos contra 0,4 segundos.
 */

const cache: { value: string | null | undefined } = { value: undefined }
const probeCache: { value: string | null | undefined } = { value: undefined }

/** Un lote entero puede tardar; el techo está para que no quede colgado para siempre. */
const TIMEOUT_MS = 30 * 60_000

export async function ffmpegPath(): Promise<string | null> {
  return await resolveBinary('ffmpeg', cache)
}

export async function ffprobePath(): Promise<string | null> {
  return await resolveBinary('ffprobe', probeCache)
}

interface Output {
  stdout: string
  stderr: string
}

function run(bin: string, args: string[], label: string): Promise<Output> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // `error` viene con exit != 0 o timeout. stderr igual sirve para el mensaje.
        if (error !== null) {
          reject(new Error(`${label} falló: ${String(stderr).slice(-300) || error.message}`))
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })
}

async function requireFfmpeg(): Promise<string> {
  const bin = await ffmpegPath()
  if (bin === null) throw new Error('no encuentro ffmpeg en el PATH')
  return bin
}

/** Duración en segundos. `null` si ffprobe no está o el archivo no se puede leer. */
export async function duration(videoPath: string): Promise<number | null> {
  const bin = await ffprobePath()
  if (bin === null) return null

  try {
    const { stdout } = await run(
      bin,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath],
      'ffprobe'
    )
    const value = Number.parseFloat(stdout.trim())
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Audio + capturas en UNA sola pasada.
 *
 * Separarlo en dos comandos decodifica el archivo dos veces, y decodificar es
 * casi todo el costo: medido, 1m12 juntos contra ~1m55 cada uno por separado.
 *
 * El audio sale mono a 16 kHz porque es lo que whisper quiere; mandarle 48 kHz
 * estéreo es hacerle resamplear a él.
 */
export async function extractAudioAndFrames(options: {
  videoPath: string
  audioOut: string
  framesDir: string
  everySeconds: number
  width: number
}): Promise<void> {
  const bin = await requireFfmpeg()
  const { videoPath, audioOut, framesDir, everySeconds, width } = options

  await run(
    bin,
    [
      '-y', '-v', 'error', '-i', videoPath,
      '-map', '0:a', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioOut,
      // `-2` mantiene el aspecto y fuerza alto par, que h264/jpeg necesitan.
      '-map', '0:v', '-an', '-vf', `fps=1/${everySeconds},scale=${width}:-2`, '-q:v', '4',
      join(framesDir, 'f_%04d.jpg')
    ],
    'ffmpeg (audio + capturas)'
  )
}

/** Corta el wav en tramos parejos. Devuelve las rutas, en orden. */
export async function splitAudio(
  wavPath: string,
  outDir: string,
  chunkSeconds: number
): Promise<string[]> {
  const bin = await requireFfmpeg()

  await run(
    bin,
    ['-y', '-v', 'error', '-i', wavPath, '-f', 'segment',
     '-segment_time', String(chunkSeconds), '-c', 'copy', join(outDir, 'c_%03d.wav')],
    'ffmpeg (cortar en tramos)'
  )

  return readdirSync(outDir)
    .filter((n) => /^c_\d{3}\.wav$/.test(n))
    .sort()
    .map((n) => join(outDir, n))
}

/**
 * Volumen medio de una ventana, en dB. `null` si no se pudo medir.
 *
 * Es lo que separa el habla de la alucinación: en una grabación real el habla
 * dio -36 dB y el silencio -59 dB. Ver `core/video/transcript.ts`.
 *
 * Devuelve `null` en vez de tirar: un cue que no se puede medir se conserva, y
 * que falle una medición no puede tumbar el pipeline entero.
 */
export async function meanDb(
  wavPath: string,
  start: number,
  seconds: number
): Promise<number | null> {
  const bin = await ffmpegPath()
  if (bin === null) return null

  try {
    // `-ss` antes de `-i`: seek rápido. Y el mínimo evita una ventana de cero.
    const { stderr } = await run(
      bin,
      ['-hide_banner', '-ss', String(Math.max(start, 0)), '-t', String(Math.max(seconds, 0.3)),
       '-i', wavPath, '-af', 'volumedetect', '-f', 'null', '-'],
      'ffmpeg (volumedetect)'
    )

    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)
    return m === null ? null : Number.parseFloat(m[1])
  } catch {
    return null
  }
}
