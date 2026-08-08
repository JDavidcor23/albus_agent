import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { coverUploadName, cvUploadName } from '../core/jobs/cv-name'
import { gmailMode, isValidEmail, type EmailAttachment, type EmailDraft } from '../core/jobs/email'
import { notionStatus, scrubPii, type NotionRow } from '../core/jobs/notion-map'
import type { ApplyMode, CandidateProfile, JobPosting } from '../core/jobs/types'
import { draftAttachments, sendApplication, hasGmailScope } from '../gmail/send'
import { isNotionConfigured } from '../notion/client'
import { upsertApplication } from '../notion/applications'
import { createWorkspaceKitSource, loadProfile, slugify } from './workspace'
import { uploadStagingDir } from './apply-runner'

/**
 * Postulación por correo.
 *
 * Esta es la rama que motivaba el pedido de manejar Chrome: hay vacantes que
 * dicen "mandá tu CV a jobs@empresa.com". Manejar la interfaz de Gmail con un
 * navegador para eso es la herramienta equivocada — el botón de adjuntar abre
 * un diálogo del sistema y el DOM de Gmail se mueve solo. La API acepta el
 * MIME ya armado, con el adjunto adentro, y no tiene interfaz que se rompa.
 *
 * Mismo freno que el formulario: `review` deja un BORRADOR, `auto` manda.
 */

export interface EmailApplyRequest {
  to: string
  cc: string[]
  company: string
  role: string
  slug: string
  /** Vacío = se usa la plantilla de abajo. */
  subject: string
  body: string
  mode: ApplyMode
  postUrl: string
  fitRating: string
  jobDescription: string
}

export interface EmailApplyReport {
  status: 'draft' | 'sent' | 'blocked' | 'failed'
  to: string[]
  subject: string
  /** Lo que Gmail guardó de verdad, leído de vuelta. No lo que mandamos. */
  attachedAs: { filename: string; size: number }[]
  draftId: string
  notion: { pageId: string | null; error: string | null }
  message: string
}

function defaultSubject(p: CandidateProfile, req: EmailApplyRequest): string {
  return `${req.role} — ${p.fullName}`
}

function defaultBody(p: CandidateProfile, req: EmailApplyRequest): string {
  return [
    `Hola,`,
    ``,
    `Les escribo por la posición de ${req.role} en ${req.company}.`,
    ``,
    `Soy ${p.currentTitle} con ${p.yearsExperience.default} años trabajando en ${Object.keys(
      p.yearsExperience
    )
      .filter((k) => k !== 'default')
      .slice(0, 4)
      .join(', ')}. Adjunto mi CV y la carta de presentación.`,
    ``,
    `Portfolio: ${p.portfolioUrl}`,
    `LinkedIn: ${p.linkedinUrl}`,
    `GitHub: ${p.githubUrl}`,
    ``,
    `Gracias por el tiempo,`,
    p.fullName
  ].join('\n')
}

async function attach(path: string | null, displayName: string): Promise<EmailAttachment | null> {
  if (path === null) return null
  try {
    const bytes = await readFile(path)
    return {
      filename: displayName,
      mimeType: path.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
      content: new Uint8Array(bytes)
    }
  } catch (error: unknown) {
    console.warn(`[jobs] no pude leer ${basename(path)}: ${String(error)}`)
    return null
  }
}

export async function applyByEmail(req: EmailApplyRequest): Promise<EmailApplyReport> {
  const fail = (status: EmailApplyReport['status'], message: string): EmailApplyReport => ({
    status,
    to: [req.to],
    subject: req.subject,
    attachedAs: [],
    draftId: '',
    notion: { pageId: null, error: null },
    message
  })

  if (!isValidEmail(req.to)) return fail('blocked', `"${req.to}" no es una dirección válida`)

  const profile = await loadProfile()

  if (req.to.toLowerCase() === profile.email.toLowerCase() && req.mode === 'auto') {
    // Mandarse la postulación a uno mismo es el bug que se descubre tarde.
    return fail('blocked', 'el destinatario sos vos mismo')
  }

  const scope = await hasGmailScope()
  if (!scope.ok) {
    return fail(
      'blocked',
      'el token de Google no tiene el scope gmail.compose. Corré: npm run gmail:auth'
    )
  }

  // El kit es el mismo que usa el formulario: los PDF que compiló el workspace.
  const posting: JobPosting = {
    url: req.postUrl,
    company: req.company,
    role: req.role,
    slug: req.slug !== '' ? req.slug : slugify(req.company)
  }
  const kitSource = createWorkspaceKitSource(uploadStagingDir())
  const kit = await kitSource.findKit(posting)

  const attachments: EmailAttachment[] = []
  const cv = await attach(kit.cv, kit.cv !== null ? cvUploadName(profile, kit.cv) : '')
  if (cv !== null) attachments.push(cv)
  const cover = await attach(
    kit.cover,
    kit.cover !== null ? coverUploadName(profile, kit.cover) : ''
  )
  if (cover !== null) attachments.push(cover)

  if (attachments.length === 0) {
    return fail(
      'blocked',
      `no hay PDF compilado para "${posting.slug}" en el workspace. Generá el kit antes de mandar el mail.`
    )
  }

  const draft: EmailDraft = {
    fromName: profile.fullName,
    fromEmail: profile.email,
    to: [req.to],
    cc: req.cc.filter(isValidEmail),
    subject: req.subject !== '' ? req.subject : defaultSubject(profile, req),
    body: req.body !== '' ? req.body : defaultBody(profile, req),
    attachments
  }

  const action = gmailMode(req.mode)

  // `dry-run` tampoco crea el borrador: no toca la cuenta de Gmail para nada.
  if (action === 'none') {
    return {
      status: 'draft',
      to: draft.to,
      subject: draft.subject,
      attachedAs: attachments.map((a) => ({ filename: a.filename, size: a.content.byteLength })),
      draftId: '',
      notion: { pageId: null, error: null },
      message: 'dry-run: el mail está armado pero no se creó ni el borrador'
    }
  }

  let result
  try {
    result = await sendApplication(draft, action)
  } catch (error: unknown) {
    return fail('failed', error instanceof Error ? error.message : String(error))
  }

  // Leemos de vuelta lo que Gmail guardó: que la API devuelva 200 no prueba
  // que el adjunto haya llegado con el nombre correcto.
  let attachedAs: { filename: string; size: number }[] = []
  if (result.kind === 'draft') {
    try {
      attachedAs = await draftAttachments(result.id)
    } catch {
      attachedAs = attachments.map((a) => ({ filename: a.filename, size: a.content.byteLength }))
    }
  } else {
    attachedAs = attachments.map((a) => ({ filename: a.filename, size: a.content.byteLength }))
  }

  const notion = await mirror(profile, req, result.kind)

  return {
    status: result.kind,
    to: draft.to,
    subject: draft.subject,
    attachedAs,
    draftId: result.kind === 'draft' ? result.id : '',
    notion,
    message:
      result.kind === 'draft'
        ? 'borrador creado en Gmail con el CV adjunto. Revisalo y mandalo vos.'
        : 'correo enviado'
  }
}

async function mirror(
  profile: CandidateProfile,
  req: EmailApplyRequest,
  kind: 'draft' | 'sent'
): Promise<{ pageId: string | null; error: string | null }> {
  if (!isNotionConfigured()) return { pageId: null, error: 'falta NOTION_TOKEN en .env' }

  const status = notionStatus(kind === 'sent' ? 'submitted' : 'filled')
  if (status === null) return { pageId: null, error: 'estado sin mapear' }

  try {
    const row: NotionRow = {
      company: req.company,
      role: req.role,
      status,
      date: new Date().toISOString().slice(0, 10),
      fitScore:
        Number.isFinite(Number(req.fitRating)) && req.fitRating !== '' ? Number(req.fitRating) : null,
      postLink: req.postUrl,
      // El correo de contacto de la EMPRESA sí va: no es PII del candidato y es
      // lo único que permite retomar el hilo. El suyo nunca.
      contactUrl: req.to,
      jobDescription: scrubPii(req.jobDescription, profile),
      coverLetter: '',
      nextAction:
        kind === 'draft' ? 'Borrador en Gmail esperando que lo mandes' : 'Esperando respuesta'
    }

    const r = await upsertApplication(row)
    return { pageId: r.pageId, error: null }
  } catch (error: unknown) {
    return { pageId: null, error: error instanceof Error ? error.message : String(error) }
  }
}
