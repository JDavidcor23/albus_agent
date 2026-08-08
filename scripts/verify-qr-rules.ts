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
import { isEncrypted, labelOf, identityOf } from '../src/main/core/tasks/qr-identity'
import type { TaskCandidate } from '../src/main/core/tasks/types'

async function main(): Promise<void> {
  const supabase = getSupabaseClient()

  const { data, error } = await supabase
    .from('entries')
    .select('id, user_id, body, extractions ( kind, payload )')
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)

  const candidates: TaskCandidate[] = ((data ?? []) as Record<string, unknown>[])
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

  console.log(`Notas con al menos un QR: ${candidates.length}\n`)

  let qrAttachments = 0
  let codes = 0
  let tasksCreated = 0

  for (const c of candidates) {
    const qrs = c.attachments.filter((a) => a.kind === 'qr')
    const allCodes = qrs.flatMap((a) =>
      Array.isArray(a.payload.codes)
        ? (a.payload.codes as unknown[]).filter((x): x is string => typeof x === 'string')
        : []
    )

    qrAttachments += qrs.length
    codes += allCodes.length

    const tasks = deterministicTasks(c)
    tasksCreated += tasks.length

    console.log('='.repeat(74))
    console.log(`nota ${c.entryId.slice(0, 8)} — "${c.body.replace(/\s+/g, ' ').slice(0, 56)}"`)
    console.log(`  ${qrs.length} adjunto(s) con QR · ${allCodes.length} código(s) leído(s)`)

    console.log('\n  IDENTIDADES:')
    const grouped = new Map<string, number>()
    for (const code of allCodes) {
      const id = identityOf(code)
      grouped.set(id, (grouped.get(id) ?? 0) + 1)
    }
    for (const [id, times] of grouped) {
      console.log(`    ${id}   (×${times})`)
    }

    console.log('\n  ETIQUETAS:')
    for (const code of [...new Set(allCodes)]) {
      const label = labelOf(code)
      console.log(
        `    ${isEncrypted(code) ? 'cifrado ' : 'legible '} → ${label ?? '(null → usa la nota)'}`
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
    `TOTAL: ${qrAttachments} adjuntos · ${codes} códigos → ${tasksCreated} pendientes de QR`
  )
  console.log('Antes del arreglo eran 3 (2 de ellos el mismo evento repetido).')
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
