import { app, shell } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { HUB_FOLDER, resolveHubDir } from './core/hub/hub-location'

/**
 * Dónde viven los datos del USUARIO. Nunca en el repo, y ahora tampoco
 * enterrados entre los caches de Chromium.
 *
 * ## Por qué existe este archivo
 *
 * Las reglas de los agentes y `albus.yml` se escribían en el directorio del
 * proyecto cuando la app corría en desarrollo. Reclamo del usuario, y es
 * correcto: *"si algún día yo quiero sacar esto, literalmente se va a guardar en
 * el código fuente"*.
 *
 * La regla, sin excepciones: **lo que el usuario escribe o la app genera para él
 * va a su carpeta.** El repo tiene código, no estado.
 *
 * ## Por qué la carpeta se MUDÓ de `%APPDATA%`
 *
 * Estaba en `%APPDATA%/albus-agent`, que es el `userData` de Electron. Ahí
 * Chromium escribe lo suyo: al momento de mudarnos había **3.190 archivos** en
 * esa carpeta —`Cache/`, `Code Cache/`, `GPUCache/`, `DawnWebGPUCache/`,
 * `Local Storage/`— y las reglas del usuario eran cuatro de esos tres mil. Nadie
 * puede encontrar, abrir ni respaldar sus datos ahí adentro.
 *
 * Ahora hay dos lugares con dos propósitos, y la línea entre ellos es si el dato
 * se puede regenerar:
 *
 * - `dataDir()` — `Documentos/albus_agent`. **Lo que se perdería para siempre**:
 *   los agentes, sus reglas, la cola de preguntas, las credenciales, el grafo.
 *   Visible, respaldable, y sobrevive a desinstalar la app.
 * - `cacheDir()` — el `userData` de Electron. **Lo desechable**: caches,
 *   capturas de evidencia, archivos que se preparan para subir, perfiles de
 *   prueba. Borrarlo entero no le cuesta nada al usuario.
 *
 * ## El nombre de la carpeta es un CONTRATO
 *
 * `albus_agent` y `agents/` son valores congelados: si cambian, la app arranca
 * mirando una carpeta vacía y el usuario pierde sus reglas, sus tokens y las
 * respuestas que ya dio. Por eso `migrateLegacyData()` existe y por eso COPIA en
 * vez de mover — ver ahí abajo.
 */

/** El nombre del `userData` de Electron. Sale del `package.json`. CONGELADO. */
const APP_NAME = 'albus-agent'

/** La carpeta visible del usuario. CONGELADO: renombrarla huérfana todo. */
const DATA_FOLDER = 'albus_agent'

/**
 * Los selftests corren con su propio perfil para no competir por el candado de
 * Chromium ni pisar los datos reales.
 *
 * Vive acá y no en `index.ts` porque lo necesitan los DOS: `index.ts` para
 * mover el `userData` de Electron, y `dataDir()` para no escribir las reglas de
 * prueba encima de las de verdad. Con la condición duplicada, agregar un
 * selftest nuevo y actualizar solo un lado significa un test que le borra las
 * reglas al usuario — y se descubriría tarde.
 */
export function isTestMode(): boolean {
  return (
    process.env.ALBUS_JOBS_SELFTEST === '1' ||
    process.env.ALBUS_UI_SELFTEST === '1' ||
    process.env.ALBUS_NAV_CHECK === '1'
  )
}

/** La raíz del perfil del usuario. Una sola fuente para todo lo de abajo. */
function homeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? process.cwd()
}

/**
 * La carpeta de documentos. **A mano, y NUNCA con `app.getPath('documents')`.**
 *
 * Dos razones, y las dos costaron una corrida:
 *
 * **1. Colgaba la app.** `app.getPath('documents')` resuelve una known folder de
 * Windows por la API del shell, y acá se llama ANTES de `app.whenReady()` —la
 * migración tiene que correr antes de que cualquier módulo lea una regla o un
 * token—. En una máquina con OneDrive esa llamada temprana se queda esperando: el
 * proceso main arrancaba, imprimía las líneas de dotenv y ahí moría, sin ventana,
 * sin GPU y sin un solo log. Ningún selftest lo detectó porque en modo prueba la
 * migración corta antes y `dataDir()` sale por `cacheDir()`: esta línea solo se
 * ejecuta en un arranque de verdad.
 *
 * **2. Partía la app de los scripts.** Con OneDrive, `getPath('documents')`
 * devuelve `…/OneDrive - Empresa/Documents`, mientras un script con `npx tsx`
 * —donde `app.getPath` no existe— calculaba `USERPROFILE/Documents`. Dos carpetas
 * distintas para los mismos datos: `notion:check` migraba el token a una y la app
 * lo buscaba en la otra, vacía, y reportaba "no hay token" sobre una conexión que
 * funciona. Es exactamente el desacuerdo de rutas que este archivo viene evitando,
 * y calcularlo a mano lo hace imposible.
 *
 * Si alguien necesita la carpeta redirigida de OneDrive, para eso está
 * `ALBUS_DATA_DIR`: explícito, no adivinado.
 */
function documentsDir(): string {
  return join(homeDir(), 'Documents')
}

/**
 * El escritorio, para migrar el grafo viejo. A mano por lo mismo que
 * `documentsDir`: `app.getPath('desktop')` es otra known folder de Windows y
 * llamarla antes de `whenReady` colgaba el arranque.
 *
 * Si la ruta no existe simplemente no se migra nada — la migración chequea antes
 * de copiar—, así que adivinar de más no cuesta nada acá.
 */
function desktopDir(): string {
  return join(homeDir(), 'Desktop')
}

/**
 * La raíz de lo que el usuario perdería si se borrara.
 *
 * `ALBUS_DATA_DIR` la puede mover, y no es un detalle de desarrollo: es lo que
 * permite tenerla en un disco sincronizado, o en un Linux donde la carpeta de
 * documentos se llama de otra forma. Sin esa salida, la ruta sería otra cosa
 * hardcodeada que solo funciona en una máquina.
 */
export function dataDir(): string {
  /*
   * Los selftests van al lado desechable, no a la carpeta del usuario.
   *
   * Antes esto devolvía `<carpeta del usuario>/pruebas`, y eso contradice la línea
   * que separa las dos carpetas: un perfil de prueba es lo más regenerable que
   * hay, y no tiene por qué ensuciar —ni entrar en el respaldo de— algo que el
   * usuario abre. `'pruebas'` es un valor congelado: cambiarlo huerfaniza el
   * perfil de prueba y los selftests empiezan de cero sin decir por qué.
   */
  if (isTestMode()) return join(cacheDir(), 'pruebas')

  const override = process.env.ALBUS_DATA_DIR?.trim()
  if (override !== undefined && override !== '') return override

  return join(documentsDir(), DATA_FOLDER)
}

/**
 * Lo desechable: el `userData` de Electron.
 *
 * Acá va lo que la app puede volver a generar —capturas, staging de subidas,
 * caches— y lo que no tiene sentido que el usuario vea. Se calcula a mano fuera
 * de Electron por el mismo motivo que `documentsDir`.
 */
function computeCacheDir(): string {
  try {
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

/**
 * Se captura al IMPORTAR, antes de que `index.ts` redirija el `userData`.
 *
 * En modo prueba `index.ts` hace `app.setPath('userData', …/pruebas)` para aislar
 * las cookies y el candado de Chromium. Eso pasa DESPUÉS de los imports, así que
 * acá queda el valor original — y `dataDir()` puede armar `…/albus-agent/pruebas`
 * una sola vez.
 *
 * Sin esta captura, `cacheDir()` ya devolvía la ruta con `pruebas` adentro y
 * `dataDir()` le sumaba otro: el perfil de prueba terminaba en
 * `albus-agent/pruebas/pruebas/`. Y peor que lo feo: los scripts —que no pasan por
 * `index.ts`— calculaban UNA sola `pruebas`, así que la app y el verificador
 * miraban carpetas distintas. Es exactamente el desacuerdo de rutas contra el que
 * este archivo advierte en `documentsDir`.
 */
const PRISTINE_CACHE_DIR = computeCacheDir()

export function cacheDir(): string {
  return PRISTINE_CACHE_DIR
}

/** Los agentes: su manifiesto, sus reglas y su cola de preguntas. */
export function agentsDir(): string {
  return join(dataDir(), 'agents')
}

/** El grafo de conocimiento. Existe la carpeta aunque todavía escriba poco. */
export function graphifyDir(): string {
  return join(dataDir(), 'graphify')
}

/**
 * Lo que sale de procesar una grabación: capturas, transcript y la página.
 *
 * Va al lado del usuario y no al cache porque es el ENTREGABLE — transcribir
 * una hora de video cuesta una hora de CPU, y perderlo al limpiar un cache
 * sería perder eso. El wav y los tramos, que sí son descartables y pesan cien
 * megas, se quedan en `cacheDir()` y se borran al terminar.
 */
export function videoDir(): string {
  return join(dataDir(), 'video')
}

/**
 * Los cursos bajados de Udemy.
 *
 * Va en `dataDir()` y no en `cacheDir()` porque NO se puede regenerar barato:
 * cada transcript costó abrir una lección con la sesión del usuario, y las
 * capturas costaron esperar a que el video saltara al momento correcto.
 * Además es material de un curso pago, así que tiene que estar donde el dueño
 * lo vea y lo pueda borrar — no enterrado entre los caches de Chromium.
 */
export function udemyDir(): string {
  return join(dataDir(), 'udemy')
}

/** CONTRACT — the code subfolder inside the hub. Renaming it hides every installed agent from discovery. */
const AGENTS_HUB_CODE_FOLDER = 'agents'

/** CONTRACT — the results subfolder inside the hub. Renaming it orphans everything an agent already produced. */
const AGENTS_HUB_RESULTS_FOLDER = 'results'

/**
 * Root of the agents hub: external agents' own CODE and what they PRODUCE.
 *
 * Lives in `Documents/`, same reasoning as `dataDir()` — computed by hand via
 * `documentsDir()`, never `app.getPath('documents')` (see that comment above:
 * it hung the boot on a machine with OneDrive). `ALBUS_AGENTS_HUB_DIR` moves
 * it, the same escape hatch `ALBUS_DATA_DIR` is for `dataDir()`.
 *
 * Test mode gets its own throwaway folder under `cacheDir()` so a check
 * script never touches a real installed agent or its real results — same
 * reasoning as `dataDir()`'s `pruebas` folder.
 */
export function agentsHubDir(): string {
  if (isTestMode()) return join(cacheDir(), 'pruebas', HUB_FOLDER)

  return resolveHubDir(process.env, homeDir())
}

/** Where an external agent's own code (its own git repo) lives, one folder per agent id. */
export function agentsCodeDir(): string {
  return join(agentsHubDir(), AGENTS_HUB_CODE_FOLDER)
}

/**
 * Where an external agent writes what it produces. Same id as its code
 * folder on purpose — see `.claude/docs/agents-hub.md`.
 */
export function agentResultsDir(agentId: string): string {
  // Same guard as `manifestPath`: the id ends up in a path, so a stray `..`
  // must not be able to write outside this folder.
  const clean = agentId.replace(/[^a-z0-9-]/gi, '')
  return join(agentsHubDir(), AGENTS_HUB_RESULTS_FOLDER, clean)
}

/**
 * Diagnostic log of every hub run, one JSON-lines file per run.
 *
 * Lives in `cacheDir()`, not inside the hub: it is Albus's own diagnostic,
 * not a deliverable the agent produced. "Albus never writes inside the
 * agent's folder" is the same rule in both directions.
 */
export function agentRunsDir(): string {
  return join(cacheDir(), 'agent-runs')
}

/** Las credenciales. */
export function albusYmlPath(): string {
  return join(dataDir(), 'albus.yml')
}

/** Qué servicios están conectados. Es estado del usuario, no un cache. */
export function connectionsPath(): string {
  return join(dataDir(), 'connections.json')
}

/**
 * La mudanza de `%APPDATA%/albus-agent` a `Documentos/albus_agent`.
 *
 * ## COPIA, no mueve. Es deliberado.
 *
 * Lo que se migra es irrecuperable: las reglas que el usuario escribió, el token
 * de Notion, el refresh token de Google, y las respuestas que ya le dio al
 * agente. Si la copia sale mal —permisos, disco lleno, una ruta con un carácter
 * raro— con un `move` no hay a dónde volver. El original queda donde está y el
 * usuario lo borra cuando verifique. Ocupa unos kilobytes.
 *
 * ## Nunca sobrescribe
 *
 * Si el destino ya existe, no se toca. Sin eso, abrir la app después de haber
 * editado las reglas nuevas las reemplazaría por las viejas de `%APPDATA%` — un
 * "arreglo" que borra trabajo en cada arranque.
 *
 * ## `agentes/` → `agents/`
 *
 * El nombre viejo estaba en castellano y era un valor congelado. Se renombra acá
 * y en ningún otro lado: para el resto del código la carpeta siempre se llamó
 * `agents`. Un agente cuyo `.md` no aparezca es un agente que el usuario cree que
 * perdió, así que esto NO puede quedar a que alguien mueva archivos a mano.
 */
/**
 * Copia lo que FALTE, entrada por entrada. Devuelve lo que copió.
 *
 * ## Por qué no un `if (existsSync(destino)) return`
 *
 * Porque ya falló así. La primera versión salteaba la migración entera si el
 * destino existía, y `check-agents.ts` —que escribe sus datos de prueba en la
 * carpeta de agentes— dejaba ahí una carpeta VACÍA. Resultado: `agents/` existía,
 * la migración se daba por hecha, y el `job-search.md` con las reglas del usuario
 * se quedaba en `%APPDATA%` para siempre. Sin error, sin log, sin síntoma hasta
 * que el usuario abre el panel y no encuentra lo que escribió.
 *
 * Entrada por entrada es la misma regla que el resto del proyecto —validar por
 * fila y no por lote— y tiene la misma consecuencia buena: una migración a medias
 * se completa en el arranque siguiente en vez de quedar trabada.
 *
 * Nunca sobrescribe: si el archivo ya está del lado nuevo, gana el nuevo. Lo
 * contrario sería reemplazar en cada arranque las reglas recién editadas por las
 * viejas.
 */
function copyMissing(from: string, to: string): string[] {
  if (!existsSync(from)) return []

  if (!statSync(from).isDirectory()) {
    if (existsSync(to)) return []
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to)
    return [to]
  }

  const copied: string[] = []
  mkdirSync(to, { recursive: true })

  for (const name of readdirSync(from)) {
    const target = join(to, name)
    if (existsSync(target)) continue
    cpSync(join(from, name), target, { recursive: true })
    copied.push(target)
  }

  return copied
}

let migrated = false

export function migrateLegacyData(): void {
  /*
   * Una vez por proceso, y llamarla de nuevo es gratis.
   *
   * Existe el guard porque hay DOS puertas de entrada: el arranque de la app y
   * `albus-yml.ts`, que la dispara cuando alguien pide la ruta del token. Sin la
   * segunda, `npm run notion:check` con la app nunca abierta miraría la carpeta
   * nueva —vacía— y reportaría "no hay token" sobre uno que existe en la vieja.
   * Es el mismo diagnóstico mentiroso que este archivo viene evitando.
   */
  if (migrated) return
  migrated = true

  // En modo prueba no se migra nada: el perfil de prueba nace vacío a propósito.
  if (isTestMode()) return

  const legacyRoot = cacheDir()
  const root = dataDir()
  if (legacyRoot === root) return

  const moves: { from: string; to: string; what: string }[] = [
    { from: join(legacyRoot, 'agentes'), to: agentsDir(), what: 'los agentes y sus reglas' },
    { from: join(legacyRoot, 'albus.yml'), to: albusYmlPath(), what: 'las credenciales' },
    { from: join(legacyRoot, 'connections.json'), to: connectionsPath(), what: 'las conexiones' }
  ]

  /*
   * El grafo venía del ESCRITORIO, no de `%APPDATA%`: `graph/store.ts` lo dejaba
   * en `Escritorio/albus-graph`. Era mejor que el repo y seguía siendo una carpeta
   * suelta en el escritorio de alguien.
   */
  moves.push({
    from: join(desktopDir(), 'albus-graph'),
    to: graphifyDir(),
    what: 'el grafo'
  })

  for (const move of moves) {
    if (!existsSync(move.from)) continue

    try {
      mkdirSync(root, { recursive: true })
      const copied = copyMissing(move.from, move.to)
      if (copied.length === 0) continue
      console.log(`[datos] migré ${move.what}: ${move.from} → ${move.to}`)
    } catch (error: unknown) {
      /*
       * Una migración que falla NO puede impedir arrancar.
       *
       * El usuario terminaría con una app que no abre y sin ninguna pista de por
       * qué. Se avisa fuerte, la app sigue, y sus datos viejos siguen intactos
       * donde estaban — que es exactamente el motivo de copiar en vez de mover.
       */
      console.warn(`[datos] NO pude migrar ${move.what} desde ${move.from}: ${String(error)}`)
      console.warn('[datos] tus datos viejos siguen ahí; podés copiarlos a mano a:')
      console.warn(`[datos]   ${root}`)
    }
  }
}

/**
 * Abre la carpeta de datos en el explorador.
 *
 * Existe porque el usuario tiene que poder llegar a sus archivos. Cuando la
 * carpeta estaba en `%APPDATA%` era casi obligatorio; ahora que está en
 * Documentos sigue valiendo los tres renglones.
 */
export async function openDataDir(): Promise<string> {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  await shell.openPath(dir)
  return dir
}
