/**
 * Qué pendientes produce la REGLA de QR sobre los datos reales.
 *
 *   npx tsx scripts/verify-qr-rules.ts
 *
 * Solo lectura y sin modelo: no escribe en la base ni gasta cuota. Sirve para ver
 * el antes/después del dedup por identidad sin tener que aplicar nada.
 */
import { getSupabaseClient } from '../src/main/supabase/client'
import { deterministicTasks } from '../src/main/core/tasks/rules'
import { esCifrado, etiquetaDe, identidadDe } from '../src/main/core/tasks/qr-identity'
import type { TaskCandidate } from '../src/main/core/tasks/types'

async function main(): Promise<void> {
  const supabase = getSupabaseClient()

  const { data, error } = await supabase
    .from('entries')
    .select('id, user_id, body, extractions ( kind, payload )')
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)

  const candidatos: TaskCandidate[] = ((data ?? []) as Record<string, unknown>[])
    .map((row) => ({
      entryId: String(row.id),
      userId: String(row.user_id),
      body: String(row.body ?? '').trim(),
      attachments: ((row.extractions ?? []) as { kind: string; payload: unknown }[]).map((e) => ({
        kind: e.kind,
        payload: (e.payload ?? {}) as Record<string, unknown>
      }))
    }))
    .filter((c) => c.attachments.some((a) => a.kind === 'qr'))

  console.log(`Notas con al menos un QR: ${candidatos.length}\n`)

  let adjuntosQr = 0
  let codigos = 0
  let pendientes = 0

  for (const c of candidatos) {
    const qrs = c.attachments.filter((a) => a.kind === 'qr')
    const todosLosCodigos = qrs.flatMap((a) =>
      Array.isArray(a.payload.codes)
        ? (a.payload.codes as unknown[]).filter((x): x is string => typeof x === 'string')
        : []
    )

    adjuntosQr += qrs.length
    codigos += todosLosCodigos.length

    const tasks = deterministicTasks(c)
    pendientes += tasks.length

    console.log('='.repeat(74))
    console.log(`nota ${c.entryId.slice(0, 8)} — "${c.body.replace(/\s+/g, ' ').slice(0, 56)}"`)
    console.log(`  ${qrs.length} adjunto(s) con QR · ${todosLosCodigos.length} código(s) leído(s)`)

    console.log('\n  IDENTIDADES:')
    const agrupadas = new Map<string, number>()
    for (const code of todosLosCodigos) {
      const id = identidadDe(code)
      agrupadas.set(id, (agrupadas.get(id) ?? 0) + 1)
    }
    for (const [id, veces] of agrupadas) {
      console.log(`    ${id}   (×${veces})`)
    }

    console.log('\n  ETIQUETAS:')
    for (const code of [...new Set(todosLosCodigos)]) {
      const et = etiquetaDe(code)
      console.log(
        `    ${esCifrado(code) ? 'cifrado ' : 'legible '} → ${et ?? '(null → usa la nota)'}`
      )
    }

    console.log(`\n  PENDIENTES QUE SE CREAN (${tasks.length}):`)
    for (const t of tasks) {
      console.log(`    • ${t.title}`)
      console.log(`      detail : ${t.detail ?? '(ninguno)'}`)
      console.log(`      dedupe : ${t.dedupeKey ?? 'null (solo dentro de la nota)'}`)
    }
    console.log()
  }

  console.log('='.repeat(74))
  console.log(
    `TOTAL: ${adjuntosQr} adjuntos · ${codigos} códigos → ${pendientes} pendientes de QR`
  )
  console.log('Antes del arreglo eran 3 (2 de ellos el mismo evento repetido).')
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
