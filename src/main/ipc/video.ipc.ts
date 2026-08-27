import { existsSync, statSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { dialog, shell } from 'electron'
import { z } from 'zod'
import { registerHandler } from './register-handler'
import { appWindow } from '../app-window'
import { IpcChannels, IpcEvents } from '../../shared/ipc'
import { videoDir } from '../paths'
import { runVideo } from '../video/run'
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
  silenceDb: z.number().min(-90).max(-20).default(DEFAULT_SILENCE_DB)
})

const OpenSchema = z.object({ path: z.string().min(1) })

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
    const { path, model, language, silenceDb } = RunSchema.parse(payload ?? {})

    return await runVideo({
      videoPath: checkedVideoPath(path),
      model,
      language,
      silenceDb,
      onStep: (step) => broadcast(IpcEvents.VIDEO_STEP, step)
    })
  })

  registerHandler(IpcChannels.VIDEO_OPEN, async (payload: unknown) => {
    const { path } = OpenSchema.parse(payload ?? {})
    const safe = insideOutput(path)

    const error = await shell.openPath(safe)
    if (error !== '') throw new Error(error)

    return { path: safe }
  })
}
