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
export function isAscii(text: string): boolean {
  return /^[ -~]*$/.test(text)
}

/**
 * RFC 2047. Un asunto con tildes mandado crudo llega con caracteres rotos, y
 * "Postulación" con la ó partida en un mail de trabajo es un mal primer gesto.
 */
export function encodeHeader(value: string): string {
  if (isAscii(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/** RFC 2231 para nombres de archivo con acentos; comillas para el resto. */
function contentDisposition(filename: string): string {
  if (isAscii(filename)) {
    return `Content-Disposition: attachment; filename="${filename.replace(/"/g, '')}"`
  }
  const encoded = encodeURIComponent(filename)
  return `Content-Disposition: attachment; filename*=UTF-8''${encoded}`
}

/** El base64 de un adjunto va cortado en líneas de 76. Es parte del estándar. */
function base64Lines(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('base64')
  const lines: string[] = []
  for (let i = 0; i < raw.length; i += 76) lines.push(raw.slice(i, i + 76))
  return lines.join('\r\n')
}

function address(name: string, email: string): string {
  return name === '' ? email : `${encodeHeader(name)} <${email}>`
}

/**
 * El MIME completo. Los saltos son CRLF porque el estándar lo pide y Gmail es
 * tolerante pero otros servidores no.
 */
export function buildMime(draft: EmailDraft, boundary: string): string {
  const headers = [
    `From: ${address(draft.fromName, draft.fromEmail)}`,
    `To: ${draft.to.join(', ')}`,
    ...(draft.cc.length > 0 ? [`Cc: ${draft.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(draft.subject)}`,
    'MIME-Version: 1.0'
  ]

  if (draft.attachments.length === 0) {
    return [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(Buffer.from(draft.body, 'utf8'))
    ].join('\r\n')
  }

  const parts: string[] = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(draft.body, 'utf8'))
  ]

  for (const a of draft.attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.mimeType}; name="${a.filename.replace(/"/g, '')}"`,
      contentDisposition(a.filename),
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(a.content)
    )
  }

  parts.push(`--${boundary}--`, '')
  return parts.join('\r\n')
}

/** Lo que la API de Gmail espera en `raw`. */
export function toGmailRaw(mime: string): string {
  return Buffer.from(mime, 'utf8').toString('base64url')
}

/**
 * Un boundary que no puede aparecer dentro del contenido. Se pasa desde afuera
 * para que el verificador pueda fijarlo y comparar bytes exactos.
 */
export function newBoundary(): string {
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
export function gmailMode(mode: 'dry-run' | 'review' | 'auto'): 'draft' | 'send' | 'none' {
  if (mode === 'auto') return 'send'
  if (mode === 'review') return 'draft'
  return 'none'
}

/** Direcciones que el main acepta como destino. No se manda a cualquier lado. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
}

/**
 * Saca el correo de contacto de un texto de vacante. Devuelve el primero que
 * NO sea el del propio candidato — postularse a uno mismo es el bug que uno
 * descubre tarde y con vergüenza.
 */
export function extractEmailFromJob(text: string, own: string): string | null {
  const found = text.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g) ?? []
  const clean = found
    .map((e) => e.replace(/[.,;:)]+$/, ''))
    .filter((e) => e.toLowerCase() !== own.toLowerCase())
    .filter(isValidEmail)
    // Los dominios de imagen y tracking que se cuelan en los HTML de vacantes.
    .filter((e) => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(e))

  return clean[0] ?? null
}
