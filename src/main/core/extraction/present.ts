import type { ExtractionKind, ExtractionResult, PendingItem } from './types'

/** Una fila lista para pintar. El renderer no interpreta payloads. */
export interface ResultRow {
  id: string
  label: string
  kind: ExtractionKind
  summary: string
  confidence: number
}

const MONEDA = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0
})

/**
 * Nombre legible del archivo. Las rutas del bucket son
 * `<userId>/<fecha>/<uuid>-<nombre real>`, así que hay que sacarle el uuid.
 */
export function labelFor(attachmentPath: string): string {
  if (attachmentPath === '') return 'nota de texto'

  const base = attachmentPath.split('/').pop() ?? attachmentPath
  const sinUuid = base.replace(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i,
    ''
  )
  return sinUuid.length > 0 ? sinUuid : base
}

function texto(payload: Record<string, unknown>, clave: string): string {
  const v = payload[clave]
  return typeof v === 'string' ? v : ''
}

/** Una línea que diga qué se encontró, sin que el usuario abra nada. */
export function summaryFor(result: ExtractionResult): string {
  const p = result.payload

  switch (result.kind) {
    case 'qr': {
      const codes = Array.isArray(p.codes) ? p.codes.map(String) : []
      const primero = codes[0] ?? ''
      // Los QR de check-in de eventos traen un blob cifrado de CryptoJS, no una
      // URL. Mostrar 200 caracteres de base64 no le sirve a nadie.
      if (primero.startsWith('U2FsdGVkX1')) return 'código cifrado (check-in de evento)'
      return primero
    }

    case 'receipt': {
      const partes: string[] = []
      if (typeof p.entity === 'string') partes.push(p.entity)
      if (typeof p.amount === 'number') partes.push(MONEDA.format(p.amount))
      if (typeof p.date === 'string') partes.push(p.date)
      if (typeof p.reference === 'string') partes.push(`ref ${p.reference}`)
      return partes.join(' · ')
    }

    case 'profile': {
      const perfiles = Array.isArray(p.profiles) ? p.profiles.map(String) : []
      return perfiles.join(', ')
    }

    case 'text': {
      const urls = Array.isArray(p.urls) ? p.urls.map(String) : []
      if (urls.length > 0) return urls.join(', ')
      const t = texto(p, 'text').replace(/\s+/g, ' ').trim()
      return t.length > 120 ? `${t.slice(0, 120)}…` : t
    }

    case 'failed':
      return texto(p, 'error')

    case 'none':
      return 'sin contenido reconocible'

    default:
      return ''
  }
}

export function toRow(item: PendingItem, result: ExtractionResult): ResultRow {
  return {
    id: `${item.entryId}:${item.attachmentPath}`,
    label: labelFor(item.attachmentPath),
    kind: result.kind,
    summary: summaryFor(result),
    confidence: result.confidence
  }
}
