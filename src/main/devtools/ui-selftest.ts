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
 * Los selectores y los textos esperados quedan en castellano a propósito: son
 * el DOM y la copy del renderer, que no se traducen.
 */
const READ_UI = `JSON.stringify((() => {
  const texts = (sel) => [...document.querySelectorAll(sel)].map((e) => (e.textContent || '').trim())
  const active = document.querySelector('.tabs .pick-on')
  return {
    tabs: texts('.tabs .pick'),
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
    hasConnections: !!document.querySelector('.job-conexiones-btn'),
    connectionsText: (() => {
      const b = document.querySelector('.job-conexiones-btn')
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
      hasConnections: boolean
      connectionsText: string
    }

    console.log('── assert 10 · la pestaña existe y lista el registro')
    check('hay una pestaña "agentes"', ui.tabs.includes('agentes'), true)
    check('las otras pestañas siguen', ui.tabs, ['agentes', 'pendientes', 'extracciones', 'grafo'])
    check('abre en agentes', ui.activeTab, 'agentes')
    check('el registro llegó por IPC', ui.agents, ['Búsqueda de trabajo'])

    console.log('\n── assert 12 · al agente se le HABLA, no se le llenan campos')
    check('hay chat', ui.hasChat, true)
    check('con su campo para escribir', ui.hasInput, true)
    check('que invita a escribir, no a completar', /escribile/i.test(ui.chatPlaceholder), true)
    // Sin ejemplos, un chat vacío es una pantalla que no dice qué se puede pedir.
    check('y muestra ejemplos de qué pedir', ui.examples.length >= 2, true)
    if (ui.examples.length > 0) console.log(`          ejemplo: "${ui.examples[0]}"`)

    // El formulario y sus perillas SE FUERON: el chat los reemplazó.
    check('ya no hay formulario de búsqueda', ui.hasForm, false)
    check('ya no hay perillas de dry-run/review/auto', ui.modes, [])
    check('tampoco el campo de "últimos días"', ui.hasModeBar, false)

    console.log('\n── conexiones: se conectan desde acá, no desde la terminal')
    check('hay botón de conexiones', ui.hasConnections, true)
    check(
      'el botón dice qué falta, no manda a correr un comando',
      /npm run/.test(ui.connectionsText),
      false
    )
    console.log(`          botón: "${ui.connectionsText}"`)

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
    console.log('\n── conexiones: una tarjeta por CUENTA, no por mecanismo')

    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.job-conexiones-btn'); if (b) b.click(); return true })()`
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
