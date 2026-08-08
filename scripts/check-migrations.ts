/**
 * ¿Están aplicadas las migraciones que el código de hoy necesita?
 *
 *   npx tsx scripts/check-migrations.ts
 *
 * Solo lectura. Acá las migraciones se aplican A MANO en el SQL Editor, así que
 * el código puede adelantarse al esquema sin que nada avise — y el síntoma
 * aparece recién al escribir, en medio de un lote que ya gastó cuota.
 */
import { getSupabaseClient } from '../src/main/supabase/client'

interface MigrationCheck {
  migration: string
  description: string
  table: string
  column: string
}

const CHECKS: MigrationCheck[] = [
  {
    migration: '0003_task_dedupe_key.sql',
    description: 'identidad de un pendiente, para no duplicarlo entre notas',
    table: 'tasks',
    column: 'dedupe_key'
  }
]

async function main(): Promise<void> {
  const supabase = getSupabaseClient()
  let missing = 0

  for (const c of CHECKS) {
    const { error } = await supabase.from(c.table).select(c.column).limit(1)

    if (error === null) {
      console.log(`  OK      ${c.migration}`)
      continue
    }

    missing++
    console.log(`  FALTA   ${c.migration}`)
    console.log(`          ${c.description}`)
    console.log(`          ${c.table}.${c.column} no existe todavía`)
  }

  if (missing > 0) {
    console.log(
      `\n${missing} migración(es) sin aplicar. Copiá el archivo al SQL Editor de Supabase\n` +
        'y corrélo antes de escribir nada. Si no, el lote falla a mitad de camino\n' +
        'después de haber gastado cuota.'
    )
    process.exit(1)
  }

  console.log('\nEl esquema está al día.')
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
