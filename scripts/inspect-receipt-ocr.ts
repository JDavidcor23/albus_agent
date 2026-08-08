/**
 * Vuelca el texto OCR crudo de los adjuntos que se clasificaron como comprobante,
 * y muestra qué saca cada patrón sobre ese texto.
 *
 *   npx tsx scripts/inspect-receipt-ocr.ts
 *
 * Sirve para arreglar los patrones MIRANDO el texto real en vez de adivinar qué
 * formato usa la app de pagos.
 */
import { z } from 'zod'
import { getSupabaseClient } from '../src/main/supabase/client'
import { createItemSource } from '../src/main/supabase/item-source'
import { readText } from '../src/main/core/extraction/ocr'
import { terminateOcr } from '../src/main/core/extraction/ocr'
import {
  findAmount,
  findDate,
  findEntity,
  findMerchant,
  findAccountRef,
  findReference
} from '../src/main/core/extraction/patterns'

const Row = z.object({
  attachment_path: z.string(),
  payload: z.unknown()
})

async function main(): Promise<void> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('extractions')
    .select('attachment_path, payload')
    .eq('kind', 'receipt')

  if (error) throw new Error(error.message)

  const source = createItemSource()

  for (const raw of Array.isArray(data) ? data : []) {
    const parsed = Row.safeParse(raw)
    if (!parsed.success || parsed.data.attachment_path === '') continue

    const path = parsed.data.attachment_path
    const p = parsed.data.payload as Record<string, unknown> | null

    console.log('\n' + '='.repeat(70))
    console.log(`contexto: "${String(p?.context ?? '')}"`)
    console.log(`guardado: entity=${String(p?.entity)} amount=${String(p?.amount)} date=${String(p?.date)} ref=${String(p?.reference)}`)
    console.log('='.repeat(70))

    const bytes = await source.downloadAttachment(path)
    const text = await readText(bytes)

    console.log('\n--- OCR crudo ---')
    console.log(text.trim() || '(vacio)')

    console.log('\n--- que ve cada patron ---')
    console.log(`  findEntity     (riel)     : ${String(findEntity(text))}`)
    console.log(`  findMerchant   (a quien)  : ${String(findMerchant(text))}`)
    console.log(`  findAccountRef (contrato) : ${String(findAccountRef(text))}`)
    console.log(`  findAmount                : ${String(findAmount(text))}`)
    console.log(`  findDate                  : ${String(findDate(text))}`)
    console.log(`  findReference  (transacc) : ${String(findReference(text))}`)
  }

  await terminateOcr()
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
