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

interface Chequeo {
  migracion: string
  descripcion: string
  tabla: string
  columna: string
}

const CHEQUEOS: Chequeo[] = [
  {
    migracion: '0003_task_dedupe_key.sql',
    descripcion: 'identidad de un pendiente, para no duplicarlo entre notas',
    tabla: 'tasks',
    columna: 'dedupe_key'
  },
  {
    migracion: '0004_task_due_date.sql',
    descripcion: 'cuándo hay que actuar — es lo que ordena la lista',
    tabla: 'tasks',
    columna: 'due_date'
  }
]

async function main(): Promise<void> {
  const supabase = getSupabaseClient()
  let faltan = 0

  for (const c of CHEQUEOS) {
    const { error } = await supabase.from(c.tabla).select(c.columna).limit(1)

    if (error === null) {
      console.log(`  OK      ${c.migracion}`)
      continue
    }

    faltan++
    console.log(`  FALTA   ${c.migracion}`)
    console.log(`          ${c.descripcion}`)
    console.log(`          ${c.tabla}.${c.columna} no existe todavía`)
  }

  if (faltan > 0) {
    console.log(
      `\n${faltan} migración(es) sin aplicar. Copiá el archivo al SQL Editor de Supabase\n` +
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
