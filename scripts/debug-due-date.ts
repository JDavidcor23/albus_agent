/**
 * Qué texto le hizo creer al parser que había una fecha.
 *
 *   npx tsx scripts/debug-due-date.ts <prefijo-de-entry>
 *
 * Solo lectura. Una fecha falsa es peor que ninguna: manda la tarea al tope de la
 * lista y tapa las reales. Cuando el parser inventa una, hay que ver qué línea la
 * produjo — no adivinar el regex culpable.
 */
import { getSupabaseClient } from '../src/main/supabase/client'
import { fechaLimiteDe } from '../src/main/core/tasks/due-date'

async function main(): Promise<void> {
  const prefijo = process.argv[2] ?? ''
  const hoy = new Date().toISOString().slice(0, 10)
  const supabase = getSupabaseClient()

  const { data, error } = await supabase
    .from('entries')
    .select('id, body, extractions ( attachment_path, kind, payload )')

  if (error) throw new Error(error.message)

  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const id = String(row.id)
    if (prefijo.length > 0 && !id.startsWith(prefijo)) continue

    const body = String(row.body ?? '')
    const ex = (row.extractions ?? []) as { attachment_path: string; payload: unknown }[]

    console.log('='.repeat(74))
    console.log(`entry ${id.slice(0, 8)}`)
    console.log('='.repeat(74))

    const fuentes: { etiqueta: string; texto: string }[] = [{ etiqueta: 'body', texto: body }]
    for (const e of ex) {
      const p = (e.payload ?? {}) as Record<string, unknown>
      if (typeof p.text === 'string' && p.text.trim().length > 0) {
        fuentes.push({ etiqueta: e.attachment_path.slice(-28) || 'body-row', texto: p.text })
      }
    }

    for (const f of fuentes) {
      // Línea por línea: así se ve EXACTAMENTE cuál produjo la fecha.
      for (const linea of f.texto.split(/\r?\n/)) {
        const limpia = linea.trim()
        if (limpia.length === 0) continue
        const fecha = fechaLimiteDe(limpia, hoy)
        if (fecha !== null) {
          console.log(`  ${fecha}  <=  [${f.etiqueta}]  "${limpia}"`)
        }
      }
    }

    const todo = fuentes.map((f) => f.texto).join('\n')
    console.log(`\n  GANA: ${fechaLimiteDe(todo, hoy) ?? 'sin fecha'}`)
    console.log()
  }
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
