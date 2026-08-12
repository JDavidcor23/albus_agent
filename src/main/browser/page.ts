import { BrowserWindow, type WebFrameMain } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import { z } from 'zod'
import type { BrowserPort, Inventory } from '../core/jobs/ports'
import type { FormModel } from '../core/jobs/types'
import { classifyButton } from '../core/jobs/submit-guard'
import { isApplicableUrl, unwrapLinkedInRedirect } from '../../shared/ipc'
import { CLICK_TIMEOUT_MS, NAVIGATION_TIMEOUT_MS, PARTITION, SETTLE_MS } from './session'
import {
  clickByIdScript,
  clickScript,
  clickTextScript,
  COUNT_FIELDS,
  extractPatternScript,
  fillScript,
  hasTextScript,
  INVENTORY,
  READ_FORM,
  typeByIdScript,
  typeByLabelScript
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
  // `default` y no requerido: el script vive en un template literal que el
  // typecheck no puede verificar, así que un desajuste no puede tumbar la lectura.
  inModal: z.boolean().default(false),
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

const ActionSchema = z.object({ ok: z.boolean(), error: z.string().optional() })

const ClickTextSchema = z.object({
  ok: z.boolean(),
  text: z.string().optional(),
  error: z.string().optional()
})

// El espejo exacto de lo que emite `INVENTORY` en page-scripts.ts. `action` es
// el par acoplado: el script lo escribe desde adentro de la página, acá se
// valida, y el enum de zod de connections/navigate-llm.ts lo consume.
const InventoryItemSchema = z.object({
  cid: z.string(),
  action: z.enum(['click', 'type']),
  tag: z.string(),
  role: z.string(),
  text: z.string(),
  value: z.string(),
  href: z.string(),
  disabled: z.boolean(),
  rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
})

const InventorySchema = z.object({
  url: z.string(),
  title: z.string(),
  inModal: z.boolean(),
  text: z.string(),
  truncated: z.boolean().default(false),
  items: z.array(InventoryItemSchema)
})

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Para los mensajes. Una URL que no parsea se muestra entera antes que perderla. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export interface PageOptions {
  /** Mostrar la ventana. En `review` conviene: el usuario tiene que mirar. */
  visible: boolean
}

export function createBrowserPage(
  options: PageOptions
): BrowserPort & { window: BrowserWindow; blockedPopups: () => string[] } {
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

  /** Hosts que la página quiso abrir y no estaban permitidos. Se reportan. */
  const blockedPopups: string[] = []

  /**
   * Las postulaciones EXTERNAS se siguen en ESTA ventana.
   *
   * La mayoría de las vacantes no son "Easy Apply": LinkedIn muestra un botón
   * que abre el ATS de la empresa —Greenhouse, Lever, Workable, Ashby— con
   * `target="_blank"`. Sin este handler, Electron abría una ventana nueva que
   * este código NO controla, `win` se quedaba en LinkedIn, y `readForm()`
   * devolvía la misma página sin campos. El bucle la veía estancada y terminaba
   * en `filled` —"campos llenados"— sin haber llenado uno solo.
   *
   * Ese es el modo de falla más caro que hay: no tira, no loguea, y reporta
   * éxito. El usuario recibía "listo, están todos los formularios llenos" con
   * nueve pestañas vacías abiertas y cero postulaciones hechas.
   *
   * Se navega en la misma ventana en vez de dejar abrir la nueva porque la
   * sesión, el debugger y `readForm()` viven acá.
   */
  win.webContents.setWindowOpenHandler(({ url }) => {
    /*
     * Primero se DESENVUELVE el interstitial de LinkedIn.
     *
     * `linkedin.com/safety/go?url=<destino>` pasaba la allowlist por ser
     * linkedin.com, se cargaba con `loadURL`, y LinkedIn lo rechazaba comiéndose
     * el parámetro: quedaba `/safety/go/?_l=es_ES` — "Página no encontrada". El
     * destino real viajaba adentro todo el tiempo.
     */
    const unwrapped = unwrapLinkedInRedirect(url)

    /*
     * Y acá se mueve una frontera, a conciencia.
     *
     * Un destino que sale del interstitial de LinkedIn se sigue AUNQUE su host no
     * esté en `APPLICABLE_HOSTS`. El motivo: cada empresa hospeda su formulario
     * donde quiere —Monks lo tiene en `www.monks.com`— y una allowlist de hosts no
     * puede cubrir "la página de carreras de cualquier empresa del mundo". Mantener
     * esa lista es la automatización a mano que este proyecto viene sacando.
     *
     * Lo que autoriza no es la lista: es que el usuario apretó "postular" sobre ESA
     * vacante, y el link salió de ESA publicación. La provenance es el permiso.
     *
     * Lo que sigue bloqueado es todo lo demás: los popups que la página abre sola
     * —trackers, ads, lo que sea— no tienen esa provenance y no pasan.
     */
    if (unwrapped !== null) {
      console.log(`[browser] LinkedIn redirige a ${hostOf(unwrapped)} — sigo el destino real`)
      void win.loadURL(unwrapped)
      return { action: 'deny' }
    }

    if (isApplicableUrl(url)) {
      console.log(`[browser] la postulación sigue en ${new URL(url).hostname}`)
      void win.loadURL(url)
    } else {
      // No se abre y no se calla: un popup a un host desconocido con la sesión
      // del usuario adentro no es inocente, y su ausencia explica por qué el
      // formulario nunca apareció.
      //
      // El HOST va aparte de la URL porque es el dato accionable: si ese host
      // es el ATS de la empresa, el arreglo es agregarlo a `APPLICABLE_HOSTS`.
      // Decir solo "fuera de la allowlist" obligaba a ir a leer el código para
      // entender qué hacer con eso.
      blockedPopups.push(url)
      console.warn(
        `[browser] popup BLOQUEADO: "${hostOf(url)}" no está en la allowlist de postulación`
      )
      console.warn(`[browser]   url completa: ${url}`)
      console.warn('[browser]   si ese host es el ATS de la empresa, falta en')
      console.warn('[browser]   APPLICABLE_HOSTS (src/shared/ipc.ts) — la postulación se queda acá')
    }
    return { action: 'deny' }
  })

  /*
   * Cada navegación queda registrada.
   *
   * Es lo que separa "la IA no encontró el botón" de "el click nos llevó al ATS
   * y el formulario está en otro lado". Sin esto las dos se ven idénticas desde
   * afuera: la ventana quieta y un `blocked` al final. Con esto, la ausencia de
   * una línea después del click ES el diagnóstico.
   */
  win.webContents.on('did-navigate', (_event, url) => {
    console.log(`[browser] navegó a ${url}`)
  })

  win.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    // Las SPA navegan sin recargar: Greenhouse embebido cambia de paso así.
    if (isMainFrame) console.log(`[browser] navegó dentro de la página a ${url}`)
  })

  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    // `-3` es ABORTED, y pasa en toda navegación que otra reemplaza. No es un
    // error: reportarlo como tal manda a diagnosticar algo que no está roto.
    if (code === -3) return
    console.warn(`[browser] NO cargó ${url} — ${description} (${code})`)
  })

  let debuggerAttached = false

  /**
   * El formulario no siempre está en el frame principal: Greenhouse y Lever se
   * embeben en un iframe dentro de la página de carreras de la empresa. Gana
   * el frame que más controles tenga.
   */
  async function pickFrame(): Promise<WebFrameMain> {
    const mainFrame = win.webContents.mainFrame
    const frames = [mainFrame, ...mainFrame.framesInSubtree]

    let best = mainFrame
    let max = -1

    for (const f of frames) {
      try {
        const n = (await f.executeJavaScript(COUNT_FIELDS)) as number
        if (typeof n === 'number' && n > max) {
          max = n
          best = f
        }
      } catch {
        // Un frame cross-origin que no nos deja ejecutar simplemente no compite.
      }
    }

    return best
  }

  async function evaluate(script: string): Promise<string> {
    const frame = await pickFrame()
    return (await frame.executeJavaScript(script)) as string
  }

  async function runAction(script: string, whatItWasDoing: string): Promise<void> {
    const raw = await evaluate(script)
    const r = ActionSchema.parse(JSON.parse(raw))
    if (!r.ok) throw new Error(`${whatItWasDoing}: ${r.error ?? 'falló'}`)
  }

  return {
    window: win,

    /**
     * Los popups que se denegaron, para quien tenga que explicar el resultado.
     *
     * La lista se juntaba desde siempre y no salía a ningún lado: el comentario
     * decía "se reportan" y nadie las leía nunca. Un `blocked` cuyo motivo real
     * fue un host fuera de la allowlist terminaba contado como "no encontré
     * formulario en esa página", que culpa a la página de una decisión nuestra.
     */
    blockedPopups: (): string[] => [...blockedPopups],

    async open(url: string): Promise<void> {
      await win.loadURL(url)
      // El HTML llegó, pero LinkedIn pinta el modal desde JavaScript. Sin este
      // respiro leemos un formulario que todavía no existe.
      await wait(SETTLE_MS)
    },

    currentUrl(): string {
      return win.webContents.getURL()
    },

    async readForm(): Promise<FormModel> {
      const raw = await evaluate(READ_FORM)
      const parsed = FormSchema.parse(JSON.parse(raw))

      return {
        url: parsed.url,
        title: parsed.title,
        inModal: parsed.inModal,
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
      await runAction(fillScript(selector, value), 'llenar')
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
      const before = win.webContents.getURL()
      console.log(`[browser] click en ${selector}`)
      await runAction(clickScript(selector), 'clickear')
      await wait(CLICK_TIMEOUT_MS)

      /*
       * Si el click nos mandó a otra página, hay que ESPERAR a que cargue.
       *
       * "Apply" en una vacante externa navega al ATS de la empresa, y un ATS
       * tarda bastante más que un modal de LinkedIn. Sin esta espera,
       * `readForm()` corría sobre la página vieja o sobre una a medio pintar,
       * devolvía cero campos, y el bucle lo leía como "no queda nada por
       * llenar" — terminando en éxito sin haber tocado el formulario.
       */
      if (win.webContents.getURL() !== before || win.webContents.isLoading()) {
        try {
          if (win.webContents.isLoading()) {
            await new Promise<void>((done) => {
              const finish = (): void => {
                clearTimeout(timer)
                win.webContents.off('did-stop-loading', finish)
                done()
              }
              const timer = setTimeout(finish, NAVIGATION_TIMEOUT_MS)
              win.webContents.once('did-stop-loading', finish)
            })
          }
          // El HTML llegó pero Greenhouse y Lever pintan el formulario desde
          // JavaScript, igual que el modal de LinkedIn.
          await wait(SETTLE_MS)
        } catch {
          // Una navegación que no termina no puede colgar la postulación: se
          // sigue y `readForm()` dirá qué hay.
        }
      } else {
        /*
         * El click no movió la página. Se dice, porque es la mitad silenciosa
         * del diagnóstico: cuando la postulación es externa y el popup quedó
         * denegado, esto es lo ÚNICO que pasa — y sin esta línea el log muestra
         * un click y después nada, que se lee como si el click hubiera fallado.
         */
        console.log(`[browser] el click no navegó — seguimos en ${hostOf(before)}`)
      }
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
    async thumbnail(width = 520): Promise<string> {
      const image = await win.webContents.capturePage()
      const small = image.resize({ width })
      return `data:image/jpeg;base64,${small.toJPEG(72).toString('base64')}`
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
     * que `waitForText`, que sí tenía el bucle desde el principio.
     */
    async clickText(texts: string[], exact = false, timeoutMs = 8000): Promise<string> {
      const until = Date.now() + timeoutMs
      let last = `no encontré "${texts.join('" / "')}"`

      for (;;) {
        try {
          const raw = await evaluate(clickTextScript(texts, exact))
          const r = ClickTextSchema.parse(JSON.parse(raw))
          if (r.ok) {
            await wait(CLICK_TIMEOUT_MS)
            return r.text ?? ''
          }
          last = r.error ?? last
        } catch (error: unknown) {
          // La página puede estar navegando. Se reintenta hasta el límite.
          last = error instanceof Error ? error.message : String(error)
        }

        if (Date.now() >= until) throw new Error(last)
        await wait(600)
      }
    },

    async inventory(): Promise<Inventory> {
      const raw = await evaluate(INVENTORY)
      return InventorySchema.parse(JSON.parse(raw))
    },

    async clickById(cid: string): Promise<string> {
      const raw = await evaluate(clickByIdScript(cid))
      const r = ClickTextSchema.parse(JSON.parse(raw))
      if (!r.ok) throw new Error(r.error ?? 'no pude clickear ese elemento')
      await wait(CLICK_TIMEOUT_MS)
      return r.text ?? ''
    },

    async typeById(cid: string, value: string): Promise<void> {
      await runAction(typeByIdScript(cid, value), 'escribir')
    },

    /**
     * Sí, este Chromium se inspecciona: es Chromium de verdad, no un visor.
     * Se abre en panel aparte para no taparle la página al usuario.
     */
    openDevTools(): void {
      if (win.isDestroyed()) return
      if (!win.webContents.isDevToolsOpened()) {
        win.webContents.openDevTools({ mode: 'detach' })
      }
    },

    async waitForText(texts: string[], timeoutMs: number): Promise<boolean> {
      const until = Date.now() + timeoutMs
      while (Date.now() < until) {
        try {
          const raw = await evaluate(hasTextScript(texts))
          if (z.object({ ok: z.boolean() }).parse(JSON.parse(raw)).ok) return true
        } catch {
          // La página puede estar navegando: se reintenta hasta el límite.
        }
        await wait(700)
      }
      return false
    },

    async extractPattern(pattern: string, flags = ''): Promise<string | null> {
      const raw = await evaluate(extractPatternScript(pattern, flags))
      const r = z.object({ ok: z.boolean(), value: z.string().optional() }).parse(JSON.parse(raw))
      return r.ok ? (r.value ?? null) : null
    },

    async typeByLabel(hints: string[], value: string): Promise<void> {
      await runAction(typeByLabelScript(hints, value), 'escribir')
    },

    async visibleText(): Promise<string> {
      // `document.body` es null mientras el documento navega. Ver el comentario
      // de INVENTORY en `page-scripts.ts`: ya tiró un TypeError en producción.
      return (await evaluate(
        `((document.body && document.body.innerText) || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 4000)`
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
