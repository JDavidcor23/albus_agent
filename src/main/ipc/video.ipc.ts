import { existsSync, statSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { dialog, shell } from 'electron'
import { z } from 'zod'
import { registerHandler } from './register-handler'
import { appWindow } from '../app-window'
import { IpcChannels, IpcEvents } from '../../shared/ipc'
import { videoDir } from '../paths'
import { runVideo } from '../video/run'
import { listTranscripts, renameTranscript } from '../video/store'
import { DEFAULT_SILENCE_DB } from '../core/video/transcript'

/**
 * El agente de extracción de video, del lado del main.
 *
 * Tres canales y un evento. El evento es la parte que importa: `video:run` es un
 * `invoke` y transcribir una hora de grabación son dos horas de CPU. Sin empujar
 * pasos, la ventana se queda muda todo ese rato.
 */

/** Las que ffmpeg abre sin drama y la gente tiene de verdad. */
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']

/**
 * A title is a label a person types, so it gets a ceiling.
 *
 * Not because 200 characters would break anything downstream, but because the
 * main process never takes a renderer's string on faith — and an unbounded one
 * ends up written to the user's disk verbatim.
 *
 * Declared BEFORE the schemas that read it: `const` is in the temporal dead zone
 * until its line runs, and these schemas are built at module load. Below them it
 * is a `ReferenceError` on startup, not a type error.
 */
const TITLE_MAX = 200

const RunSchema = z.object({
  path: z.string().min(1),
  /*
   * `base` se acepta pero no es el default: mide ~1,0x tiempo real contra ~2,1x
   * de `small`, y a cambio inventa palabras. Sirve para una prueba rápida, no
   * para el transcript que alguien va a leer.
   */
  model: z.enum(['tiny', 'base', 'small', 'medium']).default('small'),
  language: z.string().min(2).max(30).default('Spanish'),
  /** El umbral del filtro de alucinaciones, por si hay que moverlo. */
  silenceDb: z.number().min(-90).max(-20).default(DEFAULT_SILENCE_DB),
  /**
   * How to name it in the library. Optional: an empty title derives one from the
   * recording, so nobody is forced to name a thing before they have read it.
   */
  title: z.string().max(TITLE_MAX).default('')
})

const OpenSchema = z.object({ path: z.string().min(1) })

const RenameSchema = z.object({
  id: z.string().min(1).max(200),
  /** Empty is legal and means "go back to the derived name". Clearing is not an error. */
  title: z.string().max(TITLE_MAX)
})

function broadcast(channel: string, payload: unknown): void {
  appWindow()?.webContents.send(channel, payload)
}

/**
 * La ruta que manda el renderer, verificada.
 *
 * El main no confía en el renderer ni cuando la ruta salió de un diálogo que
 * abrió el main: entre el diálogo y el `invoke` hay un viaje por el IPC. Se
 * chequea que el archivo exista, que sea un archivo y que la extensión sea una
 * de video — un `.exe` acá se lo comería ffmpeg y no tiene por qué llegar.
 */
function checkedVideoPath(raw: string): string {
  const path = resolve(raw)

  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error('ese archivo no existe')
  }
  if (!VIDEO_EXTENSIONS.includes(extname(path).toLowerCase())) {
    throw new Error(`no es un video que sepa abrir: ${extname(path) || 'sin extensión'}`)
  }

  return path
}

/**
 * Que la ruta a abrir caiga DENTRO de la carpeta de salida.
 *
 * Sin esto, `video:open` es "abrile al renderer cualquier archivo del disco".
 * Es la misma línea que ya sigue `connections/registry.ts` cuando dice que la
 * URL sale de una constante y no de afuera.
 */
function insideOutput(raw: string): string {
  const root = resolve(videoDir())
  const path = resolve(raw)
  const rel = relative(root, path)

  if (rel === '' || rel.startsWith('..') || resolve(root, rel) !== path) {
    throw new Error('solo puedo abrir cosas de la carpeta de video')
  }

  return path
}

export function registerVideoHandlers(): void {
  /*
   * El diálogo lo abre el MAIN. Un `<input type=file>` del renderer devuelve un
   * `File`, no una ruta: para que ffmpeg lea un archivo de 2,7 GB habría que
   * mandarlo entero por el IPC. Así viaja un string.
   */
  registerHandler(IpcChannels.VIDEO_PICK, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Elegí la grabación',
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: VIDEO_EXTENSIONS.map((e) => e.slice(1)) }]
    })

    // Cancelar no es un error: se devuelve `null` y la UI no muestra nada rojo.
    if (result.canceled || result.filePaths.length === 0) return { path: null }
    return { path: result.filePaths[0] }
  })

  registerHandler(IpcChannels.VIDEO_RUN, async (payload: unknown) => {
    const { path, model, language, silenceDb, title } = RunSchema.parse(payload ?? {})

    return await runVideo({
      videoPath: checkedVideoPath(path),
      model,
      language,
      silenceDb,
      title,
      onStep: (step) => broadcast(IpcEvents.VIDEO_STEP, step)
    })
  })

  /*
   * The library. Read from disk on every call, never cached.
   *
   * This folder belongs to the user — `paths.ts` moved it out of `%APPDATA%`
   * precisely so they could open, back up and delete things in it. Any list kept
   * in the main process starts lying the moment they do, and a library that
   * shows transcripts that are not there is worse than one that is a beat slow.
   */
  registerHandler(IpcChannels.VIDEO_LIST, async () => ({ transcripts: listTranscripts() }))

  registerHandler(IpcChannels.VIDEO_RENAME, async (payload: unknown) => {
    const { id, title } = RenameSchema.parse(payload ?? {})
    return { transcript: renameTranscript(id, title) }
  })

  registerHandler(IpcChannels.VIDEO_OPEN, async (payload: unknown) => {
    const { path } = OpenSchema.parse(payload ?? {})
    const safe = insideOutput(path)

    const error = await shell.openPath(safe)
    if (error !== '') throw new Error(error)

    return { path: safe }
  })
}
