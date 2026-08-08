/**
 * ¿Cuánto pesa de verdad lo que Albus guarda en Supabase?
 *
 *   npx tsx scripts/inspect-supabase-size.ts
 *
 * Solo lectura. Separa los DOS recursos que la gente confunde:
 *   - Base de datos (500 MB en el plan free): texto. Las filas de `extractions`.
 *   - Storage (1 GB en el plan free): los binarios. Los adjuntos de My Notes.
 */
import { z } from 'zod'
import { getSupabaseClient } from '../src/main/supabase/client'

const MB = 1024 * 1024

const Extraction = z.object({
  entry_id: z.string(),
  attachment_path: z.string(),
  kind: z.string(),
  payload: z.unknown(),
  source: z.string()
})

const Attachment = z.object({ size: z.number().optional() })

function human(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

async function main(): Promise<void> {
  const supabase = getSupabaseClient()

  // --- Base de datos: las filas de extractions --------------------------
  const { data: ext, error: e1 } = await supabase
    .from('extractions')
    .select('entry_id, attachment_path, kind, payload, source')
  if (e1) throw new Error(e1.message)

  let rowBytes = 0
  let rowCount = 0
  for (const raw of Array.isArray(ext) ? ext : []) {
    const parsed = Extraction.safeParse(raw)
    if (!parsed.success) continue
    rowCount++
    // Aproximación honesta: el JSON serializado es el grueso de la fila.
    rowBytes += Buffer.byteLength(JSON.stringify(parsed.data), 'utf8')
  }

  // --- Storage: lo que hay DE VERDAD en el bucket -----------------------
  //
  // Se recorre el bucket, no `entries.attachments`. Esa columna es metadata que
  // My Notes escribió al subir y NO se actualiza cuando un archivo se borra:
  // seguiría contando bytes que ya no ocupan nada. Medir la metadata en vez del
  // bucket es exactamente como no medir.
  let attachmentBytes = 0
  let attachmentCount = 0
  let orphans = 0

  async function walk(prefix: string, depth: number): Promise<void> {
    if (depth > 4) return
    const { data, error } = await supabase.storage
      .from('attachments')
      .list(prefix, { limit: 1000 })
    if (error) throw new Error(error.message)

    for (const obj of data ?? []) {
      const path = prefix ? `${prefix}/${obj.name}` : obj.name
      // Un "archivo" sin metadata es en realidad una carpeta.
      const size = (obj.metadata as { size?: number } | null)?.size
      if (size === undefined || size === null) {
        await walk(path, depth + 1)
      } else {
        attachmentCount++
        attachmentBytes += size
      }
    }
  }
  await walk('', 0)

  // Referencias en la tabla que ya no tienen archivo detrás: eso es lo que hace
  // que My Notes muestre fotos rotas.
  const { data: entries, error: e2 } = await supabase.from('entries').select('attachments')
  if (e2) throw new Error(e2.message)
  let referenced = 0
  for (const row of Array.isArray(entries) ? entries : []) {
    const list = (row as { attachments: unknown }).attachments
    if (!Array.isArray(list)) continue
    for (const a of list) {
      if (Attachment.safeParse(a).success) referenced++
    }
  }
  orphans = referenced - attachmentCount

  const DB_LIMIT = 500 * MB
  const STORAGE_LIMIT = 1024 * MB

  console.log('='.repeat(66))
  console.log('BASE DE DATOS  (limite free: 500 MB)  <- el indice, texto')
  console.log('='.repeat(66))
  console.log(`  filas en extractions : ${rowCount}`)
  console.log(`  peso total           : ${human(rowBytes)}`)
  console.log(`  promedio por fila    : ${human(rowCount ? rowBytes / rowCount : 0)}`)
  console.log(`  ocupado del limite   : ${((rowBytes / DB_LIMIT) * 100).toFixed(5)} %`)
  console.log(
    `  caben todavia        : ~${Math.floor(DB_LIMIT / (rowBytes / Math.max(rowCount, 1))).toLocaleString('es')} filas mas`
  )

  console.log('\n' + '='.repeat(66))
  console.log('STORAGE  (limite free: 1 GB)  <- los binarios, las fotos')
  console.log('='.repeat(66))
  console.log(`  archivos en el bucket : ${attachmentCount}`)
  console.log(`  peso real             : ${human(attachmentBytes)}`)
  console.log(`  ocupado del limite    : ${((attachmentBytes / STORAGE_LIMIT) * 100).toFixed(2)} %`)
  if (orphans > 0) {
    console.log(
      `  referencias huerfanas : ${orphans}  <- My Notes las va a mostrar rotas ` +
        `hasta que lea desde Drive`
    )
  }

  console.log('\n' + '='.repeat(66))
  console.log(
    `Por cada 1 MB de fotos, el indice pesa ${
      attachmentBytes > 0 ? ((rowBytes / attachmentBytes) * 1024).toFixed(1) : '?'
    } KB`
  )
  console.log('='.repeat(66))
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
