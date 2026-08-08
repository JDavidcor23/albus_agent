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

function espera(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * `capturePage()` devuelve un buffer VACÍO cada tanto — cuando la ventana no
 * se está componiendo, cuando el compositor está ocupado, sin avisar. Escribir
 * ese buffer deja un PNG de 0 bytes que parece una captura y no lo es.
 * Se reintenta hasta que tenga bytes.
 */
async function capturar(win: BrowserWindow, nombre: string): Promise<string> {
  const dir = join(app.getPath('userData'), 'ui-selftest')
  await mkdir(dir, { recursive: true })
  const ruta = join(dir, `${nombre}.png`)

  for (let i = 0; i < 5; i++) {
    win.show()
    win.focus()
    await espera(500)
    const png = (await win.webContents.capturePage()).toPNG()
    if (png.length > 1000) {
      await writeFile(ruta, png)
      console.log(`  captura → ${ruta} (${Math.round(png.length / 1024)} KB)`)
      return ruta
    }
  }

  console.log(`  OJO la captura "${nombre}" salió vacía cinco veces`)
  return ''
}

/** Click por texto: no dependemos de clases que el rediseño puede mover. */
function clickPorTexto(texto: string): string {
  return `JSON.stringify((() => {
    const b = [...document.querySelectorAll('button')]
      .find((e) => (e.textContent || '').trim().toLowerCase().includes(${JSON.stringify(texto.toLowerCase())}))
    if (!b) return { ok: false }
    b.click()
    return { ok: true, texto: (b.textContent || '').trim() }
  })())`
}

function clickPorClase(selector: string): string {
  return `JSON.stringify((() => {
    const b = document.querySelector(${JSON.stringify(selector)})
    if (!b) return { ok: false }
    b.click()
    return { ok: true, texto: (b.textContent || '').trim() }
  })())`
}

const CONTAR_TARJETAS = `JSON.stringify({
  tarjetas: document.querySelectorAll('.job-card').length,
  acciones: [...document.querySelectorAll('.btn-accion')].map((b) => (b.textContent || '').trim()),
  secundarios: [...document.querySelectorAll('.btn-secundario')].map((b) => (b.textContent || '').trim()),
  resumen: (document.querySelector('.job-resumen-txt') || {}).textContent || '',
  progreso: (document.querySelector('.processing-hint') || {}).textContent || '',
  // La descripción es el pedido concreto: poder leer de qué se trata la
  // vacante sin salir de Albus. Un largo de cero dice que el detalle no llegó.
  descripciones: [...document.querySelectorAll('.job-desc')].map((d) => (d.textContent || '').length),
  expansores: document.querySelectorAll('.job-desc-toggle').length
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
    await espera(4000)

    // 1 · el panel de conexiones. Por CLASE y no por texto: la tarjeta del
    // agente dice "sin conectar: …" y se llevaba el click, colapsando el panel.
    const abrio = JSON.parse(
      (await win.webContents.executeJavaScript(clickPorClase('.job-conexiones-btn'))) as string
    ) as { ok: boolean }
    console.log(`  panel de conexiones: ${abrio.ok ? 'abierto' : 'NO se encontró el botón'}`)
    await espera(1500)
    await capturar(win, 'conexiones')

    // Se cierra para que la captura de resultados no lo tenga encima.
    await win.webContents.executeJavaScript(clickPorClase('.job-conexiones-btn'))
    await espera(800)

    // 2 · una búsqueda real, cronometrada
    console.log('\n  disparando "buscame trabajos"…')
    const t0 = Date.now()
    const disparo = JSON.parse(
      (await win.webContents.executeJavaScript(clickPorTexto('buscame trabajos'))) as string
    ) as { ok: boolean }

    if (!disparo.ok) {
      console.log('  FALLA no encontré el botón de búsqueda')
      return false
    }

    // Hasta 10 minutos: scrapea, trae los detalles, puntúa, y si el lote sale
    // corto amplía el rango y repite. Con las descripciones reales adentro del
    // prompt, cada vuelta de puntaje es varias veces más pesada que antes.
    let estado = {
      tarjetas: 0,
      acciones: [] as string[],
      secundarios: [] as string[],
      resumen: '',
      progreso: '',
      descripciones: [] as number[],
      expansores: 0
    }
    for (let i = 0; i < 120; i++) {
      await espera(5000)
      estado = JSON.parse(
        (await win.webContents.executeJavaScript(CONTAR_TARJETAS)) as string
      ) as typeof estado
      if (estado.resumen !== '') break
      if (i % 4 === 0 && estado.progreso !== '') console.log(`    ${estado.progreso}`)
    }

    const seg = Math.round((Date.now() - t0) / 1000)
    console.log(`\n  la búsqueda tardó ${seg}s (antes: 106s)`)
    console.log(`  tarjetas: ${estado.tarjetas}`)
    console.log(`  resumen: ${estado.resumen}`)
    console.log(`  acción principal por tarjeta: ${JSON.stringify(estado.acciones)}`)
    console.log(`  acción secundaria: ${JSON.stringify(estado.secundarios)}`)
    console.log(`  largo de cada descripción: ${JSON.stringify(estado.descripciones)}`)
    console.log(`  tarjetas con "leer la vacante completa": ${estado.expansores}`)

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
    await espera(1500)
    await capturar(win, 'resultados')

    // Y una de la tarjeta con la vacante abierta, que es el pedido concreto:
    // poder leer de qué se trata sin salir de Albus.
    await win.webContents.executeJavaScript(`(() => {
      const t = document.querySelector('.job-desc-toggle')
      if (t) t.click()
    })()`)
    await espera(1200)
    await win.webContents.executeJavaScript(`(() => {
      const c = document.querySelector('.job-card')
      if (c) c.scrollIntoView({ block: 'start' })
    })()`)
    await espera(800)
    await capturar(win, 'tarjeta-abierta')

    // Una tarjeta con una sola acción principal es el punto del rediseño.
    const unaAccionPorTarjeta = estado.acciones.length === estado.tarjetas
    console.log(
      `\n  ${unaAccionPorTarjeta ? 'ok   ' : 'FALLA'} una acción principal por tarjeta ` +
        `(${estado.acciones.length} acciones / ${estado.tarjetas} tarjetas)`
    )

    // La descripción tiene que estar. Un `null` en un campo que ni usamos ya
    // se la tragó una vez en silencio, y las tarjetas decían "sin descripción"
    // con el texto ahí, intacto, en el JSON del CLI.
    const conTexto = estado.descripciones.filter((n) => n > 200).length
    console.log(
      `  ${conTexto === estado.tarjetas ? 'ok   ' : 'FALLA'} todas las tarjetas traen la vacante ` +
        `(${conTexto}/${estado.tarjetas} con más de 200 caracteres)`
    )

    return estado.tarjetas > 0 && unaAccionPorTarjeta && conTexto === estado.tarjetas
  } catch (error: unknown) {
    console.log(`  FALLA ${String(error)}`)
    return false
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
