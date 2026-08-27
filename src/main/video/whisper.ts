import { execFile } from 'node:child_process'
import { cpus } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { resolveBinary } from '../providers/cli-common'
import { parseSrt, parseWhisperLog, type Cue } from '../core/video/transcript'

/**
 * whisper. Corre en CPU y es lento; todo acá existe para que eso sea llevadero.
 *
 * ## Tres cosas medidas, no supuestas
 *
 * 1. **`base` no alcanza para español de negocios.** Inventa palabras: "la beja"
 *    por "la beca", "protecimiento pantalla" por "comparto pantalla". `small` es
 *    el piso usable. Costo: `base` ~1,0x tiempo real, `small` ~2,1x.
 * 2. **Una corrida larga no sobrevive.** Se probó dos veces con el audio entero
 *    y las dos murieron a mitad. Por eso se corre por TRAMOS: cada uno que
 *    termina deja su resultado, y lo que se pierde es un tramo, no una hora.
 * 3. **Dos procesos en paralelo rinden casi el doble; tres rinden menos.**
 *    En 12 cores: 6 min de audio en 6m38 con 2×6 hilos, contra ~12m30 en serie.
 *    Con 3×4 hilos se pasó de los 10 minutos. De ahí el tope.
 *
 * ## Y el rescate
 *
 * whisper escribe el `.srt` RECIÉN AL TERMINAR, pero imprime cada línea a
 * stdout mientras avanza. Se guarda esa salida: si el archivo no aparece, el
 * transcript se saca del log igual.
 */

const cache: { value: string | null | undefined } = { value: undefined }

/** Un tramo de 3 min tarda ~6m40 con dos en paralelo. El techo es holgura, no expectativa. */
const CHUNK_TIMEOUT_MS = 25 * 60_000

/** Hilos por proceso con los que se midió el mejor rendimiento. */
const THREADS_PER_WORKER = 6

export async function whisperPath(): Promise<string | null> {
  return await resolveBinary('whisper', cache)
}

/**
 * Cuántos procesos correr a la vez, y con cuántos hilos cada uno.
 *
 * Tope de 2: es lo que se midió como óptimo. Subirlo hace que los procesos se
 * peleen por los mismos cores y el total empeore.
 */
export function plan(coreCount = cpus().length): { workers: number; threads: number } {
  const workers = Math.max(1, Math.min(2, Math.floor(coreCount / THREADS_PER_WORKER)))
  return { workers, threads: Math.max(1, Math.floor(coreCount / workers)) }
}

function runChunk(
  bin: string,
  wavPath: string,
  model: string,
  language: string,
  threads: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [
        wavPath,
        '--model', model,
        '--language', language,
        '--output_format', 'srt',
        '--output_dir', dirname(wavPath)
      ],
      {
        encoding: 'utf8',
        timeout: CHUNK_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          /*
           * Sin esto whisper explota con UnicodeEncodeError en Windows: cp1252
           * no puede encodear un carácter CJK que trae su propio texto de ayuda.
           */
          PYTHONUTF8: '1',
          OMP_NUM_THREADS: String(threads)
        }
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`whisper falló en ${basename(wavPath)}: ${String(stderr).slice(-300) || error.message}`))
          return
        }
        resolve(stdout)
      }
    )
  })
}

/** El resultado de un tramo, ya en la línea de tiempo del video entero. */
async function transcribeChunk(
  bin: string,
  wavPath: string,
  offset: number,
  model: string,
  language: string,
  threads: number
): Promise<Cue[]> {
  const log = await runChunk(bin, wavPath, model, language, threads)

  // El `.srt` es la fuente canónica; el log es la red por si no llegó a escribirlo.
  const srtPath = join(dirname(wavPath), `${basename(wavPath, '.wav')}.srt`)
  if (existsSync(srtPath)) {
    const cues = parseSrt(readFileSync(srtPath, 'utf8'), offset)
    if (cues.length > 0) return cues
  }

  return parseWhisperLog(log, offset)
}

export interface ChunkJob {
  path: string
  /** Segundos desde el arranque del video en los que empieza este tramo. */
  offset: number
}

/**
 * Transcribe los tramos con un pool chico y devuelve todos los cues ordenados.
 *
 * Un tramo que falla NO tumba el resto: se avisa y se sigue. Perder tres
 * minutos de una reunión de una hora es malo; perder la hora entera porque uno
 * de veinte tramos se cayó es peor.
 */
export async function transcribeChunks(
  jobs: ChunkJob[],
  options: {
    model: string
    language: string
    onChunkDone?: (done: number, total: number) => void
  }
): Promise<{ cues: Cue[]; failed: string[] }> {
  const bin = await whisperPath()
  if (bin === null) throw new Error('no encuentro whisper en el PATH')

  const { workers, threads } = plan()
  const cues: Cue[] = []
  const failed: string[] = []
  let next = 0
  let done = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= jobs.length) return

      const job = jobs[index]
      try {
        cues.push(...(await transcribeChunk(bin, job.path, job.offset, options.model, options.language, threads)))
      } catch (error: unknown) {
        console.warn(`[video] ${basename(job.path)}: ${String(error)}`)
        failed.push(job.path)
      }

      done++
      options.onChunkDone?.(done, jobs.length)
    }
  }

  await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, worker))

  return { cues: cues.sort((a, b) => a.start - b.start), failed }
}
