export interface PendingItem {
  entryId: string
  userId: string
  /** '' significa "el body de la entry", no un adjunto. */
  attachmentPath: string
  mime: string
  sizeBytes: number
  body: string | null
  /**
   * `created_at` de la entry, ISO. Es la fecha de CAPTURA, no la de procesado:
   * el nombre del archivo en Drive se arma con esto, y "el pago de este mes"
   * significa el mes en que lo sacaste, no el mes en que Albus lo miró.
   */
  createdAt: string
  /**
   * El body de la entry a la que pertenece este item — TAMBIÉN para los adjuntos.
   *
   * Cuando subís una captura casi siempre escribís al lado qué es: "pago de gym",
   * "Código QR del evento de cripto de 27 y 28 de agosto". Ese texto es la mejor
   * etiqueta que va a existir, porque la escribió un humano que sabía qué estaba
   * guardando. El OCR jamás va a sacar "gym" de un comprobante de Bre-B.
   *
   * Antes se procesaba como un item suelto y terminaba en una fila `text` de
   * confianza 0.2 mientras el adjunto quedaba sin concepto. Es contexto, no un
   * item aparte.
   */
  context: string | null
}

/**
 * Espejo exacto del CHECK de `extractions.kind` en
 * supabase/migrations/0001_extractions.sql. Si agregás uno acá, agregalo allá.
 */
export type ExtractionKind =
  | 'qr'
  | 'receipt'
  | 'profile'
  | 'document'
  | 'text'
  | 'none'
  | 'failed'

export interface ExtractionResult {
  kind: ExtractionKind
  payload: Record<string, unknown>
  /** 0..1. Los escalones deterministas puntúan alto; el OCR, según cuánto matcheó. */
  confidence: number
  /** Qué escalón resolvió: 'jsqr' | 'tesseract' | 'regex' | 'skip' | 'error' */
  source: string
}
