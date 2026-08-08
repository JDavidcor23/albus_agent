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

let pasados = 0
let fallados = 0

function check(nombre: string, real: unknown, esperado: unknown): void {
  if (JSON.stringify(real) === JSON.stringify(esperado)) {
    pasados++
    console.log(`  ok    ${nombre}`)
  } else {
    fallados++
    console.log(`  FALLA ${nombre}`)
    console.log(`          esperado ${JSON.stringify(esperado)}`)
    console.log(`          real     ${JSON.stringify(real)}`)
  }
}

function espera(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Corre en la página y devuelve JSON. Nada de esto se arma con datos externos. */
const LEER_UI = `JSON.stringify((() => {
  const textos = (sel) => [...document.querySelectorAll(sel)].map((e) => (e.textContent || '').trim())
  const activa = document.querySelector('.tabs .pick-on')
  return {
    tabs: textos('.tabs .pick'),
    tabActiva: activa ? (activa.textContent || '').trim() : null,
    agentes: textos('.agente-nombre'),
    motivos: textos('.agente-motivo'),
    botones: textos('button'),
    hayFormulario: !!document.querySelector('.job-form'),
    hayModo: !!document.querySelector('.job-barra'),
    modos: textos('.job-barra .pick'),
    // El chat reemplazó al formulario: se le habla, no se llenan campos.
    hayChat: !!document.querySelector('.jobchat'),
    hayEntrada: !!document.querySelector('.jobchat-entrada input'),
    placeholderChat: (() => {
      const i = document.querySelector('.jobchat-entrada input')
      return i ? i.getAttribute('placeholder') || '' : ''
    })(),
    ejemplos: textos('.jobchat-vacio li'),
    hayConexiones: !!document.querySelector('.job-conexiones-btn'),
    conexionesTexto: (() => {
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
    await espera(4000)

    const crudo = (await win.webContents.executeJavaScript(LEER_UI)) as string
    const ui = JSON.parse(crudo) as {
      tabs: string[]
      tabActiva: string | null
      agentes: string[]
      motivos: string[]
      botones: string[]
      hayFormulario: boolean
      hayModo: boolean
      modos: string[]
      hayChat: boolean
      hayEntrada: boolean
      placeholderChat: string
      ejemplos: string[]
      hayConexiones: boolean
      conexionesTexto: string
    }

    console.log('── assert 10 · la pestaña existe y lista el registro')
    check('hay una pestaña "agentes"', ui.tabs.includes('agentes'), true)
    check('las otras pestañas siguen', ui.tabs, ['agentes', 'pendientes', 'extracciones', 'grafo'])
    check('abre en agentes', ui.tabActiva, 'agentes')
    check('el registro llegó por IPC', ui.agentes, ['Búsqueda de trabajo'])

    console.log('\n── assert 12 · al agente se le HABLA, no se le llenan campos')
    check('hay chat', ui.hayChat, true)
    check('con su campo para escribir', ui.hayEntrada, true)
    check('que invita a escribir, no a completar', /escribile/i.test(ui.placeholderChat), true)
    // Sin ejemplos, un chat vacío es una pantalla que no dice qué se puede pedir.
    check('y muestra ejemplos de qué pedir', ui.ejemplos.length >= 2, true)
    if (ui.ejemplos.length > 0) console.log(`          ejemplo: "${ui.ejemplos[0]}"`)

    // El formulario y sus perillas SE FUERON: el chat los reemplazó.
    check('ya no hay formulario de búsqueda', ui.hayFormulario, false)
    check('ya no hay perillas de dry-run/review/auto', ui.modos, [])
    check('tampoco el campo de "últimos días"', ui.hayModo, false)

    console.log('\n── conexiones: se conectan desde acá, no desde la terminal')
    check('hay botón de conexiones', ui.hayConexiones, true)
    check(
      'el botón dice qué falta, no manda a correr un comando',
      /npm run/.test(ui.conexionesTexto),
      false
    )
    console.log(`          botón: "${ui.conexionesTexto}"`)

    console.log('\n── lo que falta se muestra, no se esconde')
    // El agente reporta sus credenciales faltantes en la tarjeta. Hoy faltan
    // Notion y Gmail, así que el motivo TIENE que estar visible.
    check('la tarjeta dice qué le falta', ui.motivos.length >= 1, true)
    if (ui.motivos.length > 0) console.log(`          motivo: "${ui.motivos[0]}"`)

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
    await new Promise((r) => setTimeout(r, 1200))

    const conexiones = (await win.webContents.executeJavaScript(`(() => ({
      tarjetas: [...document.querySelectorAll('.conexion-grupo')].length,
      nombres: [...document.querySelectorAll('.conexion-nombre')].map((n) => n.textContent.trim()),
      textos: [...document.querySelectorAll('.conexion-para')].map((n) => n.textContent.trim())
    }))()`)) as { tarjetas: number; nombres: string[]; textos: string[] }

    check('hay tarjetas de conexión', conexiones.tarjetas >= 1, true)
    check(
      'Google aparece UNA vez como cuenta, no dos como servicios',
      conexiones.nombres.filter((n) => n === 'Google').length,
      1
    )
    check(
      'y ninguna descripción habla de postulaciones',
      conexiones.textos.some((t) => /postulaci|vacante/i.test(t)),
      false
    )

    // Sin esto la captura muestra lo que había arriba: el panel se abre al pie
    // de la pantalla y una foto de la parte equivocada no prueba nada.
    await win.webContents.executeJavaScript(
      `(() => { const g = document.querySelector('.conexion-grupo'); if (g) g.scrollIntoView({ block: 'start' }); return true })()`
    )
    await new Promise((r) => setTimeout(r, 600))

    const shotConn = join(dir, 'conexiones.png')
    await writeFile(shotConn, (await win.webContents.capturePage()).toPNG())
    console.log(`          captura: ${shotConn}`)
  } catch (error: unknown) {
    fallados++
    console.log(`  FALLA excepción leyendo la UI: ${String(error)}`)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }

  const total = pasados + fallados
  console.log(`\n${'='.repeat(60)}`)
  console.log(`UI DE AGENTES   ${pasados}/${total} ${fallados === 0 ? '✓' : '✗'}`)
  console.log(`${'='.repeat(60)}\n`)

  return fallados === 0
}
