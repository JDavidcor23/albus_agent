/**
 * ¿La URL de Calendar pasa el allowlist del main?
 *
 *   npx tsx scripts/verify-calendar.ts
 *
 * Solo lectura, sin red. Si el host no está en la allowlist, el botón abre un
 * error en vez del calendario — y el fallo aparece recién al clickear. Esto lo
 * atrapa antes, con los títulos REALES de la base, que son los que traen
 * acentos, "&" y todo lo que rompe una URL armada a mano.
 */
import { listTasks } from '../src/main/supabase/tasks-repo'
import { esUrlAbrible } from '../src/shared/ipc'
import { urlDeCalendario } from '../src/shared/google-calendar'

async function main(): Promise<void> {
  const tasks = await listTasks('open')
  let fallas = 0

  for (const t of tasks) {
    const url = urlDeCalendario({ title: t.title, details: t.detail })
    const ok = esUrlAbrible(url)
    if (!ok) fallas++

    const params = new URL(url).searchParams
    console.log(`  ${ok ? 'OK  ' : 'FALLA'}  ${params.get('text')?.slice(0, 58)}`)
    if (!ok) console.log(`         ${url}`)
  }

  console.log(`\n${tasks.length - fallas}/${tasks.length} pasan el allowlist.`)
  if (fallas > 0) process.exit(1)
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
