import { shell } from 'electron'
import type { ConnectionInfo } from '../../shared/ipc'
import { setNotionDatabaseIdResolver, setNotionTokenResolver } from '../notion/client'
import { setGoogleRefreshTokenResolver } from '../drive/client'
import {
  deleteSecret,
  encryptionAvailable,
  KEYS,
  saveSecret,
  secretSource,
  secretOrEnv
} from './store'
import { connectGoogle } from './google-oauth'
import { hasLinkedInSession, openLoginWindow } from '../browser/session'

/**
 * Las conexiones de Albus, con las DOS vías que pidió el usuario:
 *
 * - `browser`: se abre una ventana, das OK, listo. Sin terminal, sin editar
 *   archivos, sin buscar nada.
 * - `token`: pegás la credencial en un campo y se guarda cifrada.
 *
 * Los servicios que soportan OAuth exponen las dos; los que no —Notion, que
 * para una integración interna solo da un token— exponen la de pegar más un
 * botón que te deja parado en la página exacta donde está el token. Eso es lo
 * máximo que se puede automatizar sin registrar una integración pública.
 */

export type ConnectionMethod = 'browser' | 'token'

/**
 * Cómo cada servicio le cuenta al usuario qué está haciendo, mientras lo hace.
 *
 * No es un log de debug: es la única ventana que tiene el usuario a un proceso
 * que abre un navegador y toca su cuenta. Un `console.log` en la terminal del
 * main no le sirve a alguien que está mirando la app.
 */
export type ReportStep = (p: {
  step: string
  ok: boolean
  detail: string
  screenshot?: string
}) => void

export interface ServiceDefinition {
  id: string
  name: string
  /**
   * Qué DA el conector, no qué hace un agente con él.
   *
   * Decía "Espeja tus postulaciones en Registro de aplicaciones" — que es lo
   * que el agente de trabajo hace con Notion, no lo que Notion es. Reclamo del
   * usuario, y correcto: *"estos conectores no solo son para estos agentes...
   * una cosa son las reglas, otra cosa son los conectores"*. Un conector es
   * una capacidad de la app; qué se hace con ella lo deciden las reglas.
   */
  purpose: string
  /**
   * Servicios que son la MISMA cuenta se agrupan en una tarjeta.
   *
   * Google aparecía dos veces —el token de API y la sesión del navegador— y
   * para el usuario eso es una sola cuenta con dos permisos. Son mecanismos
   * distintos de verdad, así que siguen siendo entradas separadas acá; lo que
   * cambia es cómo se muestran.
   */
  group?: string
  /** El nombre de ESTA capacidad dentro del grupo. Ej: "correo y Drive". */
  capability?: string
  methods: ConnectionMethod[]
  /** Página donde el usuario obtiene el token, si la vía es pegar. */
  credentialUrl: string
  status: () => Promise<{ connected: boolean; source: string; detail: string }>
  connectBrowser?: (onStep?: ReportStep) => Promise<{ ok: boolean; message: string }>
  saveToken?: (value: string) => void
  disconnect?: () => void
}

export const SERVICES: ServiceDefinition[] = [
  {
    id: 'notion',
    name: 'Notion',
    purpose: 'Leer y escribir en las páginas y bases que le compartas.',
    // Las DOS: la de arriba es que lo haga Albus; pegar el token queda como
    // red de contención para cuando Notion cambie su pantalla.
    methods: ['browser', 'token'],
    credentialUrl: 'https://www.notion.so/profile/integrations',
    async status() {
      const source = secretSource(KEYS.notionToken, 'NOTION_TOKEN')
      if (source === 'none') {
        // Se dice de entrada si va a ser un click o si va a haber que entrar:
        // prometer "sin mover un dedo" y después pedir un código por mail es
        // peor que avisar.
        const { hasGoogleBrowserSession } = await import('../browser/session')
        const withGoogle = await hasGoogleBrowserSession()
        return {
          connected: false,
          source,
          detail: withGoogle
            ? 'Un click: entra con tu Google y crea la integración solo.'
            : 'Conectá primero la sesión del navegador de Google y esto pasa a ser un click. Si no, Notion te va a pedir un código por mail.'
        }
      }

      // Tener token no prueba nada: si la base no está compartida con la
      // integración, la API devuelve 404 y el espejo nunca se escribe.
      const v = await verifyNotion()
      return {
        connected: v.ok,
        source,
        detail: v.ok ? v.detail : `token guardado pero la base no responde: ${v.detail}`
      }
    },
    // Sin implementación propia: la genérica de abajo lo resuelve. Notion no
    // tiene un archivo de código para él, tiene una fila en `services.ts`.
    saveToken(value) {
      saveSecret(KEYS.notionToken, value.trim())
    },
    disconnect() {
      deleteSecret(KEYS.notionToken)
    }
  },
  {
    id: 'google',
    name: 'Google',
    group: 'google',
    capability: 'correo y archivos',
    purpose: 'Mandar correos desde tu cuenta y guardar archivos en tu Drive.',
    methods: ['browser'],
    credentialUrl: '',
    async status() {
      const source = secretSource(KEYS.googleRefreshToken, 'GOOGLE_REFRESH_TOKEN')
      if (source === 'none') {
        return { connected: false, source, detail: 'Un click y listo, no hay que buscar nada.' }
      }

      // Tener token no alcanza: el viejo era solo de Drive y no manda correos.
      try {
        const { hasGmailScope } = await import('../gmail/send')
        const { ok } = await hasGmailScope()
        return {
          connected: ok,
          source,
          detail: ok ? '' : 'Conectado pero sin permiso de correo. Volvé a conectar.'
        }
      } catch {
        return { connected: false, source, detail: 'No pude verificar los permisos.' }
      }
    },
    async connectBrowser(onStep) {
      onStep?.({ step: 'abrir el consentimiento de Google', ok: true, detail: '' })
      const r = await connectGoogle()
      onStep?.({ step: 'volver con el permiso', ok: r.ok, detail: r.message })
      return { ok: r.ok, message: r.message }
    },
    disconnect() {
      deleteSecret(KEYS.googleRefreshToken)
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
    id: 'google-browser',
    name: 'Google',
    group: 'google',
    capability: 'sesión del navegador',
    purpose:
      'Entrar a sitios con "Continuar con Google" sin escribir nada ni esperar códigos por mail.',
    methods: ['browser'],
    credentialUrl: '',
    async status() {
      const { hasGoogleBrowserSession } = await import('../browser/session')
      const has = await hasGoogleBrowserSession()
      return {
        connected: has,
        source: has ? 'app' : 'none',
        detail: has ? 'los SSO de Google se resuelven solos' : 'esta es la que desbloquea el resto'
      }
    },
    async connectBrowser(onStep) {
      const { openGoogleLoginWindow } = await import('../browser/session')
      onStep?.({
        step: 'abrir Google en el navegador de Albus',
        ok: true,
        detail: 'entrá con tu cuenta en la ventana que se abrió'
      })
      const ok = await openGoogleLoginWindow()
      onStep?.({ step: 'guardar la sesión', ok, detail: ok ? 'la cookie quedó en el perfil' : '' })
      return {
        ok,
        message: ok
          ? 'Google conectado en el navegador. Ahora "conectar Notion" es un click.'
          : 'No se guardó la sesión'
      }
    }
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    purpose: 'Navegar el sitio con tu sesión, sin volver a entrar cada vez.',
    methods: ['browser'],
    credentialUrl: '',
    async status() {
      const has = await hasLinkedInSession()
      return {
        connected: has,
        source: has ? 'app' : 'none',
        detail: has ? '' : 'Entrás una vez y la sesión queda guardada dentro de Albus.'
      }
    },
    async connectBrowser(onStep) {
      onStep?.({
        step: 'abrir LinkedIn',
        ok: true,
        detail: 'entrá a mano: el login no se automatiza, su antifraude lo marca'
      })
      const ok = await openLoginWindow()
      onStep?.({ step: 'guardar la sesión', ok, detail: '' })
      return { ok, message: ok ? 'LinkedIn conectado' : 'No se guardó la sesión' }
    }
  }
]

/**
 * Enchufa los secretos guardados a los clientes. Se llama una vez al arrancar
 * y otra vez cada vez que el usuario conecta algo, para que el cambio se note
 * sin reiniciar la app — que es medio punto del pedido.
 */
export function applyConnections(): void {
  setNotionTokenResolver(() => secretOrEnv(KEYS.notionToken, 'NOTION_TOKEN'))
  setGoogleRefreshTokenResolver(() =>
    secretOrEnv(KEYS.googleRefreshToken, 'GOOGLE_REFRESH_TOKEN')
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
      const { AGENTS } = require('../agents/registry') as typeof import('../agents/registry')
      const { readRules } = require('../agents/rules') as typeof import('../agents/rules')

      for (const a of AGENTS) {
        const r = readRules(a.id, '')
        if (r.exists && r.notion.length > 0) return r.notion[0].id
      }
    } catch {
      // Sin reglas legibles se cae al default. No es motivo para no arrancar.
    }
    return null
  })
}

export async function listConnections(): Promise<ConnectionInfo[]> {
  const output: ConnectionInfo[] = []

  for (const s of SERVICES) {
    let status: Awaited<ReturnType<ServiceDefinition['status']>>
    try {
      status = await s.status()
    } catch (error: unknown) {
      status = {
        connected: false,
        source: 'none',
        detail: error instanceof Error ? error.message : String(error)
      }
    }

    output.push({
      id: s.id,
      name: s.name,
      group: s.group ?? s.id,
      capability: s.capability ?? '',
      purpose: s.purpose,
      methods: s.methods,
      credentialUrl: s.credentialUrl,
      connected: status.connected,
      source: status.source as ConnectionInfo['source'],
      detail: status.detail,
      encryptionAvailable: encryptionAvailable()
    })
  }

  return output
}

export function service(id: string): ServiceDefinition | null {
  return SERVICES.find((s) => s.id === id) ?? null
}

/**
 * La prueba de que funcionó no es que los clicks no tiraran: es que la API
 * conteste. Se consulta la base de verdad.
 */
export async function verifyNotion(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { knownPostLinks } = await import('../notion/applications')
    const urls = await knownPostLinks()
    return { ok: true, detail: `la base responde: ${urls.size} postulación(es) registradas` }
  } catch (error: unknown) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Conectar con el agente: el mismo camino para TODOS los servicios.
 *
 * Un servicio de `services.ts` no trae implementación — trae una URL, unos
 * objetivos en castellano y el patrón de su credencial. Todo lo demás lo hace
 * el agente manejando el navegador. Por eso esto no tiene un `switch` por
 * servicio y nunca lo va a tener: sumar Supabase o Stripe no toca esta función.
 */
export async function connectWithBrowser(
  id: string,
  onStep?: ReportStep
): Promise<{ ok: boolean; message: string }> {
  const s = service(id)
  if (s === null) throw new Error(`no conozco el servicio "${id}"`)

  // Los que tienen implementación propia —OAuth de Google, login de LinkedIn—
  // la usan. No son "excepciones al motor": son protocolos distintos, con su
  // propio flujo de consentimiento, que no se navegan a mano ni conviene.
  if (s.connectBrowser !== undefined) return await s.connectBrowser(onStep)

  const { connectable } = await import('./services')
  const goal = connectable(id)
  if (goal === null) throw new Error(`${s.name} no se conecta por navegador`)

  const { connectWithAgent } = await import('./connection-agent')
  const r = await connectWithAgent(goal, { onStep })

  // El secreto se guarda ACÁ y no dentro del motor: el motor navega, el
  // registro es el único que sabe con qué clave se guarda cada cosa.
  if (r.secret !== null) {
    if (s.saveToken === undefined) throw new Error(`${s.name} no sabe dónde guardar su token`)
    s.saveToken(r.secret)
    applyConnections()
  }

  return { ok: r.ok, message: r.message }
}

/** Abre la página donde está el token. Se valida el destino: es una allowlist. */
export async function openCredentialPage(id: string): Promise<void> {
  const s = service(id)
  if (s === null || s.credentialUrl === '') throw new Error('ese servicio no tiene página de token')
  // La URL sale de esta constante, no del renderer: no hay nada que validar
  // contra un atacante, pero igual no se acepta una URL de afuera.
  await shell.openExternal(s.credentialUrl)
}
