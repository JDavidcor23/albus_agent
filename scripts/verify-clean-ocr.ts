/**
 * Corre limpiarOcr() sobre el OCR REAL que ya está en la base y muestra crudo
 * contra limpio, lado a lado.
 *
 *   npx tsx scripts/verify-clean-ocr.ts
 *
 * Solo lectura. Un heurístico de "esto es basura" no se puede aprobar mirando el
 * código: hay que ver qué se comió sobre los datos de verdad.
 */
import { getSupabaseClient } from '../src/main/supabase/client'
import {
  esLegible,
  fusionarCapturas,
  limpiarOcr
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

  const filas = ((data ?? []) as { entry_id: string; payload: unknown }[])
    .map((r) => {
      const p = (r.payload ?? {}) as Record<string, unknown>
      return { entry: r.entry_id, texto: typeof p.text === 'string' ? p.text : '' }
    })
    .filter((r) => r.texto.trim().length > 0)
    .map((r) => ({ ...r, limpio: limpiarOcr(r.texto) }))

  let totalCrudo = 0
  let totalLimpio = 0

  for (const f of filas) {
    totalCrudo += f.texto.length
    totalLimpio += f.limpio.length

    // Una línea se considera CONSERVADA si su contenido alfanumérico aparece en
    // la salida. Comparar prefijos crudos daría falsos positivos: a `* Javascript
    // execution` se le saca el bullet y sigue estando entera.
    const salidaAlnum = f.limpio.split('\n').map(alnum)
    const descartadas = f.texto
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => {
        const clave = alnum(l)
        return clave.length > 0 && !salidaAlnum.some((s) => s.includes(clave))
      })

    const legible = esLegible(f.limpio)

    console.log('='.repeat(74))
    console.log(
      `entry ${f.entry.slice(0, 8)} · ${f.texto.length} → ${f.limpio.length} chars · ` +
        `${legible ? 'LEGIBLE' : 'ILEGIBLE → la UI no lo muestra'}`
    )
    console.log('='.repeat(74))
    console.log('\n--- LIMPIO (lo que va a ver el usuario) ---')
    console.log(f.limpio || '  (no quedó nada legible)')
    console.log(`\n--- DESCARTADO (${descartadas.length}) — revisar que no haya nada útil ---`)
    for (const l of descartadas) console.log(`  ✗ ${l}`)
    console.log()
  }

  // Lo que va a ver el usuario de verdad: UN bloque por nota, fusionado.
  console.log('='.repeat(74))
  console.log('FUSIONADO POR NOTA — así queda el detalle')
  console.log('='.repeat(74))

  const porNota = new Map<string, string[]>()
  for (const f of filas) porNota.set(f.entry, [...(porNota.get(f.entry) ?? []), f.texto])

  for (const [entry, textos] of porNota) {
    const fusionado = fusionarCapturas(textos)
    const sueltos = textos.map((t) => limpiarOcr(t).split('\n').filter(Boolean).length)
    const antes = sueltos.reduce((a, b) => a + b, 0)
    const despues = fusionado.split('\n').filter(Boolean).length

    console.log(
      `\n  ${entry.slice(0, 8)} · ${textos.length} captura(s) · ` +
        `${antes} → ${despues} líneas · ${esLegible(fusionado) ? 'LEGIBLE' : 'ILEGIBLE'}`
    )
    if (esLegible(fusionado)) {
      for (const l of fusionado.split('\n').slice(0, 12)) console.log(`     ${l}`)
      if (despues > 12) console.log(`     … y ${despues - 12} línea(s) más`)
    } else {
      console.log('     (la UI dice: "no se pudo leer esta captura, abrí la original")')
    }
  }

  console.log(
    `\nTotal: ${totalCrudo} → ${totalLimpio} chars ` +
      `(${Math.round((1 - totalLimpio / totalCrudo) * 100)}% descartado)`
  )
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
