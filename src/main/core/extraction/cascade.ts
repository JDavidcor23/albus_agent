import type { ExtractionResult, ExtractionKind, PendingItem } from './types'
import type { LlmProvider } from './llm-port'
import { readQrCodes } from './qr'
import { readText } from './ocr'
import { findDate, findLinkedInProfiles, findReceipt, findUrls } from './patterns'
import { classifyWithLlm } from './llm-classify'

const NONE: ExtractionResult = { kind: 'none', payload: {}, confidence: 0, source: 'skip' }

/** Escalón 4, opcional. Si no se pasa, la cascada termina en los patrones. */
export interface LlmTier {
  provider: LlmProvider
  model: string | null
}

/** El vocabulario del modelo es más rico que el de la tabla; se colapsa. */
const LLM_KIND_TO_TABLE: Record<string, ExtractionKind> = {
  receipt: 'receipt',
  profile: 'profile',
  job_offer: 'document',
  event: 'document',
  note: 'text',
  none: 'none'
}

/**
 * Clasifica texto plano con los patrones deterministas. Compartido entre el
 * body de una entry y la salida del OCR: es el mismo problema.
 */
function classifyText(text: string, source: string): ExtractionResult | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null

  const receipt = findReceipt(trimmed)
  if (receipt !== null) {
    return {
      kind: 'receipt',
      // `dateSource` deja explícito de dónde salió la fecha. Sin eso, una fecha
      // de captura y una del banco se ven idénticas en la tabla, y la primera es
      // una aproximación: "pagué el gas en abril" no se responde con la fecha en
      // que sacaste la captura.
      payload: { ...receipt, dateSource: receipt.date !== null ? 'receipt' : null },
      confidence: receipt.confidence,
      source
    }
  }

  const profiles = findLinkedInProfiles(trimmed)
  if (profiles.length > 0) {
    return { kind: 'profile', payload: { profiles }, confidence: 0.9, source }
  }

  const urls = findUrls(trimmed)
  if (urls.length > 0) {
    return { kind: 'text', payload: { urls, text: trimmed }, confidence: 0.4, source }
  }

  return { kind: 'text', payload: { text: trimmed }, confidence: 0.2, source }
}

/**
 * Pega al resultado el texto que el usuario escribió al subir el adjunto.
 *
 * Es la etiqueta más confiable que va a existir: la puso un humano que sabía qué
 * estaba guardando. El OCR nunca va a sacar "gym" de un comprobante de Bre-B,
 * pero el body dice "pago de gym". Se anota, no se reclasifica: cambiar el kind
 * por una frase suelta produciría comprobantes fantasma.
 */
function withContext(result: ExtractionResult, context: string | null): ExtractionResult {
  const clean = context?.trim()
  if (!clean) return result

  const payload: Record<string, unknown> = { ...result.payload, context: clean }

  // Muchos comprobantes NO traen fecha. La pantalla de confirmación de Bre-B, por
  // ejemplo, muestra monto, destino y llave — y ninguna fecha. Ahí la nota del
  // usuario ("pago de gym de abril") es la única fuente que queda.
  //
  // La de la imagen siempre gana: es el dato del banco, no una interpretación.
  if (result.kind === 'receipt' && payload.date == null) {
    const fromNote = findDate(clean)
    if (fromNote !== null) {
      payload.date = fromNote
      payload.dateSource = 'context'
    }
  }

  return { ...result, payload }
}

/** Un QR de LinkedIn es un perfil, no una URL cualquiera. */
function classifyQr(codes: string[]): ExtractionResult {
  const profiles = codes.flatMap((code) => findLinkedInProfiles(code))

  return {
    kind: 'qr',
    payload: profiles.length > 0 ? { codes, profiles } : { codes },
    confidence: 1,
    source: 'jsqr'
  }
}

/**
 * Último escalón. Si el CLI falla —cuota agotada, binario caído— se devuelve lo
 * que habían sacado los patrones: perder el enriquecimiento es aceptable, perder
 * el item no.
 */
async function escalateToLlm(
  llm: LlmTier,
  text: string,
  fallback: ExtractionResult
): Promise<ExtractionResult> {
  try {
    const c = await classifyWithLlm(llm.provider, llm.model, text)

    return {
      kind: LLM_KIND_TO_TABLE[c.kind] ?? 'text',
      payload: { ...c.fields, summary: c.summary, llmKind: c.kind, text },
      confidence: c.kind === 'none' ? 0.2 : 0.8,
      source: `cli:${llm.provider.id}${llm.model !== null ? `/${llm.model}` : ''}`
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[cascade] escalón LLM falló, queda lo de los patrones: ${message}`)
    return fallback
  }
}

/**
 * Corre la cascada sobre un item. Cada escalón cuesta más que el anterior y se
 * corta apenas uno resuelve; el escalón de CLI (el que gasta cuota) no vive acá.
 *
 * NUNCA propaga excepciones: un item que revienta devuelve kind 'failed' para
 * que quede registrado y el worker siga con el resto del lote.
 */
export async function runCascade(
  item: PendingItem,
  bytes: Uint8Array | null,
  llm?: LlmTier
): Promise<ExtractionResult> {
  try {
    if (item.attachmentPath === '') {
      return item.body !== null ? (classifyText(item.body, 'regex') ?? NONE) : NONE
    }

    if (bytes === null || bytes.byteLength === 0) return NONE
    if (!item.mime.startsWith('image/')) return NONE

    const codes = await readQrCodes(bytes)
    if (codes.length > 0) return withContext(classifyQr(codes), item.context)

    const text = await readText(bytes)
    const byPatterns = classifyText(text, 'tesseract') ?? NONE

    // Escalón 4. Solo si los baratos no resolvieron: un 'receipt' o un 'profile'
    // ya reconocido por regex no necesita gastar cuota.
    const resolved = byPatterns.kind !== 'text' && byPatterns.kind !== 'none'
    if (llm === undefined || resolved || text.trim().length < 15) {
      return withContext(byPatterns, item.context)
    }

    return withContext(await escalateToLlm(llm, text, byPatterns), item.context)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[cascade] ${item.entryId}/${item.attachmentPath || 'body'}: ${message}`)
    return { kind: 'failed', payload: { error: message }, confidence: 0, source: 'error' }
  }
}
