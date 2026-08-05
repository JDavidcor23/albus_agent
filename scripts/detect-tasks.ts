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
import { deterministicTasks, titulosDeterministas } from '../src/main/core/tasks/rules'
import {
  listTaskCandidates,
  saveTasks,
  markAnalyzedWithNoTasks,
  listTasks
} from '../src/main/supabase/tasks-repo'
import { saveNoteSummary } from '../src/main/supabase/note-summary-repo'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')

function flag(nombre: string): string | null {
  const i = args.indexOf(`--${nombre}`)
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
}

async function main(): Promise<void> {
  const providerId = flag('provider')
  const model = flag('model')

  if (providerId === null) {
    const disponibles = await detectProviders(false)
    console.log('Falta --provider. Disponibles:\n')
    for (const p of disponibles) console.log(`  ${p.id}  ${p.name}`)
    console.log('\nEjemplo: npx tsx scripts/detect-tasks.ts --provider agy --dry-run')
    return
  }

  const provider = getProvider(providerId)
  if (provider === null) throw new Error(`proveedor desconocido: ${providerId}`)

  const candidatos = await listTaskCandidates(500)
  console.log(
    `${APPLY ? 'MODO APPLY' : 'MODO DRY-RUN — no se escribe nada'}\n` +
      `Notas sin analizar: ${candidatos.length}` +
      `${candidatos.length ? `  (${candidatos.length} llamadas al CLI)` : ''}\n`
  )
  if (candidatos.length === 0) {
    console.log('Nada para analizar. Para re-analizar hay que borrar filas de `tasks`.')
    return
  }

  // La fecha entra por parámetro: hace falta para descartar eventos ya pasados.
  const hoy = new Date().toISOString().slice(0, 10)
  const source = `cli:${provider.id}${model !== null ? `/${model}` : ''}`

  let conPendientes = 0
  let totalTasks = 0
  let resumenes = 0

  // Secuencial a propósito: son CLIs locales, en paralelo se pisan.
  for (const [i, c] of candidatos.entries()) {
    // Primero las reglas: son gratis y no dependen de que el CLI esté vivo.
    const porRegla = deterministicTasks(c)
    const yaCubiertos = titulosDeterministas(porRegla)

    const { tasks, summary } = await detectTasks(provider, model, c, hoy)
    const porModelo = tasks.filter((t) => !yaCubiertos.has(t.title.toLowerCase()))

    const detectados = [...porRegla, ...porModelo]
    const etiqueta = c.body.replace(/\s+/g, ' ').slice(0, 46).padEnd(46)

    // El resumen se guarda incluso cuando no hay ningún pendiente: la nota se
    // sigue leyendo en el detalle de OTROS pendientes de la misma nota, y la
    // llamada al CLI ya se pagó.
    if (summary !== null) {
      resumenes++
      if (APPLY) await saveNoteSummary(c.entryId, summary)
    }

    if (detectados.length === 0) {
      console.log(`  ${String(i + 1).padStart(2)}. ${etiqueta}  —`)
      if (summary !== null) console.log(`      ~ ${summary}`)
      if (APPLY) await markAnalyzedWithNoTasks(c)
      continue
    }

    conPendientes++
    totalTasks += detectados.length
    console.log(`  ${String(i + 1).padStart(2)}. ${etiqueta}`)
    if (summary !== null) console.log(`      ~ ${summary}`)
    for (const t of porRegla) {
      console.log(`      -> [regla] ${t.title}`)
    }
    for (const t of porModelo) {
      console.log(`      -> [ia ${t.confidence.toFixed(2)}] ${t.title}`)
    }

    if (APPLY) {
      if (porRegla.length > 0) await saveTasks(c, porRegla, 'regla:qr')
      if (porModelo.length > 0) await saveTasks(c, porModelo, source)
    }
  }

  console.log(
    `\nNotas con pendientes: ${conPendientes}/${candidatos.length} · ` +
      `pendientes detectados: ${totalTasks} · resúmenes: ${resumenes}`
  )

  if (APPLY) {
    const abiertos = await listTasks('open')
    console.log(`\nEn la tabla hay ahora ${abiertos.length} pendientes abiertos.`)
  } else {
    console.log('\nPara guardar: agregá --apply')
  }
}

main().catch((error: unknown) => {
  console.error('Falló:', error instanceof Error ? error.message : error)
  process.exit(1)
})
