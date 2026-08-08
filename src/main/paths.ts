import { app, shell } from 'electron'
import { join } from 'node:path'

/**
 * Dónde viven los datos del USUARIO. Nunca en el repo.
 *
 * ## Por qué existe este archivo
 *
 * Las reglas de los agentes y `albus.yml` se escribían en el directorio del
 * proyecto cuando la app corría en desarrollo. Reclamo del usuario, y es
 * correcto: *"si algún día yo quiero sacar esto, literalmente se va a guardar
 * en el código fuente"*. Y encima era inconsistente — las capturas, los
 * screenshots de postulación y `connections.json` ya iban a `userData` sin
 * condición.
 *
 * La regla, sin excepciones: **lo que el usuario escribe o la app genera va a
 * `userData`.** El repo tiene código, no estado.
 *
 * ## La consecuencia buena
 *
 * Desinstalar la app no borra tus reglas. Actualizarla tampoco. Y un `git
 * clean -xdf` deja de ser una forma de perder la configuración.
 */

/** El nombre con el que Electron arma `userData`. Sale del `package.json`. */
const APP_NAME = 'albus-agent'

/**
 * La raíz de todo lo del usuario. `%APPDATA%/albus-agent` en Windows.
 *
 * Fuera de Electron —`npx tsx scripts/…`— se calcula la MISMA ruta a mano, no
 * una carpeta del repo. Si apuntaran a lugares distintos, `notion:check` leería
 * un `albus.yml` vacío mientras la app usa uno con el token adentro, y el
 * diagnóstico diría "no hay token" sobre una conexión que funciona.
 */
export function dataDir(): string {
  try {
    // `app` existe pero sin `getPath` cuando el módulo se importa desde tsx.
    const dir = app?.getPath?.('userData')
    if (typeof dir === 'string' && dir !== '') return dir
  } catch {
    // Sigue abajo.
  }

  const { APPDATA, HOME, USERPROFILE } = process.env
  const home = HOME ?? USERPROFILE ?? process.cwd()

  if (process.platform === 'win32') {
    return join(APPDATA ?? join(home, 'AppData', 'Roaming'), APP_NAME)
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', APP_NAME)
  }
  return join(home, '.config', APP_NAME)
}

/** Las reglas que el usuario escribe para cada agente. */
export function agentsDir(): string {
  return join(dataDir(), 'agentes')
}

/** Las credenciales. */
export function albusYmlPath(): string {
  return join(dataDir(), 'albus.yml')
}

/**
 * Abre la carpeta de datos en el explorador.
 *
 * Existe porque mover todo a `userData` tiene un costo: el usuario ya no sabe
 * dónde está. Un botón que lo lleva ahí cuesta tres líneas y evita que tenga
 * que buscar `%APPDATA%` a mano.
 */
export async function openDataDir(): Promise<string> {
  const dir = dataDir()
  await shell.openPath(dir)
  return dir
}
