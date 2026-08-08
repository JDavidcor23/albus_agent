import type { ConnectableService } from './connection-agent'
import { DEFAULT_DATABASE_ID, notionDatabaseId } from '../notion/client'

/**
 * Los servicios que Albus sabe conectar solo. Son DATOS, no código.
 *
 * La prueba de que el diseño sirve es esta tabla: agregar Supabase, Vercel o
 * Stripe son cinco líneas acá y nada más. Ni un archivo nuevo, ni una función,
 * ni un `if`. El agente ya sabe navegar un panel de credenciales — es lo que
 * hace todo el día. Lo único que necesita saber es adónde ir, qué lograr y
 * cómo se ve la credencial cuando aparece.
 *
 * ## Cómo se escribe un objetivo
 *
 * Un objetivo dice QUÉ tiene que ser verdad cuando termine, no qué botón
 * apretar. "Crear un token llamado Albus y hacerlo visible" sobrevive a un
 * rediseño; "apretá el botón azul de arriba a la derecha" no. Y conviene
 * decir explícitamente cuándo NO está cumplido: un formulario lleno pero sin
 * confirmar es el error más caro, porque parece que avanzó.
 */

/** El nombre con el que Albus se registra en todos lados. */
export const INTEGRATION_NAME = 'Albus Agent'

export function notionService(): ConnectableService {
  const id = notionDatabaseId() || DEFAULT_DATABASE_ID

  return {
    id: 'notion',
    name: 'Notion',
    // La de siempre —/profile/integrations— redirige acá. Se apunta al destino
    // real: un redirect es una carga más y una ventana más para que la SPA
    // quede a medio montar cuando el agente saca su primera foto.
    url: 'https://www.notion.so/developers/connections',
    secretPattern: 'ntn_[A-Za-z0-9]{20,}|secret_[A-Za-z0-9]{30,}',
    goals: [
      `Conseguir el token de una integración interna llamada exactamente "${INTEGRATION_NAME}", ` +
        `creándola si todavía no existe y abriéndola si ya existe. ` +
        `Si hay que elegir tipo de autenticación, tiene que ser el de TOKEN interno, NO OAuth. ` +
        `El objetivo NO está cumplido con el formulario lleno sin confirmar: hay que apretar el botón que la crea ` +
        `(suele decir "Create connection", "Submit" o "Guardar"). ` +
        `Después hay que hacer VISIBLE el token en pantalla — puede estar tapado detrás de "Show", "Reveal" o un ícono de ojo.`,

      // El segundo objetivo es el que más se olvida y el que más duele: sin
      // esto la API devuelve 404 y todo lo anterior no sirvió para nada.
      //
      // La `url` va acá y NO adentro del texto: navegar no es una acción que
      // el agente pueda hacer. Cuando el objetivo decía "Ir a https://…", el
      // agente contestaba —con razón— que desde la consola de integraciones
      // ningún elemento lo lleva a esa página.
      {
        url: `https://www.notion.so/${id.replace(/-/g, '')}`,
        what:
          `Darle acceso a ESTA página a la integración "${INTEGRATION_NAME}". ` +
          `El camino normal es el menú de más opciones (tres puntos "···" arriba a la derecha, que puede ` +
          `NO tener texto) → "Connections" / "Conexiones" → elegirla → confirmar. ` +
          `Está cumplido cuando la integración figura con acceso a la página.`
      }
    ],

    // La única prueba que vale: que la API conteste con ESTE token.
    async verify(secret) {
      const { setNotionTokenResolver } = await import('../notion/client')
      const { knownPostLinks } = await import('../notion/applications')
      setNotionTokenResolver(() => secret)

      try {
        const urls = await knownPostLinks()
        return { ok: true, detail: `la base responde: ${urls.size} postulación(es) registradas` }
      } catch (error: unknown) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    },

    /**
     * Si el agente no logró compartir la base, se frena y se te pide.
     *
     * Y no es una derrota del agente: **Notion no permite que una integración
     * se dé acceso a sí misma**, ni por API ni de ninguna forma — sería una
     * escalada de privilegios. Lo único que existe es su UI, con un flyout que
     * se re-renderiza; pelearse con eso es una batalla que se pierde de a poco.
     *
     * Diez segundos, una sola vez en la vida, y Albus lo detecta solo
     * preguntándole a la API — no hay que avisarle nada.
     */
    askHuman: {
      url: `https://www.notion.so/${id.replace(/-/g, '')}`,
      instructions: [
        'en la página que se abrió, apretá "···" (arriba a la derecha)',
        'Connections',
        `elegí "${INTEGRATION_NAME}"`,
        'confirmá — Albus se da cuenta solo y sigue'
      ]
    }
  }
}

/**
 * Supabase. Está acá para demostrar el punto: no hay `supabase-auto.ts`.
 *
 * Es exactamente el mismo motor, con otras cinco líneas de datos. Si Albus
 * necesita mañana un token de Supabase, ya sabe cómo sacarlo.
 */
export function supabaseService(): ConnectableService {
  return {
    id: 'supabase',
    name: 'Supabase',
    url: 'https://supabase.com/dashboard/account/tokens',
    secretPattern: 'sbp_[A-Za-z0-9]{20,}',
    goals: [
      `Generar un access token personal llamado exactamente "${INTEGRATION_NAME}" y dejar su valor visible ` +
        `en pantalla. Si ya existe uno con ese nombre, su valor NO se puede volver a ver: hay que generar otro ` +
        `(podés llamarlo "${INTEGRATION_NAME} 2"). El objetivo no está cumplido hasta que el token completo ` +
        `esté a la vista o copiado en un campo.`
    ]
  }
}

/**
 * Todo lo que se puede conectar con el agente, por id.
 *
 * Se arman con funciones y no como constantes porque algunos objetivos leen
 * configuración —el id de la base de Notion sale del `.env` o de lo guardado—
 * y una constante de módulo la congelaría al importar.
 */
export const CONNECTABLE: Record<string, () => ConnectableService> = {
  notion: notionService,
  supabase: supabaseService
}

export function connectable(id: string): ConnectableService | null {
  const build = CONNECTABLE[id]
  return build === undefined ? null : build()
}
