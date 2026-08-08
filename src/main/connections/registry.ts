import { shell } from 'electron'
import type { ConnectionInfo } from '../../shared/ipc'
import { setNotionDatabaseIdResolver, setNotionTokenResolver } from '../notion/client'
import { setGoogleRefreshTokenResolver } from '../drive/client'
import {
  borrarSecreto,
  cifradoDisponible,
  CLAVES,
  guardarSecreto,
  origenDelSecreto,
  secretoOEntorno
} from './store'
import { conectarGoogle } from './google-oauth'
import { hasLinkedInSession, openLoginWindow } from '../browser/session'

/**
 * Las conexiones de Albus, con las DOS vías que pidió el usuario:
 *
 * - `navegador`: se abre una ventana, das OK, listo. Sin terminal, sin editar
 *   archivos, sin buscar nada.
 * - `token`: pegás la credencial en un campo y se guarda cifrada.
 *
 * Los servicios que soportan OAuth exponen las dos; los que no —Notion, que
 * para una integración interna solo da un token— exponen la de pegar más un
 * botón que te deja parado en la página exacta donde está el token. Eso es lo
 * máximo que se puede automatizar sin registrar una integración pública.
 */

export type ViaConexion = 'navegador' | 'token'

/**
 * Cómo cada servicio le cuenta al usuario qué está haciendo, mientras lo hace.
 *
 * No es un log de debug: es la única ventana que tiene el usuario a un proceso
 * que abre un navegador y toca su cuenta. Un `console.log` en la terminal del
 * main no le sirve a alguien que está mirando la app.
 */
export type ReportarPaso = (p: {
  paso: string
  ok: boolean
  detalle: string
  captura?: string
}) => void

export interface ServicioDefinicion {
  id: string
  nombre: string
  /**
   * Qué DA el conector, no qué hace un agente con él.
   *
   * Decía "Espeja tus postulaciones en Registro de aplicaciones" — que es lo
   * que el agente de trabajo hace con Notion, no lo que Notion es. Reclamo del
   * usuario, y correcto: *"estos conectores no solo son para estos agentes...
   * una cosa son las reglas, otra cosa son los conectores"*. Un conector es
   * una capacidad de la app; qué se hace con ella lo deciden las reglas.
   */
  paraQue: string
  /**
   * Servicios que son la MISMA cuenta se agrupan en una tarjeta.
   *
   * Google aparecía dos veces —el token de API y la sesión del navegador— y
   * para el usuario eso es una sola cuenta con dos permisos. Son mecanismos
   * distintos de verdad, así que siguen siendo entradas separadas acá; lo que
   * cambia es cómo se muestran.
   */
  grupo?: string
  /** El nombre de ESTA capacidad dentro del grupo. Ej: "correo y Drive". */
  capacidad?: string
  vias: ViaConexion[]
  /** Página donde el usuario obtiene el token, si la vía es pegar. */
  dondeSacarlo: string
  estado: () => Promise<{ conectado: boolean; origen: string; detalle: string }>
  conectarNavegador?: (onPaso?: ReportarPaso) => Promise<{ ok: boolean; mensaje: string }>
  guardarToken?: (valor: string) => void
  desconectar?: () => void
}

export const SERVICIOS: ServicioDefinicion[] = [
  {
    id: 'notion',
    nombre: 'Notion',
    paraQue: 'Leer y escribir en las páginas y bases que le compartas.',
    // Las DOS: la de arriba es que lo haga Albus; pegar el token queda como
    // red de contención para cuando Notion cambie su pantalla.
    vias: ['navegador', 'token'],
    dondeSacarlo: 'https://www.notion.so/profile/integrations',
    async estado() {
      const origen = origenDelSecreto(CLAVES.notionToken, 'NOTION_TOKEN')
      if (origen === 'ninguno') {
        // Se dice de entrada si va a ser un click o si va a haber que entrar:
        // prometer "sin mover un dedo" y después pedir un código por mail es
        // peor que avisar.
        const { hasGoogleBrowserSession } = await import('../browser/session')
        const conGoogle = await hasGoogleBrowserSession()
        return {
          conectado: false,
          origen,
          detalle: conGoogle
            ? 'Un click: entra con tu Google y crea la integración solo.'
            : 'Conectá primero la sesión del navegador de Google y esto pasa a ser un click. Si no, Notion te va a pedir un código por mail.'
        }
      }

      // Tener token no prueba nada: si la base no está compartida con la
      // integración, la API devuelve 404 y el espejo nunca se escribe.
      const v = await verificarNotion()
      return {
        conectado: v.ok,
        origen,
        detalle: v.ok ? v.detalle : `token guardado pero la base no responde: ${v.detalle}`
      }
    },
    // Sin implementación propia: la genérica de abajo lo resuelve. Notion no
    // tiene un archivo de código para él, tiene una fila en `servicios.ts`.
    guardarToken(valor) {
      guardarSecreto(CLAVES.notionToken, valor.trim())
    },
    desconectar() {
      borrarSecreto(CLAVES.notionToken)
    }
  },
  {
    id: 'google',
    nombre: 'Google',
    grupo: 'google',
    capacidad: 'correo y archivos',
    paraQue: 'Mandar correos desde tu cuenta y guardar archivos en tu Drive.',
    vias: ['navegador'],
    dondeSacarlo: '',
    async estado() {
      const origen = origenDelSecreto(CLAVES.googleRefreshToken, 'GOOGLE_REFRESH_TOKEN')
      if (origen === 'ninguno') {
        return { conectado: false, origen, detalle: 'Un click y listo, no hay que buscar nada.' }
      }

      // Tener token no alcanza: el viejo era solo de Drive y no manda correos.
      try {
        const { tieneScopeGmail } = await import('../gmail/send')
        const { ok } = await tieneScopeGmail()
        return {
          conectado: ok,
          origen,
          detalle: ok ? '' : 'Conectado pero sin permiso de correo. Volvé a conectar.'
        }
      } catch {
        return { conectado: false, origen, detalle: 'No pude verificar los permisos.' }
      }
    },
    async conectarNavegador(onPaso) {
      onPaso?.({ paso: 'abrir el consentimiento de Google', ok: true, detalle: '' })
      const r = await conectarGoogle()
      onPaso?.({ paso: 'volver con el permiso', ok: r.ok, detalle: r.mensaje })
      return { ok: r.ok, mensaje: r.mensaje }
    },
    desconectar() {
      borrarSecreto(CLAVES.googleRefreshToken)
    }
  },
  {
    /**
     * Estar logueado en Google DENTRO del navegador de Albus.
     *
     * No es lo mismo que la conexión "Google" de arriba: aquella es un token
     * para hablarle a la API de Gmail y Drive. Esta es una sesión de navegador,
     * y es la que hace que un "Continue with Google" de cualquier otro sitio
     * —Notion, entre otros— se resuelva sin escribir una sola letra.
     *
     * Va primero en la lista a propósito: conectando esta, las demás dejan de
     * pedir nada.
     */
    id: 'google-navegador',
    nombre: 'Google',
    grupo: 'google',
    capacidad: 'sesión del navegador',
    paraQue:
      'Entrar a sitios con "Continuar con Google" sin escribir nada ni esperar códigos por mail.',
    vias: ['navegador'],
    dondeSacarlo: '',
    async estado() {
      const { hasGoogleBrowserSession } = await import('../browser/session')
      const hay = await hasGoogleBrowserSession()
      return {
        conectado: hay,
        origen: hay ? 'app' : 'ninguno',
        detalle: hay ? 'los SSO de Google se resuelven solos' : 'esta es la que desbloquea el resto'
      }
    },
    async conectarNavegador(onPaso) {
      const { openGoogleLoginWindow } = await import('../browser/session')
      onPaso?.({
        paso: 'abrir Google en el navegador de Albus',
        ok: true,
        detalle: 'entrá con tu cuenta en la ventana que se abrió'
      })
      const ok = await openGoogleLoginWindow()
      onPaso?.({ paso: 'guardar la sesión', ok, detalle: ok ? 'la cookie quedó en el perfil' : '' })
      return {
        ok,
        mensaje: ok
          ? 'Google conectado en el navegador. Ahora "conectar Notion" es un click.'
          : 'No se guardó la sesión'
      }
    }
  },
  {
    id: 'linkedin',
    nombre: 'LinkedIn',
    paraQue: 'Navegar el sitio con tu sesión, sin volver a entrar cada vez.',
    vias: ['navegador'],
    dondeSacarlo: '',
    async estado() {
      const hay = await hasLinkedInSession()
      return {
        conectado: hay,
        origen: hay ? 'app' : 'ninguno',
        detalle: hay ? '' : 'Entrás una vez y la sesión queda guardada dentro de Albus.'
      }
    },
    async conectarNavegador(onPaso) {
      onPaso?.({
        paso: 'abrir LinkedIn',
        ok: true,
        detalle: 'entrá a mano: el login no se automatiza, su antifraude lo marca'
      })
      const ok = await openLoginWindow()
      onPaso?.({ paso: 'guardar la sesión', ok, detalle: '' })
      return { ok, mensaje: ok ? 'LinkedIn conectado' : 'No se guardó la sesión' }
    }
  }
]

/**
 * Enchufa los secretos guardados a los clientes. Se llama una vez al arrancar
 * y otra vez cada vez que el usuario conecta algo, para que el cambio se note
 * sin reiniciar la app — que es medio punto del pedido.
 */
export function aplicarConexiones(): void {
  setNotionTokenResolver(() => secretoOEntorno(CLAVES.notionToken, 'NOTION_TOKEN'))
  setGoogleRefreshTokenResolver(() =>
    secretoOEntorno(CLAVES.googleRefreshToken, 'GOOGLE_REFRESH_TOKEN')
  )

  /**
   * La base sale del `.md` de reglas del agente, no de una constante.
   *
   * Se resuelve en cada llamada y no una vez al arrancar: el usuario puede
   * abrir el archivo, pegar otro link y esperar que la app lo use sin
   * reiniciar — que es medio el punto de tener un archivo en vez de una
   * pantalla.
   */
  setNotionDatabaseIdResolver(() => {
    try {
      const { AGENTES } = require('../agents/registry') as typeof import('../agents/registry')
      const { leerReglas } = require('../agents/rules') as typeof import('../agents/rules')

      for (const a of AGENTES) {
        const r = leerReglas(a.id, '')
        if (r.existe && r.notion.length > 0) return r.notion[0].id
      }
    } catch {
      // Sin reglas legibles se cae al default. No es motivo para no arrancar.
    }
    return null
  })
}

export async function listarConexiones(): Promise<ConnectionInfo[]> {
  const salida: ConnectionInfo[] = []

  for (const s of SERVICIOS) {
    let estado: Awaited<ReturnType<ServicioDefinicion['estado']>>
    try {
      estado = await s.estado()
    } catch (error: unknown) {
      estado = {
        conectado: false,
        origen: 'ninguno',
        detalle: error instanceof Error ? error.message : String(error)
      }
    }

    salida.push({
      id: s.id,
      nombre: s.nombre,
      grupo: s.grupo ?? s.id,
      capacidad: s.capacidad ?? '',
      paraQue: s.paraQue,
      vias: s.vias,
      dondeSacarlo: s.dondeSacarlo,
      conectado: estado.conectado,
      origen: estado.origen as ConnectionInfo['origen'],
      detalle: estado.detalle,
      cifradoDisponible: cifradoDisponible()
    })
  }

  return salida
}

export function servicio(id: string): ServicioDefinicion | null {
  return SERVICIOS.find((s) => s.id === id) ?? null
}

/**
 * La prueba de que funcionó no es que los clicks no tiraran: es que la API
 * conteste. Se consulta la base de verdad.
 */
export async function verificarNotion(): Promise<{ ok: boolean; detalle: string }> {
  try {
    const { knownPostLinks } = await import('../notion/applications')
    const urls = await knownPostLinks()
    return { ok: true, detalle: `la base responde: ${urls.size} postulación(es) registradas` }
  } catch (error: unknown) {
    return { ok: false, detalle: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Conectar con el agente: el mismo camino para TODOS los servicios.
 *
 * Un servicio de `servicios.ts` no trae implementación — trae una URL, unos
 * objetivos en castellano y el patrón de su credencial. Todo lo demás lo hace
 * el agente manejando el navegador. Por eso esto no tiene un `switch` por
 * servicio y nunca lo va a tener: sumar Supabase o Stripe no toca esta función.
 */
export async function conectarConNavegador(
  id: string,
  onPaso?: ReportarPaso
): Promise<{ ok: boolean; mensaje: string }> {
  const s = servicio(id)
  if (s === null) throw new Error(`no conozco el servicio "${id}"`)

  // Los que tienen implementación propia —OAuth de Google, login de LinkedIn—
  // la usan. No son "excepciones al motor": son protocolos distintos, con su
  // propio flujo de consentimiento, que no se navegan a mano ni conviene.
  if (s.conectarNavegador !== undefined) return await s.conectarNavegador(onPaso)

  const { conectable } = await import('./servicios')
  const objetivo = conectable(id)
  if (objetivo === null) throw new Error(`${s.nombre} no se conecta por navegador`)

  const { conectarConAgente } = await import('./agente-conexion')
  const r = await conectarConAgente(objetivo, { onPaso })

  // El secreto se guarda ACÁ y no dentro del motor: el motor navega, el
  // registro es el único que sabe con qué clave se guarda cada cosa.
  if (r.secreto !== null) {
    if (s.guardarToken === undefined) throw new Error(`${s.nombre} no sabe dónde guardar su token`)
    s.guardarToken(r.secreto)
    aplicarConexiones()
  }

  return { ok: r.ok, mensaje: r.mensaje }
}

/** Abre la página donde está el token. Se valida el destino: es una allowlist. */
export async function abrirDondeSacarlo(id: string): Promise<void> {
  const s = servicio(id)
  if (s === null || s.dondeSacarlo === '') throw new Error('ese servicio no tiene página de token')
  // La URL sale de esta constante, no del renderer: no hay nada que validar
  // contra un atacante, pero igual no se acepta una URL de afuera.
  await shell.openExternal(s.dondeSacarlo)
}
