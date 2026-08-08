import { BrowserWindow } from 'electron'
import { PARTITION } from '../browser/session'

/**
 * ¿Por qué Notion tira "something's not right" adentro de Albus y LinkedIn no?
 *
 * Hipótesis: el User-Agent. Electron manda `Electron/33.4.11 albus-agent/1.0.0`
 * en la cadena, y Notion filtra clientes que no reconoce. LinkedIn y Google no
 * miran eso, por eso esos dos andan y este no.
 *
 * Se mide cargando la MISMA página dos veces en la MISMA partición, cambiando
 * solo el UA. Si con el UA de Chrome carga y con el de Electron no, la
 * hipótesis queda confirmada y el arreglo es una línea.
 *
 *   node scripts/run-jobs.mjs notion-probe
 */

/** Un Chrome de verdad, de la misma familia que el Chromium que Electron trae. */
export function uaDeChrome(): string {
  const chrome = process.versions.chrome
  return (
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${chrome} Safari/537.36`
  )
}

function espera(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function cargarYLeer(
  etiqueta: string,
  ua: string | null,
  url: string,
  particion: string = PARTITION
): Promise<{ titulo: string; texto: string; ua: string }> {
  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    show: false,
    webPreferences: {
      partition: particion,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  try {
    if (ua !== null) win.webContents.setUserAgent(ua)

    const enviado = win.webContents.getUserAgent()

    // `loadURL` rechaza si la navegación se aborta, y una SPA que redirige
    // aborta la navegación original todo el tiempo. Eso NO es un fallo de
    // carga: hay que mirar la página, no la promesa.
    try {
      await win.loadURL(url)
    } catch (error: unknown) {
      console.log(`   (loadURL rechazó: ${String(error).slice(0, 80)} — sigo y miro la página)`)
    }

    // La SPA tarda: sin esto se lee el HTML vacío del shell.
    await espera(10_000)

    const texto = (await win.webContents.executeJavaScript(
      `(document.body.innerText || '').replace(/\\n{2,}/g, ' | ').trim().slice(0, 300)`
    )) as string

    const titulo = win.webContents.getTitle()
    const urlFinal = win.webContents.getURL()
    console.log(`\n── ${etiqueta}`)
    console.log(`   UA enviado : ${enviado}`)
    console.log(`   URL final  : ${urlFinal}`)
    console.log(`   título     : ${titulo}`)
    console.log(`   en pantalla: ${texto || '(vacío)'}`)

    return { titulo, texto, ua: enviado }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

const ROTO = /something'?s not right|status page|we're working on it/i

export async function probarNotion(): Promise<boolean> {
  console.log('\n══ ¿POR QUÉ NOTION FALLA ADENTRO DE ALBUS? ══')
  console.log(`   Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`)

  const URL = 'https://www.notion.so/profile/integrations'

  // Tres casos que aíslan las dos hipótesis a la vez:
  //   A y B cambian solo el UA, sobre la partición compartida.
  //   C usa el MISMO UA de Electron pero una partición que nadie más tiene.
  // Si A y B fallan y C anda, no es el UA: es el candado del almacenamiento.
  const compartida = await cargarYLeer('partición compartida · UA de Electron', null, URL)
  const conChrome = await cargarYLeer('partición compartida · UA de Chrome', uaDeChrome(), URL)
  const exclusiva = await cargarYLeer(
    'partición EXCLUSIVA · UA de Electron',
    null,
    URL,
    'persist:albus-probe-exclusiva'
  )

  const vacio = (t: string): boolean => t.trim() === '' || ROTO.test(t)

  console.log(`\n${'='.repeat(64)}`)
  console.log(`   compartida + UA Electron → ${vacio(compartida.texto) ? 'ROTO' : 'carga bien'}`)
  console.log(`   compartida + UA Chrome   → ${vacio(conChrome.texto) ? 'ROTO' : 'carga bien'}`)
  console.log(`   EXCLUSIVA  + UA Electron → ${vacio(exclusiva.texto) ? 'ROTO' : 'carga bien'}`)

  if (vacio(compartida.texto) && !vacio(exclusiva.texto)) {
    console.log('\n   CONFIRMADO: es el candado de la partición, no el User-Agent.')
    console.log('   Dos instancias de Albus no pueden compartir el almacenamiento de Chromium.')
  } else if (vacio(compartida.texto) && vacio(exclusiva.texto)) {
    console.log('\n   Falla con las dos particiones: no es el candado. Buscar en otro lado.')
  } else {
    console.log('\n   No se reprodujo ahora mismo.')
  }
  console.log('='.repeat(64))

  return !vacio(exclusiva.texto)
}
