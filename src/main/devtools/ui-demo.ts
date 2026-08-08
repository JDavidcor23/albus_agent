import { app, BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'

/**
 * Maneja la app de verdad y saca capturas: abre conexiones, dispara una
 * búsqueda real y espera los resultados.
 *
 *   node scripts/run-jobs.mjs demo
 *
 * Existe porque "los botones no están bien diseñados" no se verifica leyendo
 * el JSX. Un assert sobre el DOM prueba que los nodos están; la captura prueba
 * que se ven, y en qué orden los lee el ojo.
 *
 * Además cronometra la búsqueda: el detalle de las vacantes pasó de secuencial
 * a cuatro en paralelo y este es el número que dice si sirvió.
 */

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * `capturePage()` devuelve un buffer VACÍO cada tanto — cuando la ventana no
 * se está componiendo, cuando el compositor está ocupado, sin avisar. Escribir
 * ese buffer deja un PNG de 0 bytes que parece una captura y no lo es.
 * Se reintenta hasta que tenga bytes.
 */
async function capture(win: BrowserWindow, name: string): Promise<string> {
  const dir = join(app.getPath('userData'), 'ui-selftest')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${name}.png`)

  for (let i = 0; i < 5; i++) {
    win.show()
    win.focus()
    await wait(500)
    const png = (await win.webContents.capturePage()).toPNG()
    if (png.length > 1000) {
      await writeFile(path, png)
      console.log(`  captura → ${path} (${Math.round(png.length / 1024)} KB)`)
      return path
    }
  }

  console.log(`  OJO la captura "${name}" salió vacía cinco veces`)
  return ''
}

/** Click por texto: no dependemos de clases que el rediseño puede mover. */
function clickByText(text: string): string {
  return `JSON.stringify((() => {
    const b = [...document.querySelectorAll('button')]
      .find((e) => (e.textContent || '').trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())}))
    if (!b) return { ok: false }
    b.click()
    return { ok: true, text: (b.textContent || '').trim() }
  })())`
}

function clickBySelector(selector: string): string {
  return `JSON.stringify((() => {
    const b = document.querySelector(${JSON.stringify(selector)})
    if (!b) return { ok: false }
    b.click()
    return { ok: true, text: (b.textContent || '').trim() }
  })())`
}

const COUNT_CARDS = `JSON.stringify({
  cards: document.querySelectorAll('.job-card').length,
  actions: [...document.querySelectorAll('.btn-accion')].map((b) => (b.textContent || '').trim()),
  secondary: [...document.querySelectorAll('.btn-secundario')].map((b) => (b.textContent || '').trim()),
  summary: (document.querySelector('.job-resumen-txt') || {}).textContent || '',
  progress: (document.querySelector('.processing-hint') || {}).textContent || '',
  // La descripción es el pedido concreto: poder leer de qué se trata la
  // vacante sin salir de Albus. Un largo de cero dice que el detalle no llegó.
  descriptions: [...document.querySelectorAll('.job-desc')].map((d) => (d.textContent || '').length),
  expanders: document.querySelectorAll('.job-desc-toggle').length
})`

export async function runUiDemo(): Promise<boolean> {
  console.log('\n══ DEMO: manejando la app de verdad ══\n')

  // Visible a propósito: con `show:false` Chromium no repinta y `capturePage`
  // devuelve el último frame que tenía — la primera corrida sacó una foto del
  // "buscando…" cuando los resultados ya estaban en el DOM.
  const win = new BrowserWindow({
    width: 1400,
    height: 950,
    show: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })

  try {
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      await win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      await win.loadFile(join(__dirname, '../renderer/index.html'))
    }
    await wait(4000)

    // 1 · el panel de conexiones. Por CLASE y no por texto: la tarjeta del
    // agente dice "sin conectar: …" y se llevaba el click, colapsando el panel.
    const opened = JSON.parse(
      (await win.webContents.executeJavaScript(clickBySelector('.job-conexiones-btn'))) as string
    ) as { ok: boolean }
    console.log(`  panel de conexiones: ${opened.ok ? 'abierto' : 'NO se encontró el botón'}`)
    await wait(1500)
    await capture(win, 'conexiones')

    // Se cierra para que la captura de resultados no lo tenga encima.
    await win.webContents.executeJavaScript(clickBySelector('.job-conexiones-btn'))
    await wait(800)

    // 2 · una búsqueda real, cronometrada
    console.log('\n  disparando "buscame trabajos"…')
    const t0 = Date.now()
    const fired = JSON.parse(
      (await win.webContents.executeJavaScript(clickByText('buscame trabajos'))) as string
    ) as { ok: boolean }

    if (!fired.ok) {
      console.log('  FALLA no encontré el botón de búsqueda')
      return false
    }

    // Hasta 10 minutos: scrapea, trae los detalles, puntúa, y si el lote sale
    // corto amplía el rango y repite. Con las descripciones reales adentro del
    // prompt, cada vuelta de puntaje es varias veces más pesada que antes.
    let state = {
      cards: 0,
      actions: [] as string[],
      secondary: [] as string[],
      summary: '',
      progress: '',
      descriptions: [] as number[],
      expanders: 0
    }
    for (let i = 0; i < 120; i++) {
      await wait(5000)
      state = JSON.parse(
        (await win.webContents.executeJavaScript(COUNT_CARDS)) as string
      ) as typeof state
      if (state.summary !== '') break
      if (i % 4 === 0 && state.progress !== '') console.log(`    ${state.progress}`)
    }

    const seconds = Math.round((Date.now() - t0) / 1000)
    console.log(`\n  la búsqueda tardó ${seconds}s (antes: 106s)`)
    console.log(`  tarjetas: ${state.cards}`)
    console.log(`  resumen: ${state.summary}`)
    console.log(`  acción principal por tarjeta: ${JSON.stringify(state.actions)}`)
    console.log(`  acción secundaria: ${JSON.stringify(state.secondary)}`)
    console.log(`  largo de cada descripción: ${JSON.stringify(state.descriptions)}`)
    console.log(`  tarjetas con "leer la vacante completa": ${state.expanders}`)

    // Se oculta el panel de conexiones por CSS en vez de clickear el toggle:
    // el click depende del estado de React y ya nos dejó dos capturas con el
    // panel encima de las tarjetas. Esconderlo es determinista.
    await win.webContents.executeJavaScript(`(() => {
      const p = document.querySelector('.conexiones')
      if (p) p.style.display = 'none'
      const c = document.querySelector('.job-card')
      if (c) c.scrollIntoView({ block: 'start' })
    })()`)

    // React ya tiene el estado, pero el frame puede no estar pintado todavía.
    await wait(1500)
    await capture(win, 'resultados')

    // Y una de la tarjeta con la vacante abierta, que es el pedido concreto:
    // poder leer de qué se trata sin salir de Albus.
    await win.webContents.executeJavaScript(`(() => {
      const t = document.querySelector('.job-desc-toggle')
      if (t) t.click()
    })()`)
    await wait(1200)
    await win.webContents.executeJavaScript(`(() => {
      const c = document.querySelector('.job-card')
      if (c) c.scrollIntoView({ block: 'start' })
    })()`)
    await wait(800)
    await capture(win, 'tarjeta-abierta')

    // Una tarjeta con una sola acción principal es el punto del rediseño.
    const oneActionPerCard = state.actions.length === state.cards
    console.log(
      `\n  ${oneActionPerCard ? 'ok   ' : 'FALLA'} una acción principal por tarjeta ` +
        `(${state.actions.length} acciones / ${state.cards} tarjetas)`
    )

    // La descripción tiene que estar. Un `null` en un campo que ni usamos ya
    // se la tragó una vez en silencio, y las tarjetas decían "sin descripción"
    // con el texto ahí, intacto, en el JSON del CLI.
    const withText = state.descriptions.filter((n) => n > 200).length
    console.log(
      `  ${withText === state.cards ? 'ok   ' : 'FALLA'} todas las tarjetas traen la vacante ` +
        `(${withText}/${state.cards} con más de 200 caracteres)`
    )

    return state.cards > 0 && oneActionPerCard && withText === state.cards
  } catch (error: unknown) {
    console.log(`  FALLA ${String(error)}`)
    return false
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
