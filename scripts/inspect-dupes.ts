/**
 * ¿Por qué hay pendientes repetidos?
 *
 *   npx tsx scripts/inspect-dupes.ts
 *
 * Solo lectura. Agrupa los pendientes abiertos por el CONTENIDO del QR del que
 * salieron, cruzando entries. Responde la pregunta que ninguna otra herramienta
 * contesta: dos tareas que se ven iguales, ¿salieron del mismo código en notas
 * distintas, o de códigos distintos que se parecen?
 *
 * Es la diferencia entre "el dedup no alcanza" y "el dedup no aplica".
 */
import { getSupabaseClient } from '../src/main/supabase/client'

interface Fila {
  id: string
  entry_id: string
  title: string
  status: string
  source: string
  created_at: string
}

async function main(): Promise<void> {
  const supabase = getSupabaseClient()

  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('id, entry_id, title, status, source, created_at')
    .neq('source', 'centinela')
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)
  const filas = (tasks ?? []) as Fila[]

  console.log(`Pendientes (sin centinelas): ${filas.length}\n`)

  // --- 1. Títulos repetidos entre entries distintas -------------------------
  const porTitulo = new Map<string, Fila[]>()
  for (const f of filas) {
    const k = f.title.toLowerCase().trim()
    porTitulo.set(k, [...(porTitulo.get(k) ?? []), f])
  }

  const titulosRepes = [...porTitulo.entries()].filter(([, v]) => v.length > 1)
  console.log('='.repeat(72))
  console.log(`TÍTULOS IDÉNTICOS EN MÁS DE UNA ENTRY: ${titulosRepes.length}`)
  console.log('='.repeat(72))
  for (const [titulo, v] of titulosRepes) {
    console.log(`\n  "${titulo}"  ×${v.length}`)
    for (const f of v) console.log(`     entry ${f.entry_id.slice(0, 8)} · ${f.status} · ${f.source}`)
  }

  // --- 2. Los QR: mismo código en entries distintas ------------------------
  const { data: ex, error: e2 } = await supabase
    .from('extractions')
    .select('entry_id, attachment_path, kind, payload')
    .eq('kind', 'qr')

  if (e2) throw new Error(e2.message)

  const porCodigo = new Map<string, Set<string>>()
  const adjuntosPorCodigo = new Map<string, number>()

  for (const row of (ex ?? []) as { entry_id: string; payload: unknown }[]) {
    const p = (row.payload ?? {}) as Record<string, unknown>
    const codes = Array.isArray(p.codes) ? p.codes : []
    for (const c of codes) {
      if (typeof c !== 'string' || c.trim().length === 0) continue
      porCodigo.set(c, (porCodigo.get(c) ?? new Set()).add(row.entry_id))
      adjuntosPorCodigo.set(c, (adjuntosPorCodigo.get(c) ?? 0) + 1)
    }
  }

  console.log(`\n${'='.repeat(72)}`)
  console.log(`CÓDIGOS QR DISTINTOS: ${porCodigo.size}  ·  adjuntos con QR: ${(ex ?? []).length}`)
  console.log('='.repeat(72))

  for (const [code, entries] of porCodigo) {
    const veces = adjuntosPorCodigo.get(code) ?? 0
    const cruza = entries.size > 1
    console.log(
      `\n  ${cruza ? '⚠ CRUZA ENTRIES' : '  una sola entry'} · ${veces} adjunto(s) · ${entries.size} entry(s)`
    )
    console.log(`     code: ${code.slice(0, 100)}${code.length > 100 ? '…' : ''}`)
    for (const id of entries) {
      const suyas = filas.filter((f) => f.entry_id === id)
      console.log(`     entry ${id.slice(0, 8)} → ${suyas.length} pendiente(s)`)
      for (const f of suyas) console.log(`        · [${f.status}] ${f.title.slice(0, 90)}`)
    }
  }

  // --- 3. Cuán largo es lo que escribió el usuario -------------------------
  const { data: entries, error: e3 } = await supabase
    .from('entries')
    .select('id, body')
    .not('body', 'is', null)

  if (e3) throw new Error(e3.message)

  const largos = ((entries ?? []) as { id: string; body: string }[])
    .map((e) => ({ id: e.id, n: (e.body ?? '').trim().length }))
    .filter((e) => e.n > 200)
    .sort((a, b) => b.n - a.n)

  console.log(`\n${'='.repeat(72)}`)
  console.log(`NOTAS DE MÁS DE 200 CARACTERES (candidatas a resumen): ${largos.length}`)
  console.log('='.repeat(72))
  for (const l of largos.slice(0, 10)) {
    console.log(`  ${l.id.slice(0, 8)} · ${l.n} chars`)
  }
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
