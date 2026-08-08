import { z } from 'zod'
import { getAccessToken } from '../drive/client'
import { buildMime, newBoundary, toGmailRaw, type EmailDraft } from '../core/jobs/email'

/**
 * Envío de correos por la API de Gmail, reusando el OAuth que ya tenía Drive.
 *
 * El scope que hace falta es `gmail.compose`: alcanza para crear borradores,
 * leerlos y mandar. NO se pide `gmail.readonly` — Albus no tiene por qué ver
 * la bandeja de entrada para postularse a un trabajo, y el verificador se
 * arregla leyendo el borrador que él mismo creó.
 *
 * Si el refresh token guardado no tiene el scope, `npm run gmail:auth` lo
 * vuelve a pedir y devuelve uno nuevo.
 */

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.compose'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

async function gmailFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await getAccessToken()
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {})
    }
  })

  const json: unknown = await res.json().catch(() => ({}))

  if (!res.ok) {
    const detail = z.object({ error: z.object({ message: z.string() }) }).safeParse(json)
    const message = detail.success ? detail.data.error.message : JSON.stringify(json)

    if (res.status === 403 || /insufficient/i.test(message)) {
      throw new Error(
        `Gmail rechazó la llamada por permisos: ${message}. ` +
          'El refresh token no tiene el scope gmail.compose — corré `npm run gmail:auth`.'
      )
    }
    throw new Error(`Gmail ${res.status}: ${message}`)
  }

  return json
}

/** ¿El token guardado alcanza para mandar? Pregunta, no adivina. */
export async function hasGmailScope(): Promise<{ ok: boolean; scopes: string[] }> {
  const token = await getAccessToken()
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${token}`)
  const json: unknown = await res.json().catch(() => ({}))

  const parsed = z.object({ scope: z.string() }).safeParse(json)
  if (!parsed.success) return { ok: false, scopes: [] }

  const scopes = parsed.data.scope.split(/\s+/).filter(Boolean)
  const ok = scopes.includes(GMAIL_SCOPE) || scopes.includes('https://mail.google.com/')
  return { ok, scopes }
}

const MessageSchema = z.object({ id: z.string(), threadId: z.string().optional() })
const DraftSchema = z.object({ id: z.string(), message: MessageSchema.optional() })

export interface SendResult {
  /** `draft` = quedó como borrador esperando tu click. `sent` = salió. */
  kind: 'draft' | 'sent'
  id: string
  /** El id del mensaje, para poder mirarlo después. */
  messageId: string
  to: string[]
  subject: string
  attachedAs: string[]
}

/**
 * Modo `review` crea un BORRADOR; `auto` manda. Es el mismo freno que el del
 * botón de enviar en un formulario: la acción irreversible la decide él.
 */
export async function sendApplication(
  draft: EmailDraft,
  mode: 'draft' | 'send'
): Promise<SendResult> {
  const raw = toGmailRaw(buildMime(draft, newBoundary()))
  const attachedAs = draft.attachments.map((a) => a.filename)

  if (mode === 'draft') {
    const json = await gmailFetch('/drafts', {
      method: 'POST',
      body: JSON.stringify({ message: { raw } })
    })
    const d = DraftSchema.parse(json)
    return {
      kind: 'draft',
      id: d.id,
      messageId: d.message?.id ?? '',
      to: draft.to,
      subject: draft.subject,
      attachedAs
    }
  }

  const json = await gmailFetch('/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw })
  })
  const m = MessageSchema.parse(json)
  return { kind: 'sent', id: m.id, messageId: m.id, to: draft.to, subject: draft.subject, attachedAs }
}

const PartSchema: z.ZodType<{ filename?: string; body?: { size?: number } }> = z.object({
  filename: z.string().optional(),
  body: z.object({ size: z.number().optional() }).optional()
})

const DraftGetSchema = z.object({
  id: z.string(),
  message: z.object({
    id: z.string(),
    payload: z
      .object({ parts: z.array(PartSchema).optional() })
      .optional()
  })
})

/**
 * Lee el borrador de vuelta y devuelve los adjuntos que Gmail realmente
 * guardó. Es la única forma honesta de verificar que el CV llegó con el nombre
 * correcto: que la API haya devuelto 200 no prueba nada sobre el contenido.
 */
export async function draftAttachments(
  draftId: string
): Promise<{ filename: string; size: number }[]> {
  const json = await gmailFetch(`/drafts/${draftId}?format=full`)
  const d = DraftGetSchema.parse(json)

  return (d.message.payload?.parts ?? [])
    .filter((p) => (p.filename ?? '') !== '')
    .map((p) => ({ filename: p.filename ?? '', size: p.body?.size ?? 0 }))
}

export async function deleteDraft(draftId: string): Promise<void> {
  const token = await getAccessToken()
  await fetch(`${BASE}/drafts/${draftId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  })
}
