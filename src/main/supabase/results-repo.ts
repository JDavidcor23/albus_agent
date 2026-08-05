import { z } from 'zod'
import { getSupabaseClient } from './client'
import { labelFor, summaryFor, type ResultRow } from '../core/extraction/present'
import type { ExtractionKind } from '../core/extraction/types'

const RowSchema = z.object({
  entry_id: z.string(),
  attachment_path: z.string(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  confidence: z.number(),
  created_at: z.string()
})

/** Lo ya extraído, para que la pantalla no arranque vacía. */
export async function listResults(limit = 500): Promise<ResultRow[]> {
  const supabase = getSupabaseClient()

  const { data, error } = await supabase
    .from('extractions')
    .select('entry_id, attachment_path, kind, payload, confidence, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw new Error(error.message)

  const rows: ResultRow[] = []
  for (const raw of Array.isArray(data) ? data : []) {
    const parsed = RowSchema.safeParse(raw)
    if (!parsed.success) continue

    const r = parsed.data
    rows.push({
      id: `${r.entry_id}:${r.attachment_path}`,
      label: labelFor(r.attachment_path),
      kind: r.kind as ExtractionKind,
      summary: summaryFor({
        kind: r.kind as ExtractionKind,
        payload: r.payload ?? {},
        confidence: r.confidence,
        source: ''
      }),
      confidence: r.confidence
    })
  }

  return rows
}

/**
 * Borra SOLO las extracciones de adjuntos que todavía no tienen copia en Drive.
 *
 * Un reset total no sirve una vez que `storage-prune` corrió: los adjuntos ya
 * archivados fueron borrados de Supabase Storage, así que reprocesarlos falla al
 * descargar y los degrada a `failed`, perdiendo la referencia de Drive que era
 * justamente lo que los hacía valiosos.
 *
 * Excluye el body (`attachment_path = ''`): no tiene bytes, nunca se archiva, y
 * reprocesarlo no cambia nada.
 */
export async function clearUnarchived(): Promise<number> {
  const supabase = getSupabaseClient()

  const { data, error } = await supabase
    .from('extractions')
    .delete()
    .neq('attachment_path', '')
    .is('payload->drive', null)
    .select('id')

  if (error) throw new Error(error.message)
  return Array.isArray(data) ? data.length : 0
}

/** Borra todo lo extraído para poder reprocesar desde cero. */
export async function clearResults(): Promise<number> {
  const supabase = getSupabaseClient()

  const { data, error } = await supabase
    .from('extractions')
    .delete()
    .not('entry_id', 'is', null)
    .select('id')

  if (error) throw new Error(error.message)
  return Array.isArray(data) ? data.length : 0
}
