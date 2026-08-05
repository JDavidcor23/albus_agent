import { z } from 'zod'
import { getSupabaseClient } from './client'
import type { ItemSource } from '../core/extraction/ports'
import type { PendingItem } from '../core/extraction/types'

// Validamos cada attachment individualmente para ignorar basura
const AttachmentSchema = z.object({
  path: z.string(),
  name: z.string().optional().catch(''),
  mime: z.string().optional().catch('application/octet-stream'),
  size: z.number().optional().catch(0)
})

const EntryRowSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  created_at: z.string(),
  body: z.string().nullable(),
  attachments: z.array(z.unknown()).nullable(),
  extractions: z.array(
    z.object({
      attachment_path: z.string()
    })
  ).nullable() // Si no hay extractions puede venir [] o null
})

/** Filas por request a PostgREST. No es el límite de items pendientes. */
const PAGE_SIZE = 200

/** Tope de páginas por llamada: evita barrer la tabla entera si todo está procesado. */
const MAX_PAGES = 25

export function createItemSource(): ItemSource {
  return {
    async listPending(limit: number): Promise<PendingItem[]> {
      const supabase = getSupabaseClient()
      const pendingItems: PendingItem[] = []

      // Paginamos de la más vieja a la más nueva hasta llenar `limit` o quedarnos
      // sin entries. Un solo fetch con `limit * N` no sirve: si las primeras N
      // entries ya están procesadas devuelve vacío para siempre y las viejas
      // no se alcanzan nunca. El filtrado del anti-join va en memoria porque
      // PostgREST no expresa NOT EXISTS sin RPC ni vista.
      for (let page = 0; page < MAX_PAGES; page++) {
        if (pendingItems.length >= limit) break

        const from = page * PAGE_SIZE
        const { data, error } = await supabase
          .from('entries')
          .select(`
            id,
            user_id,
            created_at,
            body,
            attachments,
            extractions ( attachment_path )
          `)
          .order('created_at', { ascending: true })
          .range(from, from + PAGE_SIZE - 1)

        if (error) {
          throw new Error(`Error listando pending items: ${error.message}`)
        }

        const rawRows: unknown[] = Array.isArray(data) ? data : []
        if (rawRows.length === 0) break

        for (const rawRow of rawRows) {
          if (pendingItems.length >= limit) break

          // Por fila, no por lote: una entry corrupta se saltea sola en vez de
          // tirar abajo el batch entero y bloquear el avance para siempre.
          const rowResult = EntryRowSchema.safeParse(rawRow)
          if (!rowResult.success) {
            console.warn('[item-source] fila de entries descartada por schema inválido')
            continue
          }
          const row = rowResult.data

          const processedPaths = new Set(
            (row.extractions || []).map((e) => e.attachment_path)
          )

          // El body cuenta como un item más, con path ''.
          if (!processedPaths.has('')) {
            pendingItems.push({
              entryId: row.id,
              userId: row.user_id,
              attachmentPath: '',
              mime: 'text/plain',
              sizeBytes: row.body ? new TextEncoder().encode(row.body).length : 0,
              body: row.body,
              createdAt: row.created_at,
              context: row.body
            })
            if (pendingItems.length >= limit) break
          }

          const rawAttachments = row.attachments || []
          for (const raw of rawAttachments) {
            const parsed = AttachmentSchema.safeParse(raw)
            if (!parsed.success) continue

            const attachment = parsed.data
            if (!processedPaths.has(attachment.path)) {
              pendingItems.push({
                entryId: row.id,
                userId: row.user_id,
                attachmentPath: attachment.path,
                mime: attachment.mime || 'application/octet-stream',
                sizeBytes: attachment.size || 0,
                body: null,
                createdAt: row.created_at,
                // El adjunto hereda el texto que el usuario escribió al subirlo.
                context: row.body
              })
              if (pendingItems.length >= limit) break
            }
          }
        }

        // Última página: no hay más filas que barrer.
        if (rawRows.length < PAGE_SIZE) break
      }

      return pendingItems
    },

    async downloadAttachment(path: string): Promise<Uint8Array> {
      const supabase = getSupabaseClient()
      const { data, error } = await supabase.storage
        .from('attachments')
        .download(path)

      if (error) {
        throw new Error(`Error descargando adjunto ${path}: ${error.message}`)
      }

      const buffer = await data.arrayBuffer()
      return new Uint8Array(buffer)
    }
  }
}
