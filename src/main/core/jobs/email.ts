/**
 * Armado del correo de postulación. Puro: entra texto y bytes, sale un MIME.
 *
 * Existe porque mandar un mail manejando la interfaz de Gmail con un navegador
 * es la herramienta equivocada. El botón de adjuntar de Gmail abre un diálogo
 * del sistema operativo, el DOM cambia cada dos meses y cualquier cosa que se
 * construya sobre eso se rompe sola. La API de Gmail acepta un MIME armado y
 * listo, con el adjunto adentro, y no tiene DOM que se pueda mover.
 */

export interface EmailAttachment {
  /** El nombre que ve el que recibe. Para el CV: "CV Jorge David Diaz.pdf". */
  filename: string
  mimeType: string
  content: Uint8Array
}

export interface EmailDraft {
  fromName: string
  fromEmail: string
  to: string[]
  cc: string[]
  subject: string
  /** Texto plano. Nada de HTML: un mail de postulación no lo necesita. */
  body: string
  attachments: EmailAttachment[]
}

/** ¿Todo el string entra en US-ASCII imprimible? Decide si hay que codificar. */
export function esAscii(texto: string): boolean {
  return /^[ -~]*$/.test(texto)
}

/**
 * RFC 2047. Un asunto con tildes mandado crudo llega con caracteres rotos, y
 * "Postulación" con la ó partida en un mail de trabajo es un mal primer gesto.
 */
export function encodeHeader(valor: string): string {
  if (esAscii(valor)) return valor
  return `=?UTF-8?B?${Buffer.from(valor, 'utf8').toString('base64')}?=`
}

/** RFC 2231 para nombres de archivo con acentos; comillas para el resto. */
function contentDisposition(filename: string): string {
  if (esAscii(filename)) {
    return `Content-Disposition: attachment; filename="${filename.replace(/"/g, '')}"`
  }
  const codificado = encodeURIComponent(filename)
  return `Content-Disposition: attachment; filename*=UTF-8''${codificado}`
}

/** El base64 de un adjunto va cortado en líneas de 76. Es parte del estándar. */
function base64EnLineas(bytes: Uint8Array): string {
  const crudo = Buffer.from(bytes).toString('base64')
  const lineas: string[] = []
  for (let i = 0; i < crudo.length; i += 76) lineas.push(crudo.slice(i, i + 76))
  return lineas.join('\r\n')
}

function direccion(nombre: string, email: string): string {
  return nombre === '' ? email : `${encodeHeader(nombre)} <${email}>`
}

/**
 * El MIME completo. Los saltos son CRLF porque el estándar lo pide y Gmail es
 * tolerante pero otros servidores no.
 */
export function buildMime(draft: EmailDraft, boundary: string): string {
  const cabeceras = [
    `From: ${direccion(draft.fromName, draft.fromEmail)}`,
    `To: ${draft.to.join(', ')}`,
    ...(draft.cc.length > 0 ? [`Cc: ${draft.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(draft.subject)}`,
    'MIME-Version: 1.0'
  ]

  if (draft.attachments.length === 0) {
    return [
      ...cabeceras,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64EnLineas(Buffer.from(draft.body, 'utf8'))
    ].join('\r\n')
  }

  const partes: string[] = [
    ...cabeceras,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64EnLineas(Buffer.from(draft.body, 'utf8'))
  ]

  for (const a of draft.attachments) {
    partes.push(
      `--${boundary}`,
      `Content-Type: ${a.mimeType}; name="${a.filename.replace(/"/g, '')}"`,
      contentDisposition(a.filename),
      'Content-Transfer-Encoding: base64',
      '',
      base64EnLineas(a.content)
    )
  }

  partes.push(`--${boundary}--`, '')
  return partes.join('\r\n')
}

/** Lo que la API de Gmail espera en `raw`. */
export function toGmailRaw(mime: string): string {
  return Buffer.from(mime, 'utf8').toString('base64url')
}

/**
 * Un boundary que no puede aparecer dentro del contenido. Se pasa desde afuera
 * para que el verificador pueda fijarlo y comparar bytes exactos.
 */
export function nuevoBoundary(): string {
  return `albus-${crypto.randomUUID()}`
}

/**
 * El freno del correo, en una función pura para poder probarlo.
 *
 * Solo `auto` manda. `review` deja un borrador en Gmail y `dry-run` ni
 * siquiera eso — es la misma regla que el botón de enviar de un formulario, y
 * está acá afuera justamente para que un assert pueda afirmarla sin necesitar
 * una cuenta de Google.
 */
export function modoGmail(mode: 'dry-run' | 'review' | 'auto'): 'draft' | 'send' | 'nada' {
  if (mode === 'auto') return 'send'
  if (mode === 'review') return 'draft'
  return 'nada'
}

/** Direcciones que el main acepta como destino. No se manda a cualquier lado. */
export function esEmailValido(valor: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(valor)
}

/**
 * Saca el correo de contacto de un texto de vacante. Devuelve el primero que
 * NO sea el del propio candidato — postularse a uno mismo es el bug que uno
 * descubre tarde y con vergüenza.
 */
export function extraerEmailDeVacante(texto: string, propio: string): string | null {
  const encontrados = texto.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g) ?? []
  const limpio = encontrados
    .map((e) => e.replace(/[.,;:)]+$/, ''))
    .filter((e) => e.toLowerCase() !== propio.toLowerCase())
    .filter(esEmailValido)
    // Los dominios de imagen y tracking que se cuelan en los HTML de vacantes.
    .filter((e) => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(e))

  return limpio[0] ?? null
}
