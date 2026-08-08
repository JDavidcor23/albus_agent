import { createHash } from 'node:crypto'
import type { ExtractionResult, PendingItem } from './types'

/**
 * Carpetas de Drive donde Albus puede escribir. Son las que existen de verdad:
 * ver `scripts/drive-organize.ts`, que es quien las crea.
 */
export type ArchiveFolder =
  | 'pagos'
  | 'qr-eventos'
  | 'contactos'
  | 'info'
  | 'sin-clasificar'

export interface ArchivedRef {
  fileId: string
  folder: ArchiveFolder
  /** Link para abrir el archivo desde el celular. */
  webViewLink: string | null
  /** true si el archivo ya estaba en Drive y se reusó en vez de volver a subir. */
  reused: boolean
}

/**
 * Decide EN QUÉ CARPETA de Drive va la imagen de un item.
 *
 * Nunca devuelve null para un item con bytes: **todo original se conserva**.
 *
 * Esto reemplaza una política anterior que tiraba los píxeles de las láminas y
 * los perfiles para quedarse "solo con el texto". Se descartó por dos motivos
 * medidos:
 *
 *  1. Optimizaba la cuota de Supabase Storage (1 GB), pero el destino es Drive,
 *     que tiene 5 TB. La restricción no existe donde termina el archivo.
 *  2. Asumía que el texto OCR alcanzaba. No alcanza: una lámina real produjo
 *     "Y1los — OS y tomamos decisiones E o ¿sa ¿du k". Borrar la imagen apoyado
 *     en eso es perder el contenido y quedarse con el ruido.
 *
 * Guardar cuesta ~0. Borrar es irreversible. La asimetría decide.
 *
 * Función pura: no toca red ni disco.
 */
export function decideArchive(result: ExtractionResult): ArchiveFolder | null {
  switch (result.kind) {
    case 'receipt':
      return 'pagos'

    // Un QR de LinkedIn es un contacto; uno de evento es una entrada. Los datos
    // van a Postgres en los dos casos, pero la imagen se guarda igual: la del
    // evento porque en la puerta te la escanean, la del contacto porque guardar
    // sale gratis y equivocarse borrando no.
    case 'qr':
      return hasProfiles(result.payload) ? 'contactos' : 'qr-eventos'

    case 'profile':
      return 'contactos'

    // Láminas, capturas de LinkedIn, material de referencia.
    case 'document':
    case 'text':
      return 'info'

    // No supimos qué era. Razón de más para no borrarlo.
    case 'none':
    case 'failed':
      return 'sin-clasificar'
  }
}

function hasProfiles(payload: Record<string, unknown>): boolean {
  const profiles = payload.profiles
  return Array.isArray(profiles) && profiles.length > 0
}

/** "Pago de GYM!" -> "pago-de-gym". Sin tildes, sin sorpresas en Drive. */
function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

/** La fecha del comprobante le gana a la de captura: es la que vos preguntás. */
function dateFor(item: PendingItem, result: ExtractionResult): string {
  const fromReceipt = result.payload.date
  if (typeof fromReceipt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fromReceipt)) return fromReceipt
  return item.createdAt.slice(0, 10)
}

/**
 * Nombre del archivo en Drive.
 *
 * Tres decisiones, y las tres son para que lo encuentres desde el celular:
 *
 *  - La FECHA va primero, así el orden alfabético de Drive es el cronológico.
 *    Y es la fecha del pago cuando se pudo extraer, no la de captura: "el pago
 *    de abril" es cuando pagaste, no cuando Albus lo miró.
 *  - La ETIQUETA sale del texto que escribiste al subir la captura. "pago de gym"
 *    le gana a cualquier cosa que el OCR pueda sacar de un comprobante de Bre-B.
 *  - El SUFIJO son 6 hex de la clave. Feo pero necesario: dos adjuntos de la
 *    misma entry comparten contexto y fecha, y Drive deja convivir dos archivos
 *    con el mismo nombre sin avisar.
 */
export function archiveFileName(item: PendingItem, result: ExtractionResult): string {
  const date = dateFor(item, result)
  const base = item.attachmentPath.split('/').pop() ?? ''
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : ''

  const label = slug(item.context ?? '') || result.kind
  const suffix = archiveKey(item).slice(0, 6)

  return `${date}_${label}_${suffix}${ext}`
}

/**
 * Clave estable de idempotencia. Drive no tiene unique constraints, así que la
 * guardamos en `appProperties` del archivo y la buscamos antes de subir. Sin
 * esto, reprocesar un lote deja el Drive lleno de duplicados.
 *
 * Identifica el mismo par que el unique de `extractions`: (entry_id, attachment_path).
 *
 * Va HASHEADA y no en claro porque **cada appProperty de Drive tiene un tope de
 * 124 bytes UTF-8 contando clave + valor**, y un path real de Storage es así:
 *
 *   169c4008-cc36-.../2026-07-31/2c95a345-...-IMG_20260727_171617.jpg
 *
 * Solo el path ya se pasa. En claro, Drive responde 403 propertyLengthLimitExceeded
 * y no sube nada. 32 hex de SHA-256 sobran para no colisionar acá.
 */
export function archiveKey(item: PendingItem): string {
  return createHash('sha256')
    .update(`${item.entryId}:${item.attachmentPath}`)
    .digest('hex')
    .slice(0, 32)
}
