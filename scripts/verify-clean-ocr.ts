/**
 * Corre cleanOcr() sobre el OCR REAL que ya está en la base y muestra crudo
 * contra limpio, lado a lado.
 *
 *   npx tsx scripts/verify-clean-ocr.ts
 *
 * Solo lectura. Un heurístico de "esto es basura" no se puede aprobar mirando el
 * código: hay que ver qué se comió sobre los datos de verdad.
 */
import { getSupabaseClient } from '../src/main/supabase/client'
import {
  isReadable,
  mergeScreenshots,
  cleanOcr
} from '../src/main/core/extraction/clean-ocr'

/** Igual que en clean-ocr: comparar por contenido, no por formato. */
function alnum(t: string): string {
  return t.replace(/[^0-9a-záéíóúüñ]/gi, '').toLowerCase()
}

async function main(): Promise<void> {
  const supabase = getSupabaseClient()

  // attachment_path '' es el BODY de la nota: texto que el usuario escribió, ya
  // limpio por definición. El chrome vive en el OCR de las CAPTURAS.
  const { data, error } = await supabase
    .from('extractions')
    .select('entry_id, attachment_path, kind, payload')
    .in('kind', ['text', 'document', 'receipt'])
    .neq('attachment_path', '')

  if (error) throw new Error(error.message)

  const rows = ((data ?? []) as { entry_id: string; payload: unknown }[])
    .map((r) => {
      const p = (r.payload ?? {}) as Record<string, unknown>
      return { entry: r.entry_id, text: typeof p.text === 'string' ? p.text : '' }
    })
    .filter((r) => r.text.trim().length > 0)
    .map((r) => ({ ...r, clean: cleanOcr(r.text) }))

  let totalRaw = 0
  let totalClean = 0

  for (const f of rows) {
    totalRaw += f.text.length
    totalClean += f.clean.length

    // Una línea se considera CONSERVADA si su contenido alfanumérico aparece en
    // la salida. Comparar prefijos crudos daría falsos positivos: a `* Javascript
    // execution` se le saca el bullet y sigue estando entera.
    const outputAlnum = f.clean.split('\n').map(alnum)
    const discarded = f.text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => {
        const key = alnum(l)
        return key.length > 0 && !outputAlnum.some((s) => s.includes(key))
      })

    const readable = isReadable(f.clean)

    console.log('='.repeat(74))
    console.log(
      `entry ${f.entry.slice(0, 8)} · ${f.text.length} → ${f.clean.length} chars · ` +
        `${readable ? 'LEGIBLE' : 'ILEGIBLE → la UI no lo muestra'}`
    )
    console.log('='.repeat(74))
    console.log('\n--- LIMPIO (lo que va a ver el usuario) ---')
    console.log(f.clean || '  (no quedó nada legible)')
    console.log(`\n--- DESCARTADO (${discarded.length}) — revisar que no haya nada útil ---`)
    for (const l of discarded) console.log(`  ✗ ${l}`)
    console.log()
  }

  // Lo que va a ver el usuario de verdad: UN bloque por nota, fusionado.
  console.log('='.repeat(74))
  console.log('FUSIONADO POR NOTA — así queda el detalle')
  console.log('='.repeat(74))

  const byNote = new Map<string, string[]>()
  for (const f of rows) byNote.set(f.entry, [...(byNote.get(f.entry) ?? []), f.text])

  for (const [entry, texts] of byNote) {
    const merged = mergeScreenshots(texts)
    const separate = texts.map((t) => cleanOcr(t).split('\n').filter(Boolean).length)
    const before = separate.reduce((a, b) => a + b, 0)
    const after = merged.split('\n').filter(Boolean).length

    console.log(
      `\n  ${entry.slice(0, 8)} · ${texts.length} captura(s) · ` +
        `${before} → ${after} líneas · ${isReadable(merged) ? 'LEGIBLE' : 'ILEGIBLE'}`
    )
    if (isReadable(merged)) {
      for (const l of merged.split('\n').slice(0, 12)) console.log(`     ${l}`)
      if (after > 12) console.log(`     … y ${after - 12} línea(s) más`)
    } else {
      console.log('     (la UI dice: "no se pudo leer esta captura, abrí la original")')
    }
  }

  console.log(
    `\nTotal: ${totalRaw} → ${totalClean} chars ` +
      `(${Math.round((1 - totalClean / totalRaw) * 100)}% descartado)`
  )
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
