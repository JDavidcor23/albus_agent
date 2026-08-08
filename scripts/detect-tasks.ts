/**
 * Detecta pendientes en las notas y los guarda en `tasks`.
 *
 *   npx tsx scripts/detect-tasks.ts --dry-run          (no escribe, solo muestra)
 *   npx tsx scripts/detect-tasks.ts --provider agy
 *   npx tsx scripts/detect-tasks.ts --provider agy --model gemini-3-pro
 *
 * GASTA CUOTA: una llamada al CLI por nota sin analizar. Por eso el default es
 * dry-run y hay que elegir el proveedor a mano.
 */
import { detectProviders, getProvider } from '../src/main/providers/registry'
import { detectTasks } from '../src/main/core/tasks/detect'
import { deterministicTasks, deterministicTitles } from '../src/main/core/tasks/rules'
import {
  listTaskCandidates,
  saveTasks,
  markAnalyzedWithNoTasks,
  listTasks
} from '../src/main/supabase/tasks-repo'
import { saveNoteSummary } from '../src/main/supabase/note-summary-repo'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')

function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
}

async function main(): Promise<void> {
  const providerId = flag('provider')
  const model = flag('model')

  if (providerId === null) {
    const available = await detectProviders(false)
    console.log('Falta --provider. Disponibles:\n')
    for (const p of available) console.log(`  ${p.id}  ${p.name}`)
    console.log('\nEjemplo: npx tsx scripts/detect-tasks.ts --provider agy --dry-run')
    return
  }

  const provider = getProvider(providerId)
  if (provider === null) throw new Error(`proveedor desconocido: ${providerId}`)

  const candidates = await listTaskCandidates(500)
  console.log(
    `${APPLY ? 'MODO APPLY' : 'MODO DRY-RUN — no se escribe nada'}\n` +
      `Notas sin analizar: ${candidates.length}` +
      `${candidates.length ? `  (${candidates.length} llamadas al CLI)` : ''}\n`
  )
  if (candidates.length === 0) {
    console.log('Nada para analizar. Para re-analizar hay que borrar filas de `tasks`.')
    return
  }

  // La fecha entra por parámetro: hace falta para descartar eventos ya pasados.
  const today = new Date().toISOString().slice(0, 10)
  const source = `cli:${provider.id}${model !== null ? `/${model}` : ''}`

  let withTasks = 0
  let totalTasks = 0
  let summaries = 0

  // Secuencial a propósito: son CLIs locales, en paralelo se pisan.
  for (const [i, c] of candidates.entries()) {
    // Primero las reglas: son gratis y no dependen de que el CLI esté vivo.
    const byRule = deterministicTasks(c)
    const alreadyCovered = deterministicTitles(byRule)

    const { tasks, summary } = await detectTasks(provider, model, c, today)
    const byModel = tasks.filter((t) => !alreadyCovered.has(t.title.toLowerCase()))

    const detected = [...byRule, ...byModel]
    const label = c.body.replace(/\s+/g, ' ').slice(0, 46).padEnd(46)

    // El resumen se guarda incluso cuando no hay ningún pendiente: la nota se
    // sigue leyendo en el detalle de OTROS pendientes de la misma nota, y la
    // llamada al CLI ya se pagó.
    if (summary !== null) {
      summaries++
      if (APPLY) await saveNoteSummary(c.entryId, summary)
    }

    if (detected.length === 0) {
      console.log(`  ${String(i + 1).padStart(2)}. ${label}  —`)
      if (summary !== null) console.log(`      ~ ${summary}`)
      if (APPLY) await markAnalyzedWithNoTasks(c)
      continue
    }

    withTasks++
    totalTasks += detected.length
    console.log(`  ${String(i + 1).padStart(2)}. ${label}`)
    if (summary !== null) console.log(`      ~ ${summary}`)
    for (const t of byRule) {
      console.log(`      -> [regla] ${t.title}`)
    }
    for (const t of byModel) {
      console.log(`      -> [ia ${t.confidence.toFixed(2)}] ${t.title}`)
    }

    if (APPLY) {
      if (byRule.length > 0) await saveTasks(c, byRule, 'regla:qr')
      if (byModel.length > 0) await saveTasks(c, byModel, source)
    }
  }

  console.log(
    `\nNotas con pendientes: ${withTasks}/${candidates.length} · ` +
      `pendientes detectados: ${totalTasks} · resúmenes: ${summaries}`
  )

  if (APPLY) {
    const openTasks = await listTasks('open')
    console.log(`\nEn la tabla hay ahora ${openTasks.length} pendientes abiertos.`)
  } else {
    console.log('\nPara guardar: agregá --apply')
  }
}

main().catch((error: unknown) => {
  console.error('Falló:', error instanceof Error ? error.message : error)
  process.exit(1)
})
