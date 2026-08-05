/**
 * Qué ES un código QR, y cuándo dos son el mismo.
 *
 * Dominio puro: no importa electron, ni supabase, ni ningún CLI. Escalón 3 —
 * reglas, gratis, instantáneo.
 *
 * ---------------------------------------------------------------------------
 * El error que este archivo corrige
 * ---------------------------------------------------------------------------
 * La versión anterior deduplicaba comparando los códigos por igualdad exacta, y
 * cuando dos códigos ilegibles no coincidían les agregaba un hash al título para
 * que no colisionaran. Sobre los datos reales eso produjo dos pendientes para la
 * misma entrada de evento:
 *
 *     Usar el QR de: Código QR del evento de cripto de 27 y 28 de agosto (101v)
 *     Usar el QR de: Código QR del evento de cripto de 27 y 28 de agosto (1cp6)
 *
 * Los dos códigos empiezan con `U2FsdGVkX1`, que es el base64 de `Salted__`: son
 * ciphertexts de OpenSSL CON SAL. La sal es aleatoria en cada render, así que la
 * MISMA entrada capturada dos veces produce dos códigos distintos — siempre, por
 * diseño del cifrado.
 *
 * O sea: un QR cifrado NO TIENE IDENTIDAD EN SUS BYTES. Ninguna comparación de
 * strings puede funcionar, y el discriminador que se agregó para evitar
 * colisiones era justamente lo que fabricaba el duplicado. Colisionar era lo
 * correcto.
 */

/**
 * ¿Está cifrado?
 *
 * `U2FsdGVkX1` es el base64 de `Salted__`, la cabecera de OpenSSL. Así vienen las
 * entradas de evento, que solo sirven escaneadas por la app del organizador. El
 * segundo chequeo cubre binario crudo: si no es ASCII imprimible, no hay nada que
 * mostrarle a nadie.
 */
export function esCifrado(code: string): boolean {
  return code.startsWith('U2FsdGVkX1') || !/^[\x20-\x7E]+$/.test(code)
}

/**
 * Todos los QR cifrados de una nota comparten esta identidad.
 *
 * No es un hash del contenido a propósito: es una CONSTANTE. Dos entradas
 * cifradas guardadas en la misma nota son la misma cosa capturada dos veces, y no
 * existe forma de distinguirlas sin la clave del organizador. Ante lo
 * indistinguible, colapsar es la única respuesta honesta.
 */
const IDENTIDAD_CIFRADA = 'qr:cifrado'

/** Params que no cambian a dónde apunta un link, solo de dónde venís. */
const PARAMS_DE_TRACKING = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'msclkid', 'igshid', 'mc_cid', 'mc_eid', 'ref', 'referrer',
  'source', 'src', '_branch_match_id', 'rcid', 'gi', 'usp'
])

/** Segmentos de path que no dicen QUÉ es: son la estructura del sitio. */
const SEGMENTOS_GENERICOS = new Set([
  'events', 'event', 'e', 'u', 'p', 'in', 'profile', 'profiles', 'groups', 'group',
  'invite', 'invites', 'join', 's', 'r', 'd', 'view', 'watch', 'share', 'home',
  'index', 'page', 'pages', 'l', 'c', 'i', 'go', 'link', 'links', 'about'
])

const NOMBRE_DE_HOST: Record<string, string> = {
  'meetup.com': 'Meetup',
  'linkedin.com': 'LinkedIn',
  'lnkd.in': 'LinkedIn',
  'wa.me': 'WhatsApp',
  'chat.whatsapp.com': 'WhatsApp',
  'api.whatsapp.com': 'WhatsApp',
  't.me': 'Telegram',
  'instagram.com': 'Instagram',
  'github.com': 'GitHub',
  'drive.google.com': 'Google Drive',
  'docs.google.com': 'Google Docs',
  'forms.gle': 'Google Forms',
  'calendar.google.com': 'Google Calendar',
  'maps.google.com': 'Google Maps',
  'goo.gl': 'Google',
  'eventbrite.com': 'Eventbrite',
  'eventbrite.co': 'Eventbrite',
  'lu.ma': 'Luma',
  'x.com': 'X',
  'twitter.com': 'X',
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'open.spotify.com': 'Spotify',
  'platzi.com': 'Platzi',
  'nequi.com.co': 'Nequi',
  'bancolombia.com': 'Bancolombia'
}

/** Siglas que en un slug van en mayúscula: `aws-user-group` → `AWS User Group`. */
const SIGLAS = new Set([
  'aws', 'gcp', 'api', 'ai', 'ia', 'ui', 'ux', 'js', 'ts', 'css', 'html', 'sql',
  'php', 'ml', 'llm', 'qr', 'sdk', 'cli', 'ci', 'cd', 'k8s', 'iot', 'vr', 'ar',
  'nft', 'dao', 'db', 'os', 'pm', 'qa', 'hr', 'it', 'seo', 'crm', 'erp', 'saas'
])

/** Palabras con mayúsculas internas que ninguna regla general acierta. */
const CAPITALIZACION_ESPECIAL: Record<string, string> = {
  devops: 'DevOps',
  nodejs: 'Node.js',
  nextjs: 'Next.js',
  reactjs: 'React',
  github: 'GitHub',
  gitlab: 'GitLab',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  latam: 'LATAM',
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  mongodb: 'MongoDB',
  graphql: 'GraphQL',
  openai: 'OpenAI',
  chatgpt: 'ChatGPT',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  iphone: 'iPhone',
  macos: 'macOS',
  ios: 'iOS'
}

function esUrl(code: string): boolean {
  return /^https?:\/\//i.test(code)
}

function hostSinWww(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '')
}

/**
 * ¿El segmento es un identificador y no un nombre?
 *
 * Los IDs no le dicen nada a un humano. Se descartan tres formas: puros dígitos,
 * hexadecimal largo, y cualquier cosa larga sin una sola vocal — que es como se
 * ven las claves generadas al azar.
 */
function pareceIdentificador(segmento: string): boolean {
  if (/^\d+$/.test(segmento)) return true
  if (/^[0-9a-f]{8,}$/i.test(segmento)) return true
  return segmento.length >= 8 && !/[aeiou]/i.test(segmento)
}

/** `aws-user-group-serverless-colombia` → `AWS User Group Serverless Colombia`. */
function desSluguear(segmento: string): string {
  return decodeURIComponent(segmento)
    .split(/[-_+.]+/)
    .filter((p) => p.length > 0)
    .map((p) => {
      const bajo = p.toLowerCase()
      if (CAPITALIZACION_ESPECIAL[bajo] !== undefined) return CAPITALIZACION_ESPECIAL[bajo]
      if (SIGLAS.has(bajo)) return bajo.toUpperCase()
      return bajo.charAt(0).toUpperCase() + bajo.slice(1)
    })
    .join(' ')
}

/**
 * La identidad de un código, para deduplicar.
 *
 * Cifrado → una constante: todos colapsan.
 * URL     → host sin `www` + path sin barra final + los params que SÍ importan.
 *           `meetup.com/x/events/` y `meetup.com/x/events?utm_source=qr` son el
 *           mismo lugar y tienen que dar la misma identidad.
 * Texto   → normalizado en minúsculas.
 */
export function identidadDe(code: string): string {
  if (esCifrado(code)) return IDENTIDAD_CIFRADA

  if (esUrl(code)) {
    try {
      const url = new URL(code)
      const params = [...url.searchParams.entries()]
        .filter(([k]) => !PARAMS_DE_TRACKING.has(k.toLowerCase()))
        .map(([k, v]) => `${k.toLowerCase()}=${v}`)
        .sort()

      const path = url.pathname.replace(/\/+$/, '').toLowerCase()
      return `url:${hostSinWww(url.hostname)}${path}${params.length ? `?${params.join('&')}` : ''}`
    } catch {
      // Una URL que no parsea se trata como texto: peor identidad, nunca un throw.
    }
  }

  return `txt:${code.replace(/\s+/g, ' ').trim().toLowerCase()}`
}

/**
 * Etiqueta legible para un humano, o `null` si el código no se puede describir.
 *
 * `null` significa "acá no hay nada que leer, usá el contexto de la nota". Es
 * distinto de devolver el código: el llamador tiene que DECIDIR qué poner, y un
 * ciphertext de 192 caracteres como título no es una decisión.
 *
 * Por qué la etiqueta sale del CÓDIGO y no de la nota cuando se puede: el QR de
 * Meetup lleva la URL del grupo, que es específica y accionable. La nota de esa
 * misma captura decía "Screenshots fotos y videos de aws serverless día también
 * hay links de linkedin...", que como título es ruido.
 */
export function etiquetaDe(code: string): string | null {
  if (esCifrado(code)) return null

  if (esUrl(code)) {
    try {
      const url = new URL(code)
      const host = hostSinWww(url.hostname)
      const sitio = NOMBRE_DE_HOST[host] ?? host

      const utiles = url.pathname
        .split('/')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .filter((s) => !SEGMENTOS_GENERICOS.has(s.toLowerCase()))
        .filter((s) => !pareceIdentificador(s))

      // El más largo es el más descriptivo: entre `aws-user-group-serverless-colombia`
      // y `2024`, el nombre del grupo es lo que ubica al usuario.
      const mejor = utiles.sort((a, b) => b.length - a.length)[0]
      if (mejor === undefined) return sitio

      const nombre = desSluguear(mejor)
      return nombre.length > 0 ? `${sitio} · ${nombre}` : sitio
    } catch {
      // Cae al texto plano de abajo.
    }
  }

  const plano = code.replace(/\s+/g, ' ').trim()
  if (plano.length === 0) return null
  return plano.length > 80 ? `${plano.slice(0, 80)}…` : plano
}
