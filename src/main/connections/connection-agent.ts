import { app, clipboard } from 'electron'
import { join } from 'node:path'
import { createBrowserPage } from '../browser/page'
import type { BrowserPort } from '../core/jobs/ports'
import { achieveGoal, type RunModel } from './navigate-llm'
import { firstAvailableProvider } from '../providers/registry'

/**
 * UN motor para conectar CUALQUIER servicio. No hay uno por servicio.
 *
 * ## Por qué existe así
 *
 * La versión anterior era `notion-auto.ts`: 450 líneas con los pasos de Notion
 * escritos a mano —entrar, crear la integración, apretar "Show", abrir el menú
 * de tres puntos—. Funcionaba para Notion y para nada más. Agregar Supabase
 * significaba escribir `supabase-auto.ts` de cero, y después Vercel, y después
 * Stripe. Eso no escala y además no hace falta: el agente YA sabe navegar una
 * página de configuración, es lo que hace todo el día.
 *
 * Acá un servicio es DATOS, no código:
 *
 *   { url, goals: ['crear un token y mostrarlo'], secretPattern: 'sbp_...' }
 *
 * Sumar un servicio nuevo son cinco líneas en una tabla. Cero lógica nueva.
 *
 * ## Lo único que sigue siendo código, y por qué
 *
 * El agente no puede ver un DOM si nadie se lo pasa: `INVENTORY` lee la página
 * y se la describe. Pero eso se escribe UNA vez y sirve para cualquier sitio —
 * no es "el scraper de Notion", es la vista. Y el ejecutor es determinista a
 * propósito: el agente devuelve QUÉ elemento, nunca JavaScript para correr.
 *
 * ## El login no se automatiza, y no es una limitación técnica
 *
 * Si el agente detecta que hay que entrar, se muestra la ventana y se espera.
 * Meterle usuario y contraseña por script obligaría a Albus a guardarlas, y es
 * el patrón que dispara el antifraude de cualquier servicio serio.
 */

/**
 * Un objetivo. Si viene con `url`, el MOTOR navega ahí antes de empezarlo.
 *
 * Esa `url` no es un detalle de comodidad: **navegar no es una acción que el
 * agente pueda hacer.** Solo puede elegir elementos del inventario. Cuando el
 * objetivo decía "Ir a https://… y darle acceso", el agente contestó lo único
 * honesto que podía — *"no estamos en la página objetivo; ningún elemento
 * listado permite navegar a esa página"*— y tenía razón: le estábamos pidiendo
 * algo fuera de su repertorio.
 *
 * Y se queda del lado del motor a propósito. Darle al agente una acción
 * "navegá a esta URL" sería dejar que elija a dónde ir; acá el destino lo pone
 * la tabla de servicios, que es un dato que escribimos nosotros.
 */
export type Goal = string | { url: string; what: string }

export function goalText(g: Goal): string {
  return typeof g === 'string' ? g : g.what
}

export function goalUrl(g: Goal): string | null {
  return typeof g === 'string' ? null : g.url
}

export interface ConnectableService {
  id: string
  name: string
  /** Dónde empieza todo. La página de credenciales del servicio. */
  url: string
  /**
   * Qué tiene que lograr el agente, en castellano y en orden.
   *
   * Son objetivos, NO recetas de clicks. "Crear un token llamado Albus y
   * hacerlo visible" — no "apretá el botón azul de arriba a la derecha". El
   * día que el servicio rediseñe su panel, el objetivo sigue siendo verdad.
   */
  goals: Goal[]
  /**
   * Cómo se reconoce el secreto en la pantalla. Es lo que hace que esto sea
   * declarativo: cada servicio tiene su prefijo (`ntn_`, `sbp_`, `sk_live_`).
   */
  secretPattern: string
  /** Textos que delatan que la sesión no está iniciada. */
  loginTexts?: string[]
  /** Cuántas acciones puede hacer el agente por objetivo. El freno. */
  maxSteps?: number

  /**
   * La prueba de que quedó funcionando: preguntarle a la API del servicio.
   *
   * Que los clicks no hayan tirado no prueba nada. Esto sí.
   */
  verify?: (secret: string) => Promise<{ ok: boolean; detail: string }>

  /**
   * El plan B cuando el agente no puede, y no por torpeza.
   *
   * Otorgar un permiso es la categoría de cosas que NO se automatizan — es lo
   * mismo que el login. Notion, por diseño, no deja que una integración se
   * dé acceso a sí misma: sería escalada de privilegios, y por eso tampoco
   * hay API. Lo único que queda es su UI, y pelearse con un flyout que se
   * re-renderiza es una batalla que se pierde de a poco y para siempre.
   *
   * Así que se abre la página, se dice qué apretar, y se VERIFICA POR API
   * cada pocos segundos. El usuario hace diez segundos de trabajo una vez en
   * la vida, y Albus se entera solo — no hay que apretar "listo" ni volver a
   * correr nada.
   */
  askHuman?: {
    url: string
    instructions: string[]
    /** Cuánto se espera antes de rendirse. */
    timeoutMs?: number
  }
}

export interface ConnectionStep {
  step: string
  ok: boolean
  detail: string
  /** Miniatura en `data:`. El CSP del renderer bloquea `file://`. */
  screenshot?: string
}

export interface ConnectionResult {
  ok: boolean
  steps: ConnectionStep[]
  message: string
  /** El secreto. NUNCA sale de acá hacia el renderer. */
  secret: string | null
  /** `true` = mostrale al usuario el campo para pegarlo a mano. */
  fallBackToManual: boolean
}

export interface ConnectionOptions {
  onStep?: (p: ConnectionStep) => void
  /** Cuánto se espera a que el usuario entre, si hace falta. */
  loginTimeoutMs?: number
  screenshots?: boolean
}

function screenshotsDir(): string {
  try {
    return join(app.getPath('userData'), 'capturas')
  } catch {
    // Fuera de Electron (los chequeos con `npx tsx`) no hay userData.
    return join(process.cwd(), '.capturas')
  }
}

const DEFAULT_LOGIN_TEXTS = [
  'log in',
  'sign in',
  'iniciar sesión',
  'continue with email',
  'sign up',
  'create account'
]

/**
 * Señales de que YA se entró. Genéricas a propósito: son las palabras que
 * cualquier panel de cuenta muestra, no las de un servicio en particular.
 */
const SIGNED_IN = ['log out', 'sign out', 'cerrar sesión', 'settings', 'configuración', 'account']

/**
 * Buscar la credencial en la PANTALLA y en el PORTAPAPELES.
 *
 * Muchos paneles no dejan VER el secreto, solo copiarlo: Notion muestra
 * "Integration token" con el valor enmascarado y un botón de copiar. Leyendo
 * solo el DOM, el flujo llegaba a la página correcta y volvía con las manos
 * vacías — pasó, con "no aparece en la página" sobre la pantalla que lo tenía.
 *
 * Por eso "apretá Copy" es una acción legítima del agente, y acá se recoge el
 * resultado. Es genérico: cualquier servicio que solo permita copiar funciona.
 */
async function findSecret(browser: BrowserPort, pattern: string): Promise<string | null> {
  const onScreen = await browser.extractPattern(pattern)
  if (onScreen !== null) return onScreen

  try {
    const pasted = clipboard.readText()
    const m = pasted.match(new RegExp(pattern))
    if (m !== null) return m[0]
  } catch {
    // Sin portapapeles (headless, o el SO lo niega) se sigue con la pantalla.
  }

  return null
}

export async function connectWithAgent(
  service: ConnectableService,
  options: ConnectionOptions = {}
): Promise<ConnectionResult> {
  const steps: ConnectionStep[] = []

  const record = (step: string, ok: boolean, detail = '', screenshot?: string): void => {
    const p: ConnectionStep = { step, ok, detail, screenshot }
    steps.push(p)
    console.log(`[conexión:${service.id}] ${ok ? 'ok' : 'FALLA'} ${step}${detail ? ` — ${detail}` : ''}`)
    options.onStep?.(p)
  }

  const output = (
    ok: boolean,
    message: string,
    secret: string | null,
    fallBackToManual: boolean
  ): ConnectionResult => ({ ok, steps, message, secret, fallBackToManual })

  // Visible siempre: el usuario tiene que poder entrar con su clave, y tiene
  // derecho a ver qué está haciendo un proceso automático con su cuenta.
  const browser: BrowserPort = createBrowserPage({ visible: true })

  const provider = await firstAvailableProvider()
  if (provider === null) {
    await browser.close()
    record(
      'buscar quién maneje el navegador',
      false,
      'no hay ningún CLI de IA instalado (claude / agy). Sin eso esto no puede navegar solo.'
    )
    return output(false, 'no hay ningún CLI de IA instalado', null, true)
  }

  const runModel: RunModel = provider.run
  record('quién maneja el navegador', true, `${provider.id} (${provider.model})`)

  let n = 0
  const captureFile = async (): Promise<string | null> => {
    if (options.screenshots === false) return null
    try {
      return await browser.screenshot(
        join(screenshotsDir(), `${service.id}-${Date.now()}-${n++}.png`)
      )
    } catch {
      return null
    }
  }

  const captureUi = async (): Promise<string | undefined> => {
    if (options.screenshots === false) return undefined
    try {
      return await browser.thumbnail()
    } catch {
      return undefined
    }
  }

  // El portapapeles se vacía antes de empezar. Si al final tiene algo que
  // matchea el patrón, salió de esta corrida y no de algo que el usuario copió
  // hace media hora — que sería guardar una credencial vieja o ajena.
  const previousClipboard = (() => {
    try {
      const v = clipboard.readText()
      clipboard.writeText('')
      return v
    } catch {
      return null
    }
  })()

  const restoreClipboard = (): void => {
    // Cortesía: lo que el usuario tenía copiado vuelve a su lugar. Menos si es
    // el secreto — eso no se le deja pegado en el portapapeles a nadie.
    try {
      if (previousClipboard !== null && clipboard.readText() !== previousClipboard) {
        clipboard.writeText(previousClipboard)
      }
    } catch {
      // Sin portapapeles no hay nada que restaurar.
    }
  }

  try {
    await browser.open(service.url)
    record('abrir la página', true, service.url, await captureUi())

    // ── entrar, si hace falta ────────────────────────────────────────────
    const loginTexts = service.loginTexts ?? DEFAULT_LOGIN_TEXTS
    if (await browser.waitForText(loginTexts, 3000)) {
      // El agente decide CÓMO entrar: si el sitio ofrece "Continue with
      // Google" y hay sesión de Google en este navegador, lo resuelve solo.
      // No está hardcodeado que sea Google — es lo que el agente vea.
      const sso = await achieveGoal(
        browser,
        {
          goal:
            'Entrar a este sitio SIN escribir credenciales, usando una sesión que ya exista en este navegador ' +
            '(un botón de tipo "Continuar con Google" / "Continue with Google", o similar). ' +
            'Si la única forma de entrar es escribir un mail, una contraseña o un código, es IMPOSIBLE: decilo.'
        },
        runModel,
        {
          maxSteps: 4,
          capture: captureFile,
          onAction: (d, ok) => record(`entrar · ${d}`, ok, '')
        }
      )
      record('entrar sin escribir nada', sso.ok, sso.detail, await captureUi())

      if (!sso.ok) {
        // Se le pasa el teclado al usuario. Es la única parte manual, y es
        // deliberada: automatizar el login exige guardar la contraseña.
        browser.reveal()
        record(
          'te toca a vos',
          true,
          `entrá a ${service.name} en la ventana abierta. Es la única vez: la sesión queda guardada.`
        )

        const signedIn = await browser.waitForText(
          SIGNED_IN,
          options.loginTimeoutMs ?? 5 * 60_000
        )
        if (!signedIn) {
          record('iniciar sesión', false, 'se acabó el tiempo')
          return output(false, `no llegaste a entrar a ${service.name}`, null, true)
        }
      }

      // La SPA sigue montando después de mostrar el título.
      await browser.open(service.url)
      record('volver a la página de credenciales', true)
    } else {
      record('sesión', true, 'ya estabas adentro')
    }

    // ── los objetivos, en orden ──────────────────────────────────────────
    // Acá está todo lo que distingue un servicio de otro: una lista de frases.
    let secret: string | null = null

    for (const g of service.goals) {
      const goal = goalText(g)
      const target = goalUrl(g)

      // Navegar lo hace el motor: el agente no tiene esa acción, y pedírsela
      // era lo que hacía fallar el paso de compartir la base.
      if (target !== null) {
        await browser.open(target)
        record('ir a la página', true, target, await captureUi())
      }

      // Antes de gastar un turno, mirar si el secreto ya apareció: un objetivo
      // puede haberlo dejado a la vista —o en el portapapeles— de paso.
      if (secret === null) secret = await findSecret(browser, service.secretPattern)

      const r = await achieveGoal(browser, { goal }, runModel, {
        maxSteps: service.maxSteps ?? 8,
        capture: captureFile,
        onAction: (d, ok) => record(d, ok, '')
      })

      record(goal, r.ok, r.detail, await captureUi())

      if (!r.ok) {
        // Con el secreto ya en mano, un objetivo posterior que falla no tira
        // todo: se guarda lo que hay y se dice qué quedó pendiente.
        const alreadyHave = secret ?? (await findSecret(browser, service.secretPattern))
        if (alreadyHave !== null) {
          return output(
            false,
            `Conseguí la credencial, pero quedó pendiente: ${goal}. ${r.detail}`,
            alreadyHave,
            false
          )
        }
        return output(false, r.detail, null, true)
      }

      // Después de cada objetivo se vuelve a mirar: el secreto puede haber
      // aparecido recién ahora.
      if (secret === null) {
        for (let i = 0; i < 5 && secret === null; i++) {
          secret = await findSecret(browser, service.secretPattern)
          if (secret === null) await new Promise((res) => setTimeout(res, 700))
        }
        if (secret !== null) {
          record(
            'leer la credencial',
            true,
            `${secret.slice(0, 8)}… (${secret.length} caracteres)`
          )
        }
      }
    }

    /**
     * El rescate: los objetivos se cumplieron pero la credencial no apareció.
     *
     * Es el caso de la pantalla de Notion que dice "Integration token / Use
     * this token to authenticate API requests" con el valor tapado. Todo salió
     * bien y aun así no hay token, porque el panel no lo MUESTRA — solo deja
     * copiarlo. Antes de rendirse, se le pide al agente exactamente eso.
     *
     * Va acá y no dentro de los objetivos de cada servicio a propósito: es la
     * misma necesidad para todos, así que la sabe el motor. Un servicio nuevo
     * no tiene que acordarse de escribirlo.
     */
    if (secret === null) {
      const rescue = await achieveGoal(
        browser,
        {
          goal:
            `Hacer que la credencial de esta página quede DISPONIBLE. Empieza con un prefijo del estilo ` +
            `"${service.secretPattern.split('[')[0].split('|')[0]}". ` +
            `Puede estar tapada detrás de un botón "Show" / "Reveal" / un ícono de ojo — apretalo. ` +
            `Si el sitio NO permite verla y solo ofrece un botón de COPIAR ("Copy", "Copiar", un ícono de ` +
            `dos hojitas), apretá ESE: copiarla al portapapeles también sirve. ` +
            `Si hay que entrar a la integración desde una lista para llegar a su token, entrá primero.`
        },
        runModel,
        {
          maxSteps: 5,
          capture: captureFile,
          onAction: (d, ok) => record(`buscar la credencial · ${d}`, ok, '')
        }
      )
      record('hacer visible la credencial', rescue.ok, rescue.detail, await captureUi())

      for (let i = 0; i < 6 && secret === null; i++) {
        secret = await findSecret(browser, service.secretPattern)
        if (secret === null) await new Promise((res) => setTimeout(res, 700))
      }
    }

    if (secret === null) {
      const visible = (await browser.visibleText()).slice(0, 400)
      record(
        'leer la credencial',
        false,
        `ni en la pantalla ni en el portapapeles. Se veía: ${visible}`,
        await captureUi()
      )
      return output(false, 'hice los pasos pero no pude conseguir la credencial', null, true)
    }

    record('leer la credencial', true, `${secret.slice(0, 8)}… (${secret.length} caracteres)`)

    // ── ¿funciona de verdad? ─────────────────────────────────────────────
    if (service.verify === undefined) {
      return output(true, `${service.name} conectado`, secret, false)
    }

    // El llamador todavía no guardó el secreto, así que la verificación tiene
    // que poder usar ESTE valor y no el que haya guardado de antes.
    const v = await service.verify(secret)
    if (v.ok) {
      record('preguntarle a la API si funciona', true, v.detail)
      return output(true, `${service.name} conectado — ${v.detail}`, secret, false)
    }

    record('preguntarle a la API si funciona', false, v.detail, await captureUi())

    if (service.askHuman === undefined) {
      return output(false, v.detail, secret, false)
    }

    /**
     * El último tramo lo hace el usuario, y Albus se entera solo.
     *
     * No hay botón de "ya está": se pregunta a la API cada tres segundos. Un
     * botón sería una forma de que el usuario diga que hizo algo que no hizo,
     * y de volver a empezar por nada.
     */
    const request = service.askHuman
    await browser.open(request.url)
    browser.reveal()

    record(
      'te toca a vos — 10 segundos, una sola vez',
      true,
      request.instructions.join('  →  ')
    )

    const until = Date.now() + (request.timeoutMs ?? 4 * 60_000)
    let last = v.detail

    while (Date.now() < until) {
      await new Promise((res) => setTimeout(res, 3000))
      const again = await service.verify(secret)
      if (again.ok) {
        record('listo, lo detecté solo', true, again.detail)
        return output(true, `${service.name} conectado — ${again.detail}`, secret, false)
      }
      last = again.detail
    }

    record('esperar el permiso', false, `se acabó el tiempo. Último intento: ${last}`)
    return output(
      false,
      `El token quedó guardado. Falta darle acceso: ${request.instructions.join(' → ')}`,
      secret,
      false
    )
  } catch (error: unknown) {
    const m = error instanceof Error ? error.message : String(error)

    /**
     * Si la credencial ya se había leído, NO se pierde porque un paso posterior
     * explote.
     *
     * Pasó: el agente sacó el token, y al compartir la base el CLI se pasó de
     * los 120 s. El catch devolvía `null` y tiraba un token perfectamente
     * bueno — obligando a repetir los tres minutos de navegación por un
     * timeout que no tenía nada que ver.
     */
    const rescued = await findSecret(browser, service.secretPattern).catch(() => null)
    record('la corrida', false, m, await captureUi())

    if (rescued !== null) {
      record('la credencial se salva igual', true, 'no hay que volver a sacarla')
      return output(false, `${m} (pero la credencial quedó guardada)`, rescued, false)
    }

    return output(false, m, null, true)
  } finally {
    restoreClipboard()
    await browser.close()
  }
}
