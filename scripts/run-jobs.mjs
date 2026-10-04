/**
 * Lanzador del módulo de postulación. Existe por una razón aburrida y real:
 * `VAR=1 npm run dev` no funciona en PowerShell, que es la shell del usuario.
 * Este wrapper setea la variable y levanta electron-vite igual en las dos.
 *
 *   node scripts/run-jobs.mjs selftest
 *   node scripts/run-jobs.mjs login
 *   node scripts/run-jobs.mjs apply '{"url":"...","company":"...","role":"..."}'
 *   node scripts/run-jobs.mjs apply ./mi-postulacion.json
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const [command, ...rest] = process.argv.slice(2)

const HELP = `
Comandos:
  login                   abre LinkedIn para que entres a mano. Una sola vez.
  apply <json|archivo>    completa el formulario de una vacante
  selftest                corre los asserts del navegador contra el fixture
  nav                     corre los asserts de "el modelo mira la página"
  udemy-login             abre Udemy para que entres a mano. Una sola vez.
      --force             borra la sesión guardada y vuelve a abrir la ventana.
                          Es lo que hay que correr cuando la cookie VENCIÓ: sin
                          esto el comando ve que la cookie existe y no abre nada.
                          Solo toca udemy.com; LinkedIn y Google quedan igual.
  udemy <url> [flags]     baja los transcripts y captura UNA vez por slide
      --section 3         solo esa sección (o "3,4" para varias). Vacío = todas
      --limit 1           tope de lecciones. Para validar, empezá con 1
      --every 5           cada cuántos segundos se MUESTREA (default 5).
                          NO es cada cuánto captura: guarda solo lo que cambió

Flag para CUALQUIER comando:
  --no-sandbox            apaga el sandbox de Chromium. Usalo si ves
                          "FATAL: GPU process isn't usable. Goodbye."
                          El error habla de GPU pero NO es de GPU: es el
                          sandbox que no puede cargar sus DLL. Las páginas de
                          terceros pierden contención. Muleta, no arreglo.
                          (--no-gpu se acepta como alias del nombre viejo)
  inspect <url>           muestra qué ve el agente en esa página. No toca nada.
  ui                      corre los asserts de la pestaña de agentes

El JSON de apply:
  {
    "url":      "https://www.linkedin.com/jobs/view/1234567890",   (obligatorio)
    "company":  "Example Corp",                                    (obligatorio)
    "role":     "Senior Frontend Engineer",                        (obligatorio)
    "slug":     "example",         // para encontrar cv/main_<slug>.pdf
    "mode":     "review",          // dry-run | review | auto   (default: review)
    "sector":   "SaaS",
    "fitRating": "72",
    "providerId": "claude-code",   // null = solo reglas, cero cuota
    "modelId":  "haiku"
  }

Los modos:
  dry-run   no toca la página. Dice qué campos podría responder y cuáles no.
  review    llena todo, adjunta el CV, saca captura y FRENA antes de enviar.
  auto      envía. Va contra el ToS de LinkedIn: la cuenta que se arriesga es la tuya.
`

const env = { ...process.env }

/*
 * `--no-sandbox` vale para CUALQUIER comando, no solo para `udemy`.
 *
 * Existe porque este wrapper existe: `VAR=1 npm run dev` no funciona en
 * PowerShell, que es la shell del usuario. Y en la máquina donde el sandbox de
 * Chromium no carga sus DLL no arranca NINGÚN comando —el síntoma es un
 * `FATAL: GPU process isn't usable` que habla de GPU y no es de GPU, ver
 * `main/index.ts`—, así que un flag por comando dejaría afuera justo al que
 * hace falta primero: el login.
 *
 * `--no-gpu` se acepta como alias porque fue el primer nombre que tuvo, cuando
 * el diagnóstico todavía era el equivocado. Quien lo tenga escrito en una nota
 * no tiene por qué enterarse de que cambió; el nombre que describe lo que pasa
 * de verdad es el otro.
 */
const sandboxAt = rest.findIndex((a) => a === '--no-sandbox' || a === '--no-gpu')
if (sandboxAt !== -1) {
  env.ALBUS_NO_SANDBOX = '1'
  rest.splice(sandboxAt, 1)
}

if (command === 'selftest') {
  env.ALBUS_JOBS_SELFTEST = '1'
} else if (command === 'nav') {
  env.ALBUS_NAV_CHECK = '1'
} else if (command === 'inspect') {
  const url = rest.join(' ').trim()
  if (url === '') {
    console.error('Falta la URL a inspeccionar.\n' + HELP)
    process.exit(1)
  }
  env.ALBUS_NAV_INSPECT = url
} else if (command === 'supa') {
  env.ALBUS_SUPA_REPRO = '1'
} else if (command === 'notion-probe') {
  env.ALBUS_NOTION_PROBE = '1'
} else if (command === 'demo') {
  env.ALBUS_UI_DEMO = '1'
} else if (command === 'ui') {
  env.ALBUS_UI_SELFTEST = '1'
} else if (command === 'login') {
  env.ALBUS_JOBS_LOGIN = '1'
} else if (command === 'udemy-login') {
  env.ALBUS_UDEMY_LOGIN = '1'
  // Without `--force` there is no way back in once the cookie expired: the
  // probe sees it EXISTS, the command returns before opening the window, and
  // forcing the window open would not help — the poll closes it 1.5s later
  // for the very same reason.
  if (rest.includes('--force')) env.ALBUS_UDEMY_LOGIN_FORCE = '1'
} else if (command === 'udemy-whoami') {
  env.ALBUS_UDEMY_WHOAMI = '1'
} else if (command === 'udemy') {
  // `<url> [tope]`. El tope va como argumento aparte y no pegado a la URL
  // porque una URL de lección ya trae `#` y query: sumarle un número la rompe.
  // Flags y no posicionales: `udemy <url> 0 5 3` no lo entiende nadie, y
  // equivocarse de posición baja lo que no era sin avisar.
  const flag = (name, fallback) => {
    const i = rest.indexOf('--' + name)
    return i === -1 || rest[i + 1] === undefined ? fallback : String(rest[i + 1]).trim()
  }

  const url = (rest[0] ?? '').trim()
  if (url === '' || url.startsWith('--')) {
    console.error('Falta la URL del curso.\n' + HELP)
    process.exit(1)
  }

  env.ALBUS_UDEMY_RUN = url
  env.ALBUS_UDEMY_LIMIT = flag('limit', '0')
  env.ALBUS_UDEMY_EVERY = flag('every', '5')
  env.ALBUS_UDEMY_SECTIONS = flag('section', flag('sections', ''))
} else if (command === 'apply') {
  const arg = rest.join(' ').trim()
  if (arg === '') {
    console.error('Falta el JSON de la postulación.\n' + HELP)
    process.exit(1)
  }
  env.ALBUS_JOBS_APPLY = arg.startsWith('{') ? arg : readFileSync(arg, 'utf8')
} else {
  console.log(HELP)
  process.exit(command === undefined ? 0 : 1)
}

const child = spawn('npx', ['electron-vite', 'dev'], {
  stdio: 'inherit',
  shell: true,
  env: env
})

/**
 * Matar el árbol entero, no solo a `npx`.
 *
 * Esto no es prolijidad: es el bug que rompió la conexión de Notion. Cuando
 * este script se corta por timeout o por Ctrl+C, Windows mata a `npx` y deja
 * vivo al Electron nieto. Ese huérfano se queda con el candado de la partición
 * de Chromium, y la próxima instancia de Albus no puede abrir IndexedDB —
 * Notion, que es offline-first, muestra "something's not right" y parece un
 * problema de Notion.
 *
 * La app ahora se defiende con `requestSingleInstanceLock`, pero eso solo evita
 * el daño; el que ensuciaba era este script.
 */
function killTree() {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {
    // Ya no estaba. Es el resultado que queríamos igual.
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    killTree()
    process.exit(1)
  })
}
process.on('exit', killTree)

child.on('close', (code) => process.exit(code ?? 0))
