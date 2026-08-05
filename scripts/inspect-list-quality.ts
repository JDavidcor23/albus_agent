/**
 * ¿La lista de pendientes se puede ACCIONAR, o solo leer?
 *
 *   npx tsx scripts/inspect-list-quality.ts
 *
 * Solo lectura. Mide tres cosas que hacen que una lista de 20 items se deje de
 * leer a la semana: subtítulos que repiten el título, textos que se cortan en la
 * tarjeta, y un orden que no tiene nada que ver con la urgencia.
 */
import { listTasks } from '../src/main/supabase/tasks-repo'

function alnum(t: string): string {
  return t.replace(/[^0-9a-záéíóúüñ]/gi, '').toLowerCase()
}

/** Solapamiento de palabras del detail que ya están en el título. */
function redundancia(title: string, detail: string): number {
  const pal = (s: string) =>
    new Set(
      s
        .split(/[^0-9a-záéíóúüñ]+/i)
        .map((w) => alnum(w))
        .filter((w) => w.length >= 3)
    )
  const t = pal(title)
  const d = pal(detail)
  if (d.size === 0) return 0
  let comunes = 0
  for (const w of d) if (t.has(w)) comunes++
  return comunes / d.size
}

/** Cuánto entra en el subtítulo de la tarjeta antes de cortarse con "…". */
const LARGO_TARJETA = 46

async function main(): Promise<void> {
  const tasks = await listTasks('open')
  console.log(`${tasks.length} pendientes abiertos\n`)

  let redundantes = 0
  let cortados = 0
  const sinDetail: string[] = []

  console.log('='.repeat(78))
  console.log('SUBTITULO vs TITULO')
  console.log('='.repeat(78))

  for (const t of tasks) {
    if (t.detail === null || t.detail.length === 0) {
      sinDetail.push(t.title)
      continue
    }

    const r = redundancia(t.title, t.detail)
    const corta = t.detail.length > LARGO_TARJETA

    if (r >= 0.6) redundantes++
    if (corta) cortados++

    const marca = r >= 0.6 ? 'REDUNDANTE' : r >= 0.3 ? 'parcial   ' : 'aporta    '
    console.log(`\n  ${marca} (${(r * 100).toFixed(0)}% repetido)${corta ? '  + SE CORTA' : ''}`)
    console.log(`    título : ${t.title}`)
    console.log(`    detail : ${t.detail}`)
  }

  if (sinDetail.length > 0) {
    console.log(`\n  ${sinDetail.length} sin subtítulo (bien: el título alcanza)`)
  }

  console.log(`\n${'='.repeat(78)}`)
  console.log('ORDEN DE LA LISTA (tal como la ve el usuario)')
  console.log('='.repeat(78))
  for (const [i, t] of tasks.entries()) {
    console.log(
      `  ${String(i + 1).padStart(2)}. conf ${t.confidence.toFixed(2)}  ${t.title.slice(0, 62)}`
    )
  }

  console.log(`\n${'='.repeat(78)}`)
  console.log('RESUMEN')
  console.log('='.repeat(78))
  console.log(`  subtítulos que repiten el título : ${redundantes}/${tasks.length - sinDetail.length}`)
  console.log(`  subtítulos que se cortan          : ${cortados}/${tasks.length - sinDetail.length}`)
  console.log(`  valores distintos de confidence   : ${new Set(tasks.map((t) => t.confidence)).size}`)
  console.log('\n  El orden es por confidence descendente. Confidence mide cuán SEGURO')
  console.log('  estaba el modelo, no cuán urgente es la tarea.')
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
