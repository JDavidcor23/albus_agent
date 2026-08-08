import type { ArchivePort, ItemSource, ResultSink } from './ports'
import type { ExtractionResult, PendingItem } from './types'
import type { LlmTier } from './cascade'
import { runCascade } from './cascade'
import { decideArchive } from './archive'

export interface BatchHooks {
  /** Antes de tocar el item: la UI ya puede mostrarlo con su spinner. */
  onItemStart?: (item: PendingItem, index: number, total: number) => void
  onItemDone?: (item: PendingItem, result: ExtractionResult, index: number, total: number) => void
}

export async function processBatch(
  source: ItemSource,
  sink: ResultSink,
  limit: number,
  hooks: BatchHooks = {},
  llm?: LlmTier,
  archive?: ArchivePort
): Promise<{
  processed: number
  byKind: Record<string, number>
  failed: number
  archived: number
}> {
  const items = await source.listPending(limit)
  const total = items.length

  let processed = 0
  let failed = 0
  let archived = 0
  const byKind: Record<string, number> = {}

  // El procesamiento es secuencial porque Tesseract y Sharp consumen mucha memoria y CPU.
  for (let i = 0; i < total; i++) {
    const item = items[i]
    hooks.onItemStart?.(item, i, total)

    try {
      let bytes: Uint8Array | null = null
      if (item.attachmentPath !== '') {
        bytes = await source.downloadAttachment(item.attachmentPath)
      }

      const result = await runCascade(item, bytes, llm)

      // Archivado. La política de qué se retiene vive en decideArchive() y es
      // pura: de un comprobante guardamos la imagen, de un QR de LinkedIn no —
      // ese es un contacto, y un contacto son campos, no un archivo.
      let final = result
      const folder = bytes !== null ? decideArchive(result) : null

      if (archive !== undefined && folder !== null && bytes !== null) {
        try {
          const ref = await archive.archive(item, result, folder, bytes)
          final = { ...result, payload: { ...result.payload, drive: ref } }
          if (!ref.reused) archived++
        } catch (archiveError: unknown) {
          // Drive caído no puede costarnos la extracción: ya la tenemos hecha y
          // reprocesar cuesta CPU y cuota. Se guarda igual, con la falla anotada,
          // y el archivado se reintenta cuando se limpie ese item.
          const message =
            archiveError instanceof Error ? archiveError.message : String(archiveError)
          console.warn(
            `[worker] no se pudo archivar en Drive ${item.entryId}/${item.attachmentPath}: ${message}`
          )
          final = { ...result, payload: { ...result.payload, driveError: message } }
        }
      }

      await sink.save(item, final)

      processed++
      byKind[final.kind] = (byKind[final.kind] ?? 0) + 1
      hooks.onItemDone?.(item, final, i, total)
    } catch (error: unknown) {
      failed++
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `[worker] Error procesando item ${item.entryId}/${item.attachmentPath || 'body'}: ${message}`
      )

      // Dejamos constancia del fallo para que el item deje de figurar como
      // pendiente: un adjunto borrado de Storage falla igual en cada corrida y
      // sin esta fila se reintentaría para siempre.
      //
      // Si el propio save falla (la base caída, por ejemplo) no insistimos: ahí
      // reintentar en la próxima corrida SÍ es lo correcto.
      const failure: ExtractionResult = {
        kind: 'failed',
        payload: { error: message },
        confidence: 0,
        source: 'error'
      }

      try {
        await sink.save(item, failure)
      } catch (saveError: unknown) {
        const saveMessage =
          saveError instanceof Error ? saveError.message : String(saveError)
        console.error(`[worker] tampoco se pudo registrar el fallo: ${saveMessage}`)
      }

      hooks.onItemDone?.(item, failure, i, total)
    }
  }

  return { processed, byKind, failed, archived }
}
