import { getSupabaseClient } from './client'
import type { ResultSink } from '../core/extraction/ports'
import type { ExtractionResult, PendingItem } from '../core/extraction/types'

export function createResultSink(): ResultSink {
  return {
    async save(item: PendingItem, result: ExtractionResult): Promise<void> {
      const supabase = getSupabaseClient()

      // Usamos upsert con la restricción unique (entry_id, attachment_path)
      // para garantizar idempotencia si un item se procesa más de una vez.
      const { error } = await supabase.from('extractions').upsert(
        {
          entry_id: item.entryId,
          attachment_path: item.attachmentPath,
          user_id: item.userId,
          kind: result.kind,
          payload: result.payload,
          confidence: result.confidence,
          source: result.source
        },
        { onConflict: 'entry_id,attachment_path' }
      )

      if (error) {
        throw new Error(
          `Error guardando extracción para entry ${item.entryId} (${item.attachmentPath || 'body'}): ${error.message}`
        )
      }
    }
  }
}
