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

const Extraccion = z.object({
  entry_id: z.string(),
  attachment_path: z.string(),
  kind: z.string(),
  payload: z.unknown(),
  source: z.string()
})

const Adjunto = z.object({ size: z.number().optional() })

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

  let bytesFilas = 0
  let filas = 0
  for (const raw of Array.isArray(ext) ? ext : []) {
    const parsed = Extraccion.safeParse(raw)
    if (!parsed.success) continue
    filas++
    // Aproximación honesta: el JSON serializado es el grueso de la fila.
    bytesFilas += Buffer.byteLength(JSON.stringify(parsed.data), 'utf8')
  }

  // --- Storage: lo que hay DE VERDAD en el bucket -----------------------
  //
  // Se recorre el bucket, no `entries.attachments`. Esa columna es metadata que
  // My Notes escribió al subir y NO se actualiza cuando un archivo se borra:
  // seguiría contando bytes que ya no ocupan nada. Medir la metadata en vez del
  // bucket es exactamente como no medir.
  let bytesAdjuntos = 0
  let adjuntos = 0
  let huerfanos = 0

  async function recorrer(prefijo: string, profundidad: number): Promise<void> {
    if (profundidad > 4) return
    const { data, error } = await supabase.storage
      .from('attachments')
      .list(prefijo, { limit: 1000 })
    if (error) throw new Error(error.message)

    for (const obj of data ?? []) {
      const ruta = prefijo ? `${prefijo}/${obj.name}` : obj.name
      // Un "archivo" sin metadata es en realidad una carpeta.
      const tam = (obj.metadata as { size?: number } | null)?.size
      if (tam === undefined || tam === null) {
        await recorrer(ruta, profundidad + 1)
      } else {
        adjuntos++
        bytesAdjuntos += tam
      }
    }
  }
  await recorrer('', 0)

  // Referencias en la tabla que ya no tienen archivo detrás: eso es lo que hace
  // que My Notes muestre fotos rotas.
  const { data: entries, error: e2 } = await supabase.from('entries').select('attachments')
  if (e2) throw new Error(e2.message)
  let referenciados = 0
  for (const row of Array.isArray(entries) ? entries : []) {
    const lista = (row as { attachments: unknown }).attachments
    if (!Array.isArray(lista)) continue
    for (const a of lista) {
      if (Adjunto.safeParse(a).success) referenciados++
    }
  }
  huerfanos = referenciados - adjuntos

  const LIMITE_DB = 500 * MB
  const LIMITE_STORAGE = 1024 * MB

  console.log('='.repeat(66))
  console.log('BASE DE DATOS  (limite free: 500 MB)  <- el indice, texto')
  console.log('='.repeat(66))
  console.log(`  filas en extractions : ${filas}`)
  console.log(`  peso total           : ${human(bytesFilas)}`)
  console.log(`  promedio por fila    : ${human(filas ? bytesFilas / filas : 0)}`)
  console.log(`  ocupado del limite   : ${((bytesFilas / LIMITE_DB) * 100).toFixed(5)} %`)
  console.log(
    `  caben todavia        : ~${Math.floor(LIMITE_DB / (bytesFilas / Math.max(filas, 1))).toLocaleString('es')} filas mas`
  )

  console.log('\n' + '='.repeat(66))
  console.log('STORAGE  (limite free: 1 GB)  <- los binarios, las fotos')
  console.log('='.repeat(66))
  console.log(`  archivos en el bucket : ${adjuntos}`)
  console.log(`  peso real             : ${human(bytesAdjuntos)}`)
  console.log(`  ocupado del limite    : ${((bytesAdjuntos / LIMITE_STORAGE) * 100).toFixed(2)} %`)
  if (huerfanos > 0) {
    console.log(
      `  referencias huerfanas : ${huerfanos}  <- My Notes las va a mostrar rotas ` +
        `hasta que lea desde Drive`
    )
  }

  console.log('\n' + '='.repeat(66))
  console.log(
    `Por cada 1 MB de fotos, el indice pesa ${
      bytesAdjuntos > 0 ? ((bytesFilas / bytesAdjuntos) * 1024).toFixed(1) : '?'
    } KB`
  )
  console.log('='.repeat(66))
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
