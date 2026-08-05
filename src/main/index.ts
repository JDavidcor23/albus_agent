import { app, shell, BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerExtractionHandlers } from './ipc/extraction.ipc'
import { registerGraphHandlers } from './ipc/graph.ipc'
import { registerTaskHandlers } from './ipc/tasks.ipc'
import { terminateOcr } from './core/extraction/ocr'

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

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.jdiaz483.albus-agent')

  registerExtractionHandlers()
  registerGraphHandlers()
  registerTaskHandlers()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

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
