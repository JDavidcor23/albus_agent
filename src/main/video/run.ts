import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { VideoRunSummary, VideoStepEvent } from '../../shared/ipc'
import { cacheDir, videoDir } from '../paths'
import { duration, extractAudioAndFrames, meanDb, splitAudio } from './ffmpeg'
import { transcribeChunks } from './whisper'
import { buildPage } from '../core/video/page'
import { defaultTitle } from '../core/video/library'
import { writeMeta } from './store'
import {
  DEFAULT_SILENCE_DB,
  filterHallucinations,
  levelHistogram,
  toPlainText,
  toSrt,
  type MeasuredCue
} from '../core/video/transcript'

/**
 * De un archivo de video a una página que se puede leer.
 *
 * El orden no es negociable y cada paso está donde está por una razón medida:
 *
 * 1. Audio y capturas en UNA pasada — decodificar es casi todo el costo.
 * 2. Cortar el audio en tramos — una corrida larga no sobrevive.
 * 3. Transcribir de a dos en paralelo.
 * 4. Medir el volumen de cada cue y tirar lo que whisper inventó sobre silencio.
 * 5. Armar la página.
 *
 * Lo pesado y descartable (el wav, los tramos) vive en `cacheDir()` y se borra
 * al final. Lo que costó una hora de CPU queda en `videoDir()`.
 */

/** Un frame por minuto. Con 58 minutos son 58 capturas: entra bajo el techo de 100. */
const EVERY_SECONDS = 60

/** 640x360 = 299 tokens visuales por frame, contra 1196 del 720p nativo. */
const FRAME_WIDTH = 640

/** Tramos de 3 minutos: cada uno termina holgado dentro de su timeout. */
const CHUNK_SECONDS = 180

export interface RunOptions {
  videoPath: string
  model?: string
  language?: string
  silenceDb?: number
  /**
   * What to call this transcript in the library. Empty = derive it from the
   * recording, so a run is never nameless.
   */
  title?: string
  onStep?: (step: VideoStepEvent) => void
}

/** Nombre de carpeta a partir del archivo: sin extensión y sin nada raro. */
function slugFor(videoPath: string): string {
  const stem = basename(videoPath, extname(videoPath))
  const clean = stem.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return clean === '' ? 'video' : clean
}

/** Corre `task` sobre `items` con un tope de concurrencia. */
async function pooled<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await task(items[i])
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export async function runVideo(options: RunOptions): Promise<VideoRunSummary> {
  const {
    videoPath,
    model = 'small',
    language = 'Spanish',
    silenceDb = DEFAULT_SILENCE_DB,
    title = '',
    onStep
  } = options

  const step = (stage: VideoStepEvent['stage'], label: string, done = 0, total = 0): void =>
    onStep?.({ stage, label, done, total })

  const slug = slugFor(videoPath)
  const outDir = join(videoDir(), slug)
  const framesDir = join(outDir, 'frames')
  const workDir = join(cacheDir(), 'video', slug)
  const chunksDir = join(workDir, 'chunks')

  for (const dir of [outDir, framesDir, workDir, chunksDir]) mkdirSync(dir, { recursive: true })

  step('probe', 'reading the file')
  const seconds = await duration(videoPath)
  if (seconds === null) throw new Error(`no pude leer la duración de ${basename(videoPath)}`)

  const audioPath = join(workDir, 'audio.wav')
  step('extract', 'pulling audio and frames')
  await extractAudioAndFrames({
    videoPath,
    audioOut: audioPath,
    framesDir,
    everySeconds: EVERY_SECONDS,
    width: FRAME_WIDTH
  })

  step('split', 'splitting the audio')
  const chunkPaths = await splitAudio(audioPath, chunksDir, CHUNK_SECONDS)
  const jobs = chunkPaths.map((path, i) => ({ path, offset: i * CHUNK_SECONDS }))

  step('transcribe', 'transcribing', 0, jobs.length)
  const { cues: raw, failed } = await transcribeChunks(jobs, {
    model,
    language,
    onChunkDone: (done, total) => step('transcribe', 'transcribing', done, total)
  })

  /*
   * El filtro de alucinaciones. Se mide CADA cue en su propia ventana: un
   * umbral global sobre tramos de silencio se lleva puesta el habla baja real.
   */
  step('filter', 'checking for made-up lines', 0, raw.length)
  let measured = 0
  const withLevel: MeasuredCue[] = await pooled(raw, 4, async (c) => {
    const db = await meanDb(audioPath, c.start, c.end - c.start)
    step('filter', 'checking for made-up lines', ++measured, raw.length)
    return { ...c, db }
  })

  const { kept, dropped } = filterHallucinations(withLevel, silenceDb)
  if (dropped.length > 0) {
    console.log(`[video] ${dropped.length} cue(s) descartados por caer en silencio:`)
    for (const d of dropped) console.log(`  ${d.db} dB — ${d.text.slice(0, 60)}`)
  }
  for (const b of levelHistogram(withLevel)) {
    console.log(`[video] ${b.from}..${b.from + 5} dB: ${b.count}`)
  }

  step('page', 'building the page')
  const frames = new Map<number, string>()
  for (const name of readdirSync(framesDir).sort()) {
    const m = /^f_(\d{4})\.jpg$/.exec(name)
    if (m === null) continue
    // f_0001 es el segundo 0, así que el minuto es el índice menos uno.
    frames.set(Number(m[1]) - 1, readFileSync(join(framesDir, name)).toString('base64'))
  }

  const srtPath = join(outDir, 'transcript.srt')
  const textPath = join(outDir, 'transcript.txt')
  const pagePath = join(outDir, 'page.html')

  writeFileSync(srtPath, toSrt(kept), 'utf8')
  writeFileSync(textPath, toPlainText(kept), 'utf8')
  writeFileSync(
    pagePath,
    buildPage({
      title: basename(videoPath, extname(videoPath)),
      cues: kept,
      frames,
      everySeconds: EVERY_SECONDS,
      durationSeconds: seconds,
      model
    }),
    'utf8'
  )

  /*
   * The metadata goes last, AFTER the transcript is on disk.
   *
   * `meta.json` is what makes this folder a named row in the library, so writing
   * it early would advertise a transcript that does not exist yet — a run killed
   * mid-transcription would leave a titled, empty entry. Written here, a dead run
   * leaves a folder the library simply does not list.
   */
  const finalTitle = title.trim() === '' ? defaultTitle(basename(videoPath)) : title.trim()
  writeMeta(slug, {
    title: finalTitle,
    sourceName: basename(videoPath),
    createdAt: new Date().toISOString(),
    model,
    language,
    durationSeconds: seconds,
    cues: kept.length,
    droppedCues: dropped.length,
    frames: frames.size
  })

  // El wav y los tramos pesan cien megas y ya no sirven. La página, sí.
  rmSync(workDir, { recursive: true, force: true })

  step('done', 'ready', 1, 1)

  return {
    id: slug,
    title: finalTitle,
    outDir,
    pagePath,
    srtPath,
    textPath,
    cues: kept.length,
    droppedCues: dropped.length,
    frames: frames.size,
    durationSeconds: seconds,
    failedChunks: failed.length
  }
}
