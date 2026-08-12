import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'

/**
 * Asserts de la pestaña de agentes contra el renderer de verdad.
 *
 * No alcanza con que TypeScript compile: el contrato que importa es que la
 * pestaña exista, que el registro llegue por IPC y que el botón que dispara
 * todo esté ahí. Eso solo se puede afirmar mirando el DOM real.
 *
 *   npm run ui:selftest
 */

let passed = 0
let failed = 0

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    console.log(`  FALLA ${name}`)
    console.log(`          esperado ${JSON.stringify(expected)}`)
    console.log(`          real     ${JSON.stringify(actual)}`)
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Corre en la página y devuelve JSON. Nada de esto se arma con datos externos.
 *
 * Los nombres de clase siguen en castellano (`.agente-*`, `.conexion-*`) aunque
 * la copy pasó a inglés: renombrarlos es un diff enorme que el usuario no ve y
 * donde un typo rompe un estilo sin que nada avise. Los TEXTOS esperados, en
 * cambio, son lo que el usuario lee y van en inglés.
 */
const READ_UI = `JSON.stringify((() => {
  const texts = (sel) => [...document.querySelectorAll(sel)].map((e) => (e.textContent || '').trim())
  const active = document.querySelector('.rail-item-on')
  return {
    tabs: texts('.rail-nav .rail-item'),
    activeTab: active ? (active.textContent || '').trim() : null,
    agents: texts('.agente-nombre'),
    reasons: texts('.agente-motivo'),
    buttons: texts('button'),
    hasForm: !!document.querySelector('.job-form'),
    hasModeBar: !!document.querySelector('.job-barra'),
    modes: texts('.job-barra .pick'),
    // El chat reemplazó al formulario: se le habla, no se llenan campos.
    hasChat: !!document.querySelector('.jobchat'),
    hasInput: !!document.querySelector('.jobchat-entrada input'),
    chatPlaceholder: (() => {
      const i = document.querySelector('.jobchat-entrada input')
      return i ? i.getAttribute('placeholder') || '' : ''
    })(),
    examples: texts('.jobchat-vacio li'),
    pipelineButton: (() => {
      const b = document.querySelector('.jobchat-pipeline')
      return b ? (b.textContent || '').trim() : ''
    })()
  }
})())`

export async function runUiSelfTest(): Promise<boolean> {
  console.log('\n══ AUTOCHEQUEO DE LA PESTAÑA DE AGENTES ══\n')

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })

  try {
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      await win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      await win.loadFile(join(__dirname, '../renderer/index.html'))
    }

    // React monta y después pide los agentes por IPC. Sin este respiro leemos
    // la pantalla de "buscando agentes…".
    await wait(4000)

    const raw = (await win.webContents.executeJavaScript(READ_UI)) as string
    const ui = JSON.parse(raw) as {
      tabs: string[]
      activeTab: string | null
      agents: string[]
      reasons: string[]
      buttons: string[]
      hasForm: boolean
      hasModeBar: boolean
      modes: string[]
      hasChat: boolean
      hasInput: boolean
      chatPlaceholder: string
      examples: string[]
      pipelineButton: string
    }

    console.log('── assert 10 · el rail existe y la conversación abre primero')
    check('el rail tiene la conversación', ui.tabs.includes('Chat'), true)
    check('y los destinos secundarios', ui.tabs, ['Chat', 'Extractions', 'Graph', 'Tasks'])
    check('abre en Chat', ui.activeTab, 'Chat')
    check('el registro llegó por IPC', ui.agents, ['Búsqueda de trabajo'])

    console.log('\n── assert 12 · al agente se le HABLA, no se le llenan campos')
    check('hay chat', ui.hasChat, true)
    check('con su campo para escribir', ui.hasInput, true)
    check('que invita a escribir, no a completar', /escribile/i.test(ui.chatPlaceholder), true)
    /*
     * El barrido es UNA acción, así que se dispara con un botón.
     *
     * Antes acá se verificaba lo contrario: que hubiera ejemplos clickeables
     * ("buscame trabajo, hacé un barrido"). El problema no era el assert sino
     * lo que pedía — invitar a escribir el rol contradice que los roles salgan
     * de las reglas del usuario, y esa frase de ejemplo terminaba viajando
     * cruda a LinkedIn como término de búsqueda.
     */
    check('el barrido se dispara con un botón', ui.pipelineButton !== '', true)
    check('y no pidiéndole que escriba el rol', ui.examples, [])
    if (ui.pipelineButton !== '') console.log(`          botón: "${ui.pipelineButton}"`)

    // El formulario y sus perillas SE FUERON: el chat los reemplazó.
    check('ya no hay formulario de búsqueda', ui.hasForm, false)
    check('ya no hay perillas de dry-run/review/auto', ui.modes, [])
    check('tampoco el campo de "últimos días"', ui.hasModeBar, false)

    console.log('\n── lo que falta se muestra, no se esconde')
    // El agente reporta sus credenciales faltantes en la tarjeta. Hoy faltan
    // Notion y Gmail, así que el motivo TIENE que estar visible.
    check('la tarjeta dice qué le falta', ui.reasons.length >= 1, true)
    if (ui.reasons.length > 0) console.log(`          motivo: "${ui.reasons[0]}"`)

    // Evidencia mirable. Un assert sobre el DOM prueba que los nodos están;
    // la captura prueba que además se ve.
    const { app } = await import('electron')
    const { mkdir, writeFile } = await import('node:fs/promises')
    const dir = join(app.getPath('userData'), 'ui-selftest')
    await mkdir(dir, { recursive: true })
    const shot = join(dir, 'agentes.png')
    await writeFile(shot, (await win.webContents.capturePage()).toPNG())
    console.log(`\n          captura: ${shot}`)

    // ── el panel de conexiones ─────────────────────────────────────────────
    // Se abre y se mira: es donde estaban los dos "Google" que no se entendían.
    // Vive en Settings, al que se llega por el rail.
    console.log('\n── conexiones: una tarjeta por CUENTA, no por mecanismo')

    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.rail-item[data-view="settings"]'); if (b) b.click(); return true })()`
    )
    await wait(1200)

    const connections = (await win.webContents.executeJavaScript(`(() => ({
      cards: [...document.querySelectorAll('.conexion-grupo')].length,
      names: [...document.querySelectorAll('.conexion-nombre')].map((n) => n.textContent.trim()),
      texts: [...document.querySelectorAll('.conexion-para')].map((n) => n.textContent.trim())
    }))()`)) as { cards: number; names: string[]; texts: string[] }

    check('hay tarjetas de conexión', connections.cards >= 1, true)
    check(
      'Google aparece UNA vez como cuenta, no dos como servicios',
      connections.names.filter((n) => n === 'Google').length,
      1
    )
    check(
      'y ninguna descripción habla de postulaciones',
      connections.texts.some((t) => /postulaci|vacante/i.test(t)),
      false
    )

    // Sin esto la captura muestra lo que había arriba: el panel se abre al pie
    // de la pantalla y una foto de la parte equivocada no prueba nada.
    await win.webContents.executeJavaScript(
      `(() => { const g = document.querySelector('.conexion-grupo'); if (g) g.scrollIntoView({ block: 'start' }); return true })()`
    )
    await wait(600)

    const shotConn = join(dir, 'conexiones.png')
    await writeFile(shotConn, (await win.webContents.capturePage()).toPNG())
    console.log(`          captura: ${shotConn}`)
  } catch (error: unknown) {
    failed++
    console.log(`  FALLA excepción leyendo la UI: ${String(error)}`)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }

  const total = passed + failed
  console.log(`\n${'='.repeat(60)}`)
  console.log(`UI DE AGENTES   ${passed}/${total} ${failed === 0 ? '✓' : '✗'}`)
  console.log(`${'='.repeat(60)}\n`)

  return failed === 0
}
