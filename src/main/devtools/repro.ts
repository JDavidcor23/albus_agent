/**
 * Reproducción de "JWT issued at future" DENTRO de Electron.
 *
 *   node scripts/run-jobs.mjs supa
 *
 * Por qué acá y no en un script con tsx: con `npx tsx` los mismos endpoints
 * responden 200 seis de seis veces, y con `fetch` crudo ocho de ocho. El error
 * solo apareció en el proceso principal de Electron. La diferencia tiene que
 * estar en el entorno del main, así que la medición va donde pasa.
 *
 * Se loguea el objeto de error ENTERO: `error.message` se queda con el texto y
 * se come el `code`, el `status` y el `hint`, que es justo lo que dice de qué
 * servicio viene.
 */
import { getSupabaseClient } from '../supabase/client'
import { listResults } from '../supabase/results-repo'
import { createItemSource } from '../supabase/item-source'

const ROUNDS = 12

function dump(label: string, error: unknown): void {
  console.log(`      ${label}`)
  if (error !== null && typeof error === 'object') {
    for (const [k, v] of Object.entries(error as Record<string, unknown>)) {
      if (k === 'stack') continue
      console.log(`         ${k}: ${JSON.stringify(v)}`)
    }
  } else {
    console.log(`         ${String(error)}`)
  }
}

async function measure(name: string, fn: () => Promise<unknown>): Promise<number> {
  let failures = 0
  const line: string[] = []

  for (let i = 0; i < ROUNDS; i++) {
    const t0 = Date.now()
    try {
      await fn()
      line.push(`ok${Date.now() - t0}`)
    } catch (error: unknown) {
      failures++
      line.push(`XX${Date.now() - t0}`)
      dump(`intento ${i + 1}:`, error)
    }
  }

  console.log(`  ${failures === 0 ? 'ok   ' : `FALLA ${failures}/${ROUNDS}`}  ${name}`)
  console.log(`         ${line.join(' ')}`)
  return failures
}

export async function reproSupabase(): Promise<boolean> {
  console.log('\n══ REPRO DE SUPABASE DENTRO DE ELECTRON ══')
  console.log(`   hora local: ${new Date().toISOString()}`)
  console.log(`   node: ${process.versions.node} · electron: ${process.versions.electron}`)
  console.log(`   key: ${(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').slice(0, 11)}… (${
    (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').split('.').length
  } partes)\n`)

  let failures = 0

  // El error crudo del cliente, sin que results-repo lo aplaste a un string.
  failures += await measure('select en extractions (crudo, con el objeto de error)', async () => {
    const { error } = await getSupabaseClient()
      .from('extractions')
      .select('entry_id, attachment_path, kind, payload, confidence, created_at')
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) throw error
  })

  failures += await measure('listResults() — el de extraction:list', () => listResults(500))

  failures += await measure('listPending(5) — el de extraction:run', () =>
    createItemSource().listPending(5)
  )

  // En paralelo: en el log real fallaron dos llamadas concurrentes y una sola
  // de las dos. Si el error aparece solo acá, es concurrencia, no reloj.
  console.log('\n  ── seis en paralelo (como el StrictMode de React)')
  const inParallel = await Promise.all(
    Array.from({ length: 6 }, async (_, i) => {
      try {
        await listResults(500)
        return `ok${i}`
      } catch (error: unknown) {
        dump(`paralelo ${i}:`, error)
        return `XX${i}`
      }
    })
  )
  const parallelFailures = inParallel.filter((r) => r.startsWith('XX')).length
  console.log(
    `  ${parallelFailures === 0 ? 'ok   ' : `FALLA ${parallelFailures}/6`}  ${inParallel.join(' ')}`
  )
  failures += parallelFailures

  console.log(`\n${'='.repeat(60)}`)
  console.log(failures === 0 ? 'NO SE REPRODUJO' : `SE REPRODUJO — ${failures} fallas`)
  console.log('='.repeat(60))
  return failures === 0
}
