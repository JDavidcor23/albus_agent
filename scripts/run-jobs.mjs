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

const [comando, ...resto] = process.argv.slice(2)

const AYUDA = `
Comandos:
  login                   abre LinkedIn para que entres a mano. Una sola vez.
  apply <json|archivo>    completa el formulario de una vacante
  selftest                corre los asserts del navegador contra el fixture
  nav                     corre los asserts de "el modelo mira la página"
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

const entorno = { ...process.env }

if (comando === 'selftest') {
  entorno.ALBUS_JOBS_SELFTEST = '1'
} else if (comando === 'nav') {
  entorno.ALBUS_NAV_CHECK = '1'
} else if (comando === 'inspect') {
  const url = resto.join(' ').trim()
  if (url === '') {
    console.error('Falta la URL a inspeccionar.\n' + AYUDA)
    process.exit(1)
  }
  entorno.ALBUS_NAV_INSPECT = url
} else if (comando === 'supa') {
  entorno.ALBUS_SUPA_REPRO = '1'
} else if (comando === 'notion-probe') {
  entorno.ALBUS_NOTION_PROBE = '1'
} else if (comando === 'demo') {
  entorno.ALBUS_UI_DEMO = '1'
} else if (comando === 'ui') {
  entorno.ALBUS_UI_SELFTEST = '1'
} else if (comando === 'login') {
  entorno.ALBUS_JOBS_LOGIN = '1'
} else if (comando === 'apply') {
  const arg = resto.join(' ').trim()
  if (arg === '') {
    console.error('Falta el JSON de la postulación.\n' + AYUDA)
    process.exit(1)
  }
  entorno.ALBUS_JOBS_APPLY = arg.startsWith('{') ? arg : readFileSync(arg, 'utf8')
} else {
  console.log(AYUDA)
  process.exit(comando === undefined ? 0 : 1)
}

const hijo = spawn('npx', ['electron-vite', 'dev'], {
  stdio: 'inherit',
  shell: true,
  env: entorno
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
function matarArbol() {
  if (hijo.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(hijo.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-hijo.pid, 'SIGKILL')
    }
  } catch {
    // Ya no estaba. Es el resultado que queríamos igual.
  }
}

for (const senal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(senal, () => {
    matarArbol()
    process.exit(1)
  })
}
process.on('exit', matarArbol)

hijo.on('close', (code) => process.exit(code ?? 0))
