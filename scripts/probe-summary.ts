/**
 * Prueba detectTasks sobre UNA nota real, sin escribir nada.
 *
 *   npx tsx scripts/probe-summary.ts --provider agy
 *   npx tsx scripts/probe-summary.ts --provider agy --entry 4941fb4f
 *
 * Para qué: `detect-tasks` no puede probarse en seco después de un reset, porque
 * `listTaskCandidates` saltea las notas que ya tienen pendientes — o sea que para
 * ver si el modelo anda hay que haber borrado primero. Este script rompe ese
 * huevo-gallina: arma el candidato a mano y no toca la base.
 *
 * Sin esto, la única forma de descubrir que el CLI está caído es borrarle al
 * usuario los 17 pendientes y quedarse sin nada con qué reemplazarlos.
 */
import { getSupabaseClient } from '../src/main/supabase/client'
import { getProvider } from '../src/main/providers/registry'
import { detectTasks } from '../src/main/core/tasks/detect'
import { deterministicTasks } from '../src/main/core/tasks/rules'
import type { TaskCandidate } from '../src/main/core/tasks/types'

const args = process.argv.slice(2)

function flag(nombre: string): string | null {
  const i = args.indexOf(`--${nombre}`)
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
}

async function main(): Promise<void> {
  const providerId = flag('provider')
  if (providerId === null) throw new Error('falta --provider (agy | claude-code)')

  const provider = getProvider(providerId)
  if (provider === null) throw new Error(`proveedor desconocido: ${providerId}`)

  const model = flag('model')
  const prefijo = flag('entry')

  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('entries')
    .select('id, user_id, body, extractions ( kind, payload )')
    .not('body', 'is', null)

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
    .filter((c) => c.body.length > 0)

  // Sin --entry, la más larga: es la que más necesita el resumen.
  const elegido =
    prefijo !== null
      ? candidatos.find((c) => c.entryId.startsWith(prefijo))
      : candidatos.sort((a, b) => b.body.length - a.body.length)[0]

  if (elegido === undefined) throw new Error('no encontré esa nota')

  const hoy = new Date().toISOString().slice(0, 10)

  console.log('='.repeat(74))
  console.log(`nota ${elegido.entryId.slice(0, 8)} · ${elegido.body.length} chars · ` +
    `${elegido.attachments.length} adjunto(s)`)
  console.log(`proveedor ${provider.id}${model !== null ? ` / ${model}` : ''}`)
  console.log('='.repeat(74))

  console.log('\n--- REGLAS (gratis, sin modelo) ---')
  const porRegla = deterministicTasks(elegido)
  if (porRegla.length === 0) console.log('  (ninguna aplica)')
  for (const t of porRegla) console.log(`  • ${t.title}`)

  console.log('\n--- MODELO ---')
  const t0 = Date.now()
  const { tasks, summary } = await detectTasks(provider, model, elegido, hoy)
  const ms = Date.now() - t0

  console.log(`  respondió en ${(ms / 1000).toFixed(1)}s\n`)
  console.log(`  RESUMEN: ${summary ?? '(NINGUNO — el modelo no lo devolvió o se descartó)'}`)
  console.log(`\n  PENDIENTES (${tasks.length}):`)
  for (const t of tasks) {
    console.log(`  • [${t.confidence.toFixed(2)}] ${t.title}`)
    if (t.detail !== null) console.log(`      ${t.detail}`)
  }

  const ok = summary !== null || tasks.length > 0
  console.log(
    `\n${ok ? 'OK: el CLI responde y el JSON parsea.' : 'FALLÓ: no vino nada usable.'}`
  )
  if (!ok) process.exit(1)
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
