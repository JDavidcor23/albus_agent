import { app, clipboard } from 'electron'
import { join } from 'node:path'
import { createBrowserPage } from '../browser/page'
import type { BrowserPort } from '../core/jobs/ports'
import { lograrObjetivo, type CorrerModelo } from './navigate-llm'
import { primerProviderDisponible } from '../providers/registry'

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
 *   { url, objetivos: ['crear un token y mostrarlo'], patronSecreto: 'sbp_...' }
 *
 * Sumar un servicio nuevo son cinco líneas en una tabla. Cero lógica nueva.
 *
 * ## Lo único que sigue siendo código, y por qué
 *
 * El agente no puede ver un DOM si nadie se lo pasa: `INVENTARIO` lee la página
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
export type Objetivo = string | { url: string; que: string }

export function textoObjetivo(o: Objetivo): string {
  return typeof o === 'string' ? o : o.que
}

export function urlObjetivo(o: Objetivo): string | null {
  return typeof o === 'string' ? null : o.url
}

export interface ServicioConectable {
  id: string
  nombre: string
  /** Dónde empieza todo. La página de credenciales del servicio. */
  url: string
  /**
   * Qué tiene que lograr el agente, en castellano y en orden.
   *
   * Son objetivos, NO recetas de clicks. "Crear un token llamado Albus y
   * hacerlo visible" — no "apretá el botón azul de arriba a la derecha". El
   * día que el servicio rediseñe su panel, el objetivo sigue siendo verdad.
   */
  objetivos: Objetivo[]
  /**
   * Cómo se reconoce el secreto en la pantalla. Es lo que hace que esto sea
   * declarativo: cada servicio tiene su prefijo (`ntn_`, `sbp_`, `sk_live_`).
   */
  patronSecreto: string
  /** Textos que delatan que la sesión no está iniciada. */
  textosLogin?: string[]
  /** Cuántas acciones puede hacer el agente por objetivo. El freno. */
  maxPasos?: number

  /**
   * La prueba de que quedó funcionando: preguntarle a la API del servicio.
   *
   * Que los clicks no hayan tirado no prueba nada. Esto sí.
   */
  verificar?: (secreto: string) => Promise<{ ok: boolean; detalle: string }>

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
  pedirAlHumano?: {
    url: string
    instrucciones: string[]
    /** Cuánto se espera antes de rendirse. */
    timeoutMs?: number
  }
}

export interface PasoConexion {
  paso: string
  ok: boolean
  detalle: string
  /** Miniatura en `data:`. El CSP del renderer bloquea `file://`. */
  captura?: string
}

export interface ResultadoConexion {
  ok: boolean
  pasos: PasoConexion[]
  mensaje: string
  /** El secreto. NUNCA sale de acá hacia el renderer. */
  secreto: string | null
  /** `true` = mostrale al usuario el campo para pegarlo a mano. */
  caerAManual: boolean
}

export interface OpcionesConexion {
  onPaso?: (p: PasoConexion) => void
  /** Cuánto se espera a que el usuario entre, si hace falta. */
  timeoutLoginMs?: number
  capturas?: boolean
}

function carpetaCapturas(): string {
  try {
    return join(app.getPath('userData'), 'capturas')
  } catch {
    // Fuera de Electron (los chequeos con `npx tsx`) no hay userData.
    return join(process.cwd(), '.capturas')
  }
}

const LOGIN_POR_DEFECTO = [
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
const ADENTRO = ['log out', 'sign out', 'cerrar sesión', 'settings', 'configuración', 'account']

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
async function buscarSecreto(browser: BrowserPort, patron: string): Promise<string | null> {
  const enPantalla = await browser.extraerPatron(patron)
  if (enPantalla !== null) return enPantalla

  try {
    const pegado = clipboard.readText()
    const m = pegado.match(new RegExp(patron))
    if (m !== null) return m[0]
  } catch {
    // Sin portapapeles (headless, o el SO lo niega) se sigue con la pantalla.
  }

  return null
}

export async function conectarConAgente(
  servicio: ServicioConectable,
  opciones: OpcionesConexion = {}
): Promise<ResultadoConexion> {
  const pasos: PasoConexion[] = []

  const registrar = (paso: string, ok: boolean, detalle = '', captura?: string): void => {
    const p: PasoConexion = { paso, ok, detalle, captura }
    pasos.push(p)
    console.log(`[conexión:${servicio.id}] ${ok ? 'ok' : 'FALLA'} ${paso}${detalle ? ` — ${detalle}` : ''}`)
    opciones.onPaso?.(p)
  }

  const salida = (
    ok: boolean,
    mensaje: string,
    secreto: string | null,
    caerAManual: boolean
  ): ResultadoConexion => ({ ok, pasos, mensaje, secreto, caerAManual })

  // Visible siempre: el usuario tiene que poder entrar con su clave, y tiene
  // derecho a ver qué está haciendo un proceso automático con su cuenta.
  const browser: BrowserPort = createBrowserPage({ visible: true })

  const proveedor = await primerProviderDisponible()
  if (proveedor === null) {
    await browser.close()
    registrar(
      'buscar quién maneje el navegador',
      false,
      'no hay ningún CLI de IA instalado (claude / agy). Sin eso esto no puede navegar solo.'
    )
    return salida(false, 'no hay ningún CLI de IA instalado', null, true)
  }

  const correr: CorrerModelo = proveedor.correr
  registrar('quién maneja el navegador', true, `${proveedor.id} (${proveedor.modelo})`)

  let n = 0
  const capturarArchivo = async (): Promise<string | null> => {
    if (opciones.capturas === false) return null
    try {
      return await browser.screenshot(
        join(carpetaCapturas(), `${servicio.id}-${Date.now()}-${n++}.png`)
      )
    } catch {
      return null
    }
  }

  const capturarUi = async (): Promise<string | undefined> => {
    if (opciones.capturas === false) return undefined
    try {
      return await browser.capturaMiniatura()
    } catch {
      return undefined
    }
  }

  // El portapapeles se vacía antes de empezar. Si al final tiene algo que
  // matchea el patrón, salió de esta corrida y no de algo que el usuario copió
  // hace media hora — que sería guardar una credencial vieja o ajena.
  const portapapelesPrevio = (() => {
    try {
      const v = clipboard.readText()
      clipboard.writeText('')
      return v
    } catch {
      return null
    }
  })()

  const restaurarPortapapeles = (): void => {
    // Cortesía: lo que el usuario tenía copiado vuelve a su lugar. Menos si es
    // el secreto — eso no se le deja pegado en el portapapeles a nadie.
    try {
      if (portapapelesPrevio !== null && clipboard.readText() !== portapapelesPrevio) {
        clipboard.writeText(portapapelesPrevio)
      }
    } catch {
      // Sin portapapeles no hay nada que restaurar.
    }
  }

  try {
    await browser.open(servicio.url)
    registrar('abrir la página', true, servicio.url, await capturarUi())

    // ── entrar, si hace falta ────────────────────────────────────────────
    const textosLogin = servicio.textosLogin ?? LOGIN_POR_DEFECTO
    if (await browser.esperarTexto(textosLogin, 3000)) {
      // El agente decide CÓMO entrar: si el sitio ofrece "Continue with
      // Google" y hay sesión de Google en este navegador, lo resuelve solo.
      // No está hardcodeado que sea Google — es lo que el agente vea.
      const sso = await lograrObjetivo(
        browser,
        {
          objetivo:
            'Entrar a este sitio SIN escribir credenciales, usando una sesión que ya exista en este navegador ' +
            '(un botón de tipo "Continuar con Google" / "Continue with Google", o similar). ' +
            'Si la única forma de entrar es escribir un mail, una contraseña o un código, es IMPOSIBLE: decilo.'
        },
        correr,
        {
          maxPasos: 4,
          capturar: capturarArchivo,
          onAccion: (d, ok) => registrar(`entrar · ${d}`, ok, '')
        }
      )
      registrar('entrar sin escribir nada', sso.ok, sso.detalle, await capturarUi())

      if (!sso.ok) {
        // Se le pasa el teclado al usuario. Es la única parte manual, y es
        // deliberada: automatizar el login exige guardar la contraseña.
        browser.reveal()
        registrar(
          'te toca a vos',
          true,
          `entrá a ${servicio.nombre} en la ventana abierta. Es la única vez: la sesión queda guardada.`
        )

        const entro = await browser.esperarTexto(
          ADENTRO,
          opciones.timeoutLoginMs ?? 5 * 60_000
        )
        if (!entro) {
          registrar('iniciar sesión', false, 'se acabó el tiempo')
          return salida(false, `no llegaste a entrar a ${servicio.nombre}`, null, true)
        }
      }

      // La SPA sigue montando después de mostrar el título.
      await browser.open(servicio.url)
      registrar('volver a la página de credenciales', true)
    } else {
      registrar('sesión', true, 'ya estabas adentro')
    }

    // ── los objetivos, en orden ──────────────────────────────────────────
    // Acá está todo lo que distingue un servicio de otro: una lista de frases.
    let secreto: string | null = null

    for (const obj of servicio.objetivos) {
      const objetivo = textoObjetivo(obj)
      const destino = urlObjetivo(obj)

      // Navegar lo hace el motor: el agente no tiene esa acción, y pedírsela
      // era lo que hacía fallar el paso de compartir la base.
      if (destino !== null) {
        await browser.open(destino)
        registrar('ir a la página', true, destino, await capturarUi())
      }

      // Antes de gastar un turno, mirar si el secreto ya apareció: un objetivo
      // puede haberlo dejado a la vista —o en el portapapeles— de paso.
      if (secreto === null) secreto = await buscarSecreto(browser, servicio.patronSecreto)

      const r = await lograrObjetivo(browser, { objetivo }, correr, {
        maxPasos: servicio.maxPasos ?? 8,
        capturar: capturarArchivo,
        onAccion: (d, ok) => registrar(d, ok, '')
      })

      registrar(objetivo, r.ok, r.detalle, await capturarUi())

      if (!r.ok) {
        // Con el secreto ya en mano, un objetivo posterior que falla no tira
        // todo: se guarda lo que hay y se dice qué quedó pendiente.
        const yaTengo = secreto ?? (await buscarSecreto(browser, servicio.patronSecreto))
        if (yaTengo !== null) {
          return salida(
            false,
            `Conseguí la credencial, pero quedó pendiente: ${objetivo}. ${r.detalle}`,
            yaTengo,
            false
          )
        }
        return salida(false, r.detalle, null, true)
      }

      // Después de cada objetivo se vuelve a mirar: el secreto puede haber
      // aparecido recién ahora.
      if (secreto === null) {
        for (let i = 0; i < 5 && secreto === null; i++) {
          secreto = await buscarSecreto(browser, servicio.patronSecreto)
          if (secreto === null) await new Promise((res) => setTimeout(res, 700))
        }
        if (secreto !== null) {
          registrar(
            'leer la credencial',
            true,
            `${secreto.slice(0, 8)}… (${secreto.length} caracteres)`
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
    if (secreto === null) {
      const rescate = await lograrObjetivo(
        browser,
        {
          objetivo:
            `Hacer que la credencial de esta página quede DISPONIBLE. Empieza con un prefijo del estilo ` +
            `"${servicio.patronSecreto.split('[')[0].split('|')[0]}". ` +
            `Puede estar tapada detrás de un botón "Show" / "Reveal" / un ícono de ojo — apretalo. ` +
            `Si el sitio NO permite verla y solo ofrece un botón de COPIAR ("Copy", "Copiar", un ícono de ` +
            `dos hojitas), apretá ESE: copiarla al portapapeles también sirve. ` +
            `Si hay que entrar a la integración desde una lista para llegar a su token, entrá primero.`
        },
        correr,
        {
          maxPasos: 5,
          capturar: capturarArchivo,
          onAccion: (d, ok) => registrar(`buscar la credencial · ${d}`, ok, '')
        }
      )
      registrar('hacer visible la credencial', rescate.ok, rescate.detalle, await capturarUi())

      for (let i = 0; i < 6 && secreto === null; i++) {
        secreto = await buscarSecreto(browser, servicio.patronSecreto)
        if (secreto === null) await new Promise((res) => setTimeout(res, 700))
      }
    }

    if (secreto === null) {
      const visible = (await browser.textoVisible()).slice(0, 400)
      registrar(
        'leer la credencial',
        false,
        `ni en la pantalla ni en el portapapeles. Se veía: ${visible}`,
        await capturarUi()
      )
      return salida(false, 'hice los pasos pero no pude conseguir la credencial', null, true)
    }

    registrar('leer la credencial', true, `${secreto.slice(0, 8)}… (${secreto.length} caracteres)`)

    // ── ¿funciona de verdad? ─────────────────────────────────────────────
    if (servicio.verificar === undefined) {
      return salida(true, `${servicio.nombre} conectado`, secreto, false)
    }

    // El llamador todavía no guardó el secreto, así que la verificación tiene
    // que poder usar ESTE valor y no el que haya guardado de antes.
    const v = await servicio.verificar(secreto)
    if (v.ok) {
      registrar('preguntarle a la API si funciona', true, v.detalle)
      return salida(true, `${servicio.nombre} conectado — ${v.detalle}`, secreto, false)
    }

    registrar('preguntarle a la API si funciona', false, v.detalle, await capturarUi())

    if (servicio.pedirAlHumano === undefined) {
      return salida(false, v.detalle, secreto, false)
    }

    /**
     * El último tramo lo hace el usuario, y Albus se entera solo.
     *
     * No hay botón de "ya está": se pregunta a la API cada tres segundos. Un
     * botón sería una forma de que el usuario diga que hizo algo que no hizo,
     * y de volver a empezar por nada.
     */
    const pedido = servicio.pedirAlHumano
    await browser.open(pedido.url)
    browser.reveal()

    registrar(
      'te toca a vos — 10 segundos, una sola vez',
      true,
      pedido.instrucciones.join('  →  ')
    )

    const hasta = Date.now() + (pedido.timeoutMs ?? 4 * 60_000)
    let ultimo = v.detalle

    while (Date.now() < hasta) {
      await new Promise((res) => setTimeout(res, 3000))
      const otra = await servicio.verificar(secreto)
      if (otra.ok) {
        registrar('listo, lo detecté solo', true, otra.detalle)
        return salida(true, `${servicio.nombre} conectado — ${otra.detalle}`, secreto, false)
      }
      ultimo = otra.detalle
    }

    registrar('esperar el permiso', false, `se acabó el tiempo. Último intento: ${ultimo}`)
    return salida(
      false,
      `El token quedó guardado. Falta darle acceso: ${pedido.instrucciones.join(' → ')}`,
      secreto,
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
    const rescatado = await buscarSecreto(browser, servicio.patronSecreto).catch(() => null)
    registrar('la corrida', false, m, await capturarUi())

    if (rescatado !== null) {
      registrar('la credencial se salva igual', true, 'no hay que volver a sacarla')
      return salida(false, `${m} (pero la credencial quedó guardada)`, rescatado, false)
    }

    return salida(false, m, null, true)
  } finally {
    restaurarPortapapeles()
    await browser.close()
  }
}
