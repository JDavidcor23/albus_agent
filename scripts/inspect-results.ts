/**
 * Mira qué salió realmente de la cascada. Solo lectura.
 *
 *   npx tsx scripts/inspect-results.ts
 */
import { config as loadDotenv } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

loadDotenv()

interface Row {
  attachment_path: string
  kind: string
  payload: Record<string, unknown>
  confidence: number
  source: string
}

async function main(): Promise<void> {
  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  )

  const { data, error } = await supabase
    .from('extractions')
    .select('attachment_path, kind, payload, confidence, source')

  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Row[]

  const esImagen = (r: Row): boolean => r.attachment_path !== ''

  console.log('=== kind segun origen ===')
  const tabla = new Map<string, { body: number; img: number }>()
  for (const r of rows) {
    const e = tabla.get(r.kind) ?? { body: 0, img: 0 }
    if (esImagen(r)) e.img++
    else e.body++
    tabla.set(r.kind, e)
  }
  console.log('kind        body  imagen')
  for (const [kind, e] of [...tabla].sort((a, b) => b[1].img + b[1].body - a[1].img - a[1].body)) {
    console.log(`${kind.padEnd(12)}${String(e.body).padStart(4)}${String(e.img).padStart(8)}`)
  }

  console.log('\n=== los 5 QR ===')
  for (const r of rows.filter((x) => x.kind === 'qr')) {
    console.log(' ', JSON.stringify(r.payload.codes))
  }

  console.log('\n=== los comprobantes ===')
  for (const r of rows.filter((x) => x.kind === 'receipt')) {
    const p = r.payload
    console.log(`  ${p.entity ?? '?'} · $${p.amount ?? '?'} · ${p.date ?? '?'} · ref ${p.reference ?? '?'} · conf ${r.confidence}`)
  }

  console.log('\n=== calidad del OCR en las imagenes que cayeron en "text" ===')
  const textoDeImagen = rows.filter((r) => r.kind === 'text' && esImagen(r))
  console.log(`${textoDeImagen.length} imagenes. Muestra de las primeras 6:\n`)
  for (const r of textoDeImagen.slice(0, 6)) {
    const t = String(r.payload.text ?? '').replace(/\s+/g, ' ').trim()
    const legible = t.replace(/[^\p{L}\p{N} ]/gu, '').length / Math.max(t.length, 1)
    console.log(`  [${(legible * 100).toFixed(0)}% alfanumerico, ${t.length} chars] ${t.slice(0, 110)}`)
  }

  const vacias = textoDeImagen.filter((r) => String(r.payload.text ?? '').trim().length < 20).length
  console.log(`\n  ${vacias}/${textoDeImagen.length} sacaron menos de 20 caracteres (OCR practicamente vacio)`)
}

main().catch((e: unknown) => {
  console.error('Falló:', e instanceof Error ? e.message : e)
  process.exit(1)
})
