import { BrowserWindow, type WebFrameMain } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import { z } from 'zod'
import type { BrowserPort, Inventario } from '../core/jobs/ports'
import type { FormModel } from '../core/jobs/types'
import { classifyButton } from '../core/jobs/submit-guard'
import { CLICK_TIMEOUT_MS, PARTITION, SETTLE_MS } from './session'
import {
  clickPorIdScript,
  clickScript,
  clickTextoScript,
  COUNT_FIELDS,
  escribirPorEtiquetaScript,
  escribirPorIdScript,
  extraerPatronScript,
  fillScript,
  hayTextoScript,
  INVENTARIO,
  READ_FORM
} from './page-scripts'

/**
 * El puerto de navegador, implementado con el Chromium que Electron ya trae.
 *
 * La sesión vive en una partición persistente: el usuario loguea LinkedIn UNA
 * vez adentro de Albus y la cookie queda en el disco del perfil de la app. No
 * hace falta relanzar su Chrome con `--remote-debugging-port`, no hace falta
 * cerrar sus pestañas, y no entra Playwright con sus 300 MB de navegadores.
 *
 * La ventana NO tiene preload ni nodeIntegration: adentro corre una página de
 * internet y no le damos ni una función nuestra.
 */

// Lo que vuelve de la página es input externo. Se valida entero, igual que una
// fila de Supabase — el DOM lo controla LinkedIn, no nosotros.
const OptionSchema = z.object({ value: z.string(), label: z.string() })

const FieldSchema = z.object({
  id: z.string(),
  selector: z.string(),
  kind: z.string(),
  label: z.string(),
  name: z.string(),
  placeholder: z.string(),
  required: z.boolean(),
  value: z.string(),
  options: z.array(OptionSchema),
  maxLength: z.number().nullable()
})

const FormSchema = z.object({
  url: z.string(),
  title: z.string(),
  fields: z.array(FieldSchema),
  buttons: z.array(z.object({ selector: z.string(), label: z.string() }))
})

const KINDS = new Set([
  'text',
  'textarea',
  'select',
  'radio',
  'checkbox',
  'file',
  'number',
  'tel',
  'email',
  'url',
  'date'
])

const AccionSchema = z.object({ ok: z.boolean(), error: z.string().optional() })

const ClickTextoSchema = z.object({
  ok: z.boolean(),
  texto: z.string().optional(),
  error: z.string().optional()
})

const ItemInventarioSchema = z.object({
  cid: z.string(),
  accion: z.enum(['click', 'escribir']),
  tag: z.string(),
  rol: z.string(),
  texto: z.string(),
  valor: z.string(),
  href: z.string(),
  deshabilitado: z.boolean(),
  rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
})

const InventarioSchema = z.object({
  url: z.string(),
  title: z.string(),
  enModal: z.boolean(),
  texto: z.string(),
  recortado: z.boolean().default(false),
  items: z.array(ItemInventarioSchema)
})

function espera(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export interface PageOptions {
  /** Mostrar la ventana. En `review` conviene: el usuario tiene que mirar. */
  visible: boolean
}

export function createBrowserPage(options: PageOptions): BrowserPort & { window: BrowserWindow } {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: options.visible,
    autoHideMenuBar: true,
    title: 'Albus — postulación',
    webPreferences: {
      partition: PARTITION,
      // Adentro corre LinkedIn. No hay preload, no hay Node, y el sandbox
      // queda en true — al revés que la ventana principal de la app.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  let debuggerAttached = false

  /**
   * El formulario no siempre está en el frame principal: Greenhouse y Lever se
   * embeben en un iframe dentro de la página de carreras de la empresa. Gana
   * el frame que más controles tenga.
   */
  async function pickFrame(): Promise<WebFrameMain> {
    const principal = win.webContents.mainFrame
    const frames = [principal, ...principal.framesInSubtree]

    let mejor = principal
    let max = -1

    for (const f of frames) {
      try {
        const n = (await f.executeJavaScript(COUNT_FIELDS)) as number
        if (typeof n === 'number' && n > max) {
          max = n
          mejor = f
        }
      } catch {
        // Un frame cross-origin que no nos deja ejecutar simplemente no compite.
      }
    }

    return mejor
  }

  async function ejecutar(script: string): Promise<string> {
    const frame = await pickFrame()
    return (await frame.executeJavaScript(script)) as string
  }

  async function accion(script: string, queHacia: string): Promise<void> {
    const crudo = await ejecutar(script)
    const r = AccionSchema.parse(JSON.parse(crudo))
    if (!r.ok) throw new Error(`${queHacia}: ${r.error ?? 'falló'}`)
  }

  return {
    window: win,

    async open(url: string): Promise<void> {
      await win.loadURL(url)
      // El HTML llegó, pero LinkedIn pinta el modal desde JavaScript. Sin este
      // respiro leemos un formulario que todavía no existe.
      await espera(SETTLE_MS)
    },

    currentUrl(): string {
      return win.webContents.getURL()
    },

    async readForm(): Promise<FormModel> {
      const crudo = await ejecutar(READ_FORM)
      const parsed = FormSchema.parse(JSON.parse(crudo))

      return {
        url: parsed.url,
        title: parsed.title,
        fields: parsed.fields.map((f) => ({
          ...f,
          kind: (KINDS.has(f.kind) ? f.kind : 'unknown') as FormModel['fields'][number]['kind']
        })),
        // La clasificación del botón se hace acá, no en la página: es la
        // decisión de la que depende el freno del submit.
        buttons: parsed.buttons.map((b) => ({ ...b, kind: classifyButton(b.label) }))
      }
    },

    async fill(selector: string, value: string): Promise<void> {
      await accion(fillScript(selector, value), 'llenar')
    },

    async uploadFile(selector: string, absolutePath: string): Promise<void> {
      // `input.files` es de solo lectura desde JavaScript por seguridad del
      // navegador. La única vía es el protocolo de depuración.
      const wc = win.webContents
      if (!debuggerAttached) {
        wc.debugger.attach('1.3')
        debuggerAttached = true
      }

      const { root } = (await wc.debugger.sendCommand('DOM.getDocument', { depth: -1 })) as {
        root: { nodeId: number }
      }

      const { nodeId } = (await wc.debugger.sendCommand('DOM.querySelector', {
        nodeId: root.nodeId,
        selector
      })) as { nodeId: number }

      if (!nodeId) throw new Error('no encontré el input de archivo')

      await wc.debugger.sendCommand('DOM.setFileInputFiles', {
        files: [resolvePath(absolutePath)],
        nodeId
      })
    },

    async click(selector: string): Promise<void> {
      await accion(clickScript(selector), 'clickear')
      await espera(CLICK_TIMEOUT_MS)
    },

    async screenshot(destPath: string): Promise<string> {
      const image = await win.webContents.capturePage()
      await mkdir(dirname(destPath), { recursive: true })
      await writeFile(destPath, image.toPNG())
      return destPath
    },

    /**
     * Miniatura en `data:` para que la UI la pueda mostrar.
     *
     * JPEG y no PNG: una captura de pantalla con texto pesa 4-5 veces más en
     * PNG, y esto viaja por IPC en cada paso. La calidad alcanza de sobra para
     * que el usuario reconozca qué pantalla estaba viendo Albus.
     */
    async capturaMiniatura(ancho = 520): Promise<string> {
      const image = await win.webContents.capturePage()
      const chica = image.resize({ width: ancho })
      return `data:image/jpeg;base64,${chica.toJPEG(72).toString('base64')}`
    },

    async hasSession(domain: string, cookieName: string): Promise<boolean> {
      const cookies = await win.webContents.session.cookies.get({ domain, name: cookieName })
      return cookies.length > 0
    },

    /**
     * Click por texto, REINTENTANDO hasta que aparezca.
     *
     * Antes esto ejecutaba el script una sola vez, y contra una SPA eso es
     * tirar una moneda: si Notion todavía no montó el botón, falla aunque el
     * botón esté por aparecer 300 ms después. Fue exactamente lo que rompió la
     * conexión de Notion en el paso "abrir el formulario". Ahora espera igual
     * que `esperarTexto`, que sí tenía el bucle desde el principio.
     */
    async clickTexto(textos: string[], exacto = false, timeoutMs = 8000): Promise<string> {
      const hasta = Date.now() + timeoutMs
      let ultimo = `no encontré "${textos.join('" / "')}"`

      for (;;) {
        try {
          const crudo = await ejecutar(clickTextoScript(textos, exacto))
          const r = ClickTextoSchema.parse(JSON.parse(crudo))
          if (r.ok) {
            await espera(CLICK_TIMEOUT_MS)
            return r.texto ?? ''
          }
          ultimo = r.error ?? ultimo
        } catch (error: unknown) {
          // La página puede estar navegando. Se reintenta hasta el límite.
          ultimo = error instanceof Error ? error.message : String(error)
        }

        if (Date.now() >= hasta) throw new Error(ultimo)
        await espera(600)
      }
    },

    async inventario(): Promise<Inventario> {
      const crudo = await ejecutar(INVENTARIO)
      return InventarioSchema.parse(JSON.parse(crudo))
    },

    async clickPorId(cid: string): Promise<string> {
      const crudo = await ejecutar(clickPorIdScript(cid))
      const r = ClickTextoSchema.parse(JSON.parse(crudo))
      if (!r.ok) throw new Error(r.error ?? 'no pude clickear ese elemento')
      await espera(CLICK_TIMEOUT_MS)
      return r.texto ?? ''
    },

    async escribirPorId(cid: string, valor: string): Promise<void> {
      await accion(escribirPorIdScript(cid, valor), 'escribir')
    },

    /**
     * Sí, este Chromium se inspecciona: es Chromium de verdad, no un visor.
     * Se abre en panel aparte para no taparle la página al usuario.
     */
    abrirDevTools(): void {
      if (win.isDestroyed()) return
      if (!win.webContents.isDevToolsOpened()) {
        win.webContents.openDevTools({ mode: 'detach' })
      }
    },

    async esperarTexto(textos: string[], timeoutMs: number): Promise<boolean> {
      const hasta = Date.now() + timeoutMs
      while (Date.now() < hasta) {
        try {
          const crudo = await ejecutar(hayTextoScript(textos))
          if (z.object({ ok: z.boolean() }).parse(JSON.parse(crudo)).ok) return true
        } catch {
          // La página puede estar navegando: se reintenta hasta el límite.
        }
        await espera(700)
      }
      return false
    },

    async extraerPatron(patron: string, bandera = ''): Promise<string | null> {
      const crudo = await ejecutar(extraerPatronScript(patron, bandera))
      const r = z
        .object({ ok: z.boolean(), valor: z.string().optional() })
        .parse(JSON.parse(crudo))
      return r.ok ? (r.valor ?? null) : null
    },

    async escribirEn(pistas: string[], valor: string): Promise<void> {
      await accion(escribirPorEtiquetaScript(pistas, valor), 'escribir')
    },

    async textoVisible(): Promise<string> {
      return (await ejecutar(
        `(document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 4000)`
      )) as string
    },

    reveal(): void {
      if (win.isDestroyed()) return
      win.show()
      win.focus()
    },

    async close(): Promise<void> {
      if (win.isDestroyed()) return
      if (debuggerAttached) {
        try {
          win.webContents.debugger.detach()
        } catch {
          // Ya estaba desconectado. No es un problema.
        }
        debuggerAttached = false
      }
      win.destroy()
    }
  }
}
