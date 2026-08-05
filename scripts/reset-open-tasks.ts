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
const SOLO_QR = args.includes('--solo-qr')

interface Fila {
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
  const todas = (data ?? []) as Fila[]

  // Qué entries tienen QR, si hay que filtrar por eso.
  let entriesConQr: Set<string> | null = null
  if (SOLO_QR) {
    const { data: qr, error: e2 } = await supabase
      .from('extractions')
      .select('entry_id')
      .eq('kind', 'qr')
    if (e2) throw new Error(e2.message)
    entriesConQr = new Set(((qr ?? []) as { entry_id: string }[]).map((r) => r.entry_id))
  }

  const porEntry = new Map<string, Fila[]>()
  for (const t of todas) porEntry.set(t.entry_id, [...(porEntry.get(t.entry_id) ?? []), t])

  const aBorrar: Fila[] = []
  const intocables: { entry: string; cerrados: Fila[]; abiertos: Fila[] }[] = []
  const fueraDeAlcance: string[] = []

  for (const [entry, filas] of porEntry) {
    if (entriesConQr !== null && !entriesConQr.has(entry)) {
      if (filas.some((f) => f.status === 'open' && f.source !== 'centinela')) {
        fueraDeAlcance.push(entry)
      }
      continue
    }

    const cerrados = filas.filter((f) => f.status !== 'open' && f.source !== 'centinela')
    const abiertos = filas.filter((f) => f.status === 'open')

    if (cerrados.length > 0) {
      if (abiertos.length > 0) intocables.push({ entry, cerrados, abiertos })
      continue
    }

    // Sin cerrados: se puede limpiar la entry entera, centinelas incluidos, para
    // que `listTaskCandidates` la vuelva a ver.
    aBorrar.push(...filas)
  }

  console.log(APPLY ? 'MODO APPLY — se borra' : 'MODO DRY-RUN — no se borra nada')
  console.log(SOLO_QR ? 'Alcance: solo notas con al menos un QR\n' : 'Alcance: todas las notas\n')

  console.log('='.repeat(74))
  console.log(`SE BORRAN ${aBorrar.length} fila(s), de ${new Set(aBorrar.map((f) => f.entry_id)).size} nota(s)`)
  console.log('='.repeat(74))
  for (const f of aBorrar) {
    const etiqueta = f.source === 'centinela' ? '[centinela]' : `[${f.status}]`
    console.log(`  ${f.entry_id.slice(0, 8)} ${etiqueta} ${f.title.slice(0, 70)}`)
  }

  if (intocables.length > 0) {
    console.log(`\n${'='.repeat(74)}`)
    console.log(`NO SE TOCAN — ${intocables.length} nota(s) con pendientes ya cerrados`)
    console.log('='.repeat(74))
    console.log('Borrarles los abiertos los perderia sin poder re-derivarlos,')
    console.log('porque la nota ya no vuelve a entrar al analisis.\n')
    for (const g of intocables) {
      console.log(`  nota ${g.entry.slice(0, 8)}`)
      for (const c of g.cerrados) console.log(`    cerrado: [${c.status}] ${c.title.slice(0, 62)}`)
      for (const a of g.abiertos) console.log(`    QUEDA COMO ESTA: ${a.title.slice(0, 62)}`)
    }
  }

  if (fueraDeAlcance.length > 0) {
    console.log(
      `\n${fueraDeAlcance.length} nota(s) con pendientes abiertos quedan fuera por --solo-qr.`
    )
  }

  if (!APPLY) {
    console.log('\nPara borrar de verdad: agregá --apply')
    return
  }

  if (aBorrar.length === 0) {
    console.log('\nNada para borrar.')
    return
  }

  // De a uno y no un `in` gigante: si una falla, se sabe cuál y las demás siguen.
  let borradas = 0
  for (const f of aBorrar) {
    const { error: errorDelete } = await supabase.from('tasks').delete().eq('id', f.id)
    if (errorDelete) {
      console.warn(`  no se pudo borrar ${f.id}: ${errorDelete.message}`)
      continue
    }
    borradas++
  }

  console.log(`\nBorradas ${borradas}/${aBorrar.length}.`)
  console.log('Ahora: npx tsx scripts/detect-tasks.ts --provider <agy|claude> --apply')
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
