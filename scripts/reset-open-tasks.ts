/**
 * Borra los pendientes ABIERTOS para poder re-derivarlos con las reglas nuevas.
 *
 *   npx tsx scripts/reset-open-tasks.ts                (dry-run, no borra nada)
 *   npx tsx scripts/reset-open-tasks.ts --apply
 *   npx tsx scripts/reset-open-tasks.ts --apply --solo-qr   (solo notas con QR)
 *
 * Después: npx tsx scripts/detect-tasks.ts --provider <x> --apply
 *
 * ---------------------------------------------------------------------------
 * La trampa que este script evita
 * ---------------------------------------------------------------------------
 * `listTaskCandidates` saltea toda entry que YA TENGA una fila en `tasks` — así
 * es como no vuelve a gastar cuota sobre lo mismo. Consecuencia: borrar solo los
 * abiertos de una nota que además tiene cerrados la deja sin pendiente Y sin
 * posibilidad de re-analizarse. El pendiente desaparece para siempre y nadie se
 * entera.
 *
 * Por eso una nota con algún task cerrado NO SE TOCA, y se reporta. Preferimos
 * dejarle un titulo viejo antes que borrarle algo que no vuelve.
 *
 * Lo que marcaste como hecho o descartado es estado tuyo, no derivable de la
 * nota: no se puede regenerar. Es lo único acá que no es reproducible.
 */
import { getSupabaseClient } from '../src/main/supabase/client'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const ONLY_QR = args.includes('--solo-qr')

interface TaskRow {
  id: string
  entry_id: string
  title: string
  status: string
  source: string
}

async function main(): Promise<void> {
  const supabase = getSupabaseClient()

  const { data, error } = await supabase
    .from('tasks')
    .select('id, entry_id, title, status, source')

  if (error) throw new Error(error.message)
  const all = (data ?? []) as TaskRow[]

  // Qué entries tienen QR, si hay que filtrar por eso.
  let entriesWithQr: Set<string> | null = null
  if (ONLY_QR) {
    const { data: qr, error: e2 } = await supabase
      .from('extractions')
      .select('entry_id')
      .eq('kind', 'qr')
    if (e2) throw new Error(e2.message)
    entriesWithQr = new Set(((qr ?? []) as { entry_id: string }[]).map((r) => r.entry_id))
  }

  const byEntry = new Map<string, TaskRow[]>()
  for (const t of all) byEntry.set(t.entry_id, [...(byEntry.get(t.entry_id) ?? []), t])

  const toDelete: TaskRow[] = []
  const untouchable: { entry: string; closed: TaskRow[]; open: TaskRow[] }[] = []
  const outOfScope: string[] = []

  for (const [entry, rows] of byEntry) {
    if (entriesWithQr !== null && !entriesWithQr.has(entry)) {
      if (rows.some((f) => f.status === 'open' && f.source !== 'centinela')) {
        outOfScope.push(entry)
      }
      continue
    }

    const closed = rows.filter((f) => f.status !== 'open' && f.source !== 'centinela')
    const open = rows.filter((f) => f.status === 'open')

    if (closed.length > 0) {
      if (open.length > 0) untouchable.push({ entry, closed, open })
      continue
    }

    // Sin cerrados: se puede limpiar la entry entera, centinelas incluidos, para
    // que `listTaskCandidates` la vuelva a ver.
    toDelete.push(...rows)
  }

  console.log(APPLY ? 'MODO APPLY — se borra' : 'MODO DRY-RUN — no se borra nada')
  console.log(ONLY_QR ? 'Alcance: solo notas con al menos un QR\n' : 'Alcance: todas las notas\n')

  console.log('='.repeat(74))
  console.log(`SE BORRAN ${toDelete.length} fila(s), de ${new Set(toDelete.map((f) => f.entry_id)).size} nota(s)`)
  console.log('='.repeat(74))
  for (const f of toDelete) {
    const label = f.source === 'centinela' ? '[centinela]' : `[${f.status}]`
    console.log(`  ${f.entry_id.slice(0, 8)} ${label} ${f.title.slice(0, 70)}`)
  }

  if (untouchable.length > 0) {
    console.log(`\n${'='.repeat(74)}`)
    console.log(`NO SE TOCAN — ${untouchable.length} nota(s) con pendientes ya cerrados`)
    console.log('='.repeat(74))
    console.log('Borrarles los abiertos los perderia sin poder re-derivarlos,')
    console.log('porque la nota ya no vuelve a entrar al analisis.\n')
    for (const g of untouchable) {
      console.log(`  nota ${g.entry.slice(0, 8)}`)
      for (const c of g.closed) console.log(`    cerrado: [${c.status}] ${c.title.slice(0, 62)}`)
      for (const a of g.open) console.log(`    QUEDA COMO ESTA: ${a.title.slice(0, 62)}`)
    }
  }

  if (outOfScope.length > 0) {
    console.log(
      `\n${outOfScope.length} nota(s) con pendientes abiertos quedan fuera por --solo-qr.`
    )
  }

  if (!APPLY) {
    console.log('\nPara borrar de verdad: agregá --apply')
    return
  }

  if (toDelete.length === 0) {
    console.log('\nNada para borrar.')
    return
  }

  // De a uno y no un `in` gigante: si una falla, se sabe cuál y las demás siguen.
  let deleted = 0
  for (const f of toDelete) {
    const { error: errorDelete } = await supabase.from('tasks').delete().eq('id', f.id)
    if (errorDelete) {
      console.warn(`  no se pudo borrar ${f.id}: ${errorDelete.message}`)
      continue
    }
    deleted++
  }

  console.log(`\nBorradas ${deleted}/${toDelete.length}.`)
  console.log('Ahora: npx tsx scripts/detect-tasks.ts --provider <agy|claude> --apply')
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
