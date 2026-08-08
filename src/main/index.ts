import { config as loadDotenv } from 'dotenv'
import { app, shell, BrowserWindow, screen } from 'electron'
import { join } from 'path'

// electron-vite solo inyecta al main las variables con prefijo MAIN_VITE_. El
// cliente de Supabase ya lo cargaba por su cuenta, pero el módulo de trabajo
// no lo importa y se quedaba sin JOB_WORKSPACE_DIR. Se carga una vez, acá.
loadDotenv()

import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerExtractionHandlers } from './ipc/extraction.ipc'
import { registerGraphHandlers } from './ipc/graph.ipc'
import { registerTaskHandlers } from './ipc/tasks.ipc'
import { registerJobHandlers } from './ipc/jobs.ipc'
import { registerConnectionHandlers } from './ipc/connections.ipc'
import { applyConnections } from './connections/registry'
import { terminateOcr } from './core/extraction/ocr'
import { maybeRunJobsCommand } from './jobs/headless'

process.on('uncaughtException', (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  console.error(`[main-error] uncaughtException: ${message}\n${stack ?? ''}`)
})

process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  const stack = reason instanceof Error ? reason.stack : undefined
  console.error(`[main-error] unhandledRejection: ${message}\n${stack ?? ''}`)
})

function createWindow(): void {
  // Es un tablero de datos y quiere ancho, pero un tamaño fijo se pasa de
  // pantallas chicas y Windows recorta la ventana. Se mide contra el área
  // disponible, que ya descuenta la barra de tareas.
  const { width: availW, height: availH } = screen.getPrimaryDisplay().workAreaSize

  const mainWindow = new BrowserWindow({
    width: Math.min(1200, availW - 80),
    height: Math.min(800, availH - 60),
    minWidth: 820,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // El template abre DevTools solo en dev, pero acopladas se comen media ventana
  // y no dejan ver el tablero. Se abren a mano con Ctrl+Shift+I cuando hacen falta.
}

/**
 * Los chequeos corren con SU PROPIO almacenamiento.
 *
 * Son, por definición, una segunda instancia — y el candado de abajo los
 * mataría. Peor: sin candado le robarían la partición a la app abierta y le
 * romperían Notion, que es exactamente el bug que estamos arreglando.
 *
 * Con un `userData` aparte no compiten por nada: ni por el candado, ni por
 * IndexedDB, ni por las cookies. El `notion-probe` es la excepción a mano —
 * necesita la partición REAL para diagnosticarla, así que ese sí requiere que
 * la app esté cerrada, y el candado se encarga de decirlo.
 */
const TEST_MODE =
  process.env.ALBUS_JOBS_SELFTEST === '1' ||
  process.env.ALBUS_UI_SELFTEST === '1' ||
  process.env.ALBUS_NAV_CHECK === '1'

if (TEST_MODE) {
  // `'pruebas'` es un valor congelado: cambiarlo huerfaniza el perfil de prueba.
  app.setPath('userData', join(app.getPath('userData'), 'pruebas'))
}

/**
 * Una sola instancia. No es cosmético: es un bug real que ya nos costó.
 *
 * Chromium le pone un candado al almacenamiento de cada partición y lo da a UN
 * proceso. Con dos instancias de Albus abiertas, la segunda no puede abrir
 * IndexedDB ni el sistema de archivos de `persist:albus-jobs`, y las páginas
 * que dependen de eso se rompen. Notion —que es offline-first— muestra
 * "Hmm… something's not right" y parece un problema de Notion. No lo es.
 *
 * El síntoma era desconcertante justamente porque LinkedIn y Google SÍ andaban:
 * toleran que el almacenamiento falle. Notion no.
 *
 * Va antes de `whenReady` a propósito: la segunda instancia tiene que morirse
 * antes de tocar el disco.
 */
if (!app.requestSingleInstanceLock()) {
  /**
   * Para un comando de terminal, "cierro esta" no explica nada: el proceso
   * sigue un rato, la carga de la página falla con `ERR_FAILED (-2)` y parece
   * un problema de red. Es el mismo choque de candado, pero disfrazado.
   */
  const command = [
    ['ALBUS_NAV_INSPECT', 'nav:inspect'],
    ['ALBUS_NAV_CHECK', 'nav:check'],
    ['ALBUS_JOBS_APPLY', 'jobs:apply'],
    ['ALBUS_JOBS_LOGIN', 'jobs:login'],
    ['ALBUS_NOTION_PROBE', 'jobs:notion-probe']
  ].find(([variable]) => (process.env[variable] ?? '').trim() !== '')

  if (command !== undefined) {
    console.error(
      `\n[albus] NO PUEDO CORRER "${command[1]}": la app ya está abierta.\n` +
        `        Comparten el perfil del navegador (persist:albus-jobs), y Chromium\n` +
        `        le da el candado del almacenamiento a UN solo proceso.\n\n` +
        `        Cerrá la ventana de Albus y volvé a correrlo.\n`
    )
  } else {
    console.log('[albus] ya hay una instancia abierta — cierro esta')
  }

  app.exit(1)
}

app.on('second-instance', () => {
  // En vez de abrir otra ventana, se trae al frente la que ya está.
  const [win] = BrowserWindow.getAllWindows()
  if (win === undefined) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.jdiaz483.albus-agent')

  // Antes que cualquier handler: los clientes de Notion y Google tienen que
  // ver el token guardado desde la primera llamada, no desde la segunda.
  applyConnections()

  registerExtractionHandlers()
  registerGraphHandlers()
  registerTaskHandlers()
  registerJobHandlers()
  registerConnectionHandlers()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Albus como worker: `npm run jobs:login|jobs:apply|jobs:selftest` levantan
  // el proceso principal sin la ventana de la app. Necesitan estar acá adentro
  // porque un BrowserWindow no existe fuera de Electron — `npx tsx` no alcanza.
  if (maybeRunJobsCommand()) return

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('will-quit', () => {
    // Cerramos el worker de tesseract al salir para no dejar colgado el proceso.
    void terminateOcr()
  })
})
