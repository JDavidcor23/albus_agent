import type { ApplyStatus, CandidateProfile } from './types'

/**
 * El puente entre el estado interno y la base "Registro de aplicaciones".
 *
 * Vive en el dominio y es puro porque es la parte que se puede equivocar en
 * silencio: mandar un `Status` que no existe en el select hace que Notion cree
 * la opción sola, y de golpe la base tiene siete estados y los filtros del
 * usuario dejan de servir. Acá el mapeo es total y cerrado: no hay rama que
 * devuelva un string libre.
 */

/** Exactamente las opciones que existen hoy en el select de la base. */
export const NOTION_STATUSES = [
  'Applying',
  'In process',
  'Rejected',
  'First contact',
  'Backlog',
  'Descartada'
] as const

export type NotionStatus = (typeof NOTION_STATUSES)[number]

/**
 * Estados que Albus puede reportar. Los cuatro primeros salen del bucle de
 * postulación; los otros los setea el usuario cuando pasa algo.
 */
export type AlbusStatus =
  | ApplyStatus
  | 'interview'
  | 'rejected'
  | 'discarded'
  | 'contacted'
  | 'ranked'

const STATUS_MAP: Record<AlbusStatus, NotionStatus> = {
  // Se envió de verdad.
  submitted: 'Applying',
  // Llenado y esperando tu click: todavía no es una postulación.
  filled: 'Backlog',
  planned: 'Backlog',
  // Rankeada pero sin tocar.
  ranked: 'Backlog',
  // Algo salió mal: queda en la cola con la razón en "Próxima acción".
  blocked: 'Backlog',
  failed: 'Backlog',
  'needs-login': 'Backlog',
  // Los que pone el usuario.
  interview: 'In process',
  rejected: 'Rejected',
  discarded: 'Descartada',
  contacted: 'First contact'
}

/**
 * `null` cuando el estado no está mapeado. El llamador no escribe la fila en
 * vez de inventar una opción — un select con basura adentro es peor que una
 * fila sin estado.
 */
export function notionStatus(status: string): NotionStatus | null {
  return STATUS_MAP[status as AlbusStatus] ?? null
}

/**
 * Regla del workspace: en Notion no va PII de contacto del candidato. La base
 * la puede ver cualquiera con quien comparta la página, y el teléfono y el
 * correo personal no aportan nada al seguimiento.
 *
 * Se tacha en vez de rechazar la escritura entera: el valor que importa es la
 * nota, y perderla porque adentro había un mail es cambiar un problema chico
 * por uno grande.
 */
export function scrubPii(text: string, p: CandidateProfile): string {
  // De más largo a más corto, y NO es un detalle de estilo: reemplazar
  // "3003073883" antes que "+573003073883" deja el "+57" suelto en la fila.
  const literals = [
    p.email,
    `${p.phoneCountryCode}${p.phone}`,
    `${p.phoneCountryCode} ${p.phone}`,
    p.phone
  ]
    .filter((l) => l.trim() !== '')
    .sort((a, b) => b.length - a.length)

  let clean = text
  for (const l of literals) {
    clean = clean.split(l).join('[oculto]')
  }

  // El teléfono también aparece formateado (300 307 3883) o con guiones.
  const digitsOnly = p.phone.replace(/\D/g, '')
  if (digitsOnly.length >= 7) {
    const flexible = new RegExp(digitsOnly.split('').join('[\\s.-]?'), 'g')
    clean = clean.replace(flexible, '[oculto]')
  }

  // Y cualquier otro mail que se haya colado desde el OCR o la descripción.
  return clean.replace(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g, '[oculto]')
}

export interface NotionRow {
  company: string
  role: string
  status: NotionStatus
  date: string
  fitScore: number | null
  postLink: string
  /** URL del posting o contacto del reclutador. NUNCA el mail del candidato. */
  contactUrl: string
  jobDescription: string
  coverLetter: string
  nextAction: string
}

/** Notion corta los rich_text en 2000 caracteres y devuelve 400 si te pasás. */
export const MAX_RICH_TEXT = 1900

export function truncate(text: string): string {
  return text.length <= MAX_RICH_TEXT ? text : `${text.slice(0, MAX_RICH_TEXT - 1)}…`
}

/** El cuerpo que espera la API de Notion. Se arma acá para poder testearlo. */
export function notionProperties(row: NotionRow): Record<string, unknown> {
  const text = (value: string): Record<string, unknown> => ({
    rich_text: value === '' ? [] : [{ text: { content: truncate(value) } }]
  })

  return {
    Company: { title: [{ text: { content: row.company.slice(0, 200) } }] },
    'Role/Position': text(row.role),
    Status: { select: { name: row.status } },
    'Date of application': { date: { start: row.date } },
    'Fit Score': { number: row.fitScore },
    'post link': { url: row.postLink === '' ? null : row.postLink },
    'Email/Linkedin URL': text(row.contactUrl),
    'Job description': text(row.jobDescription),
    'cover letter': text(row.coverLetter),
    'Próxima acción': text(row.nextAction)
  }
}
