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
import { isOpenableUrl } from '../src/shared/ipc'
import { calendarUrl } from '../src/shared/google-calendar'

async function main(): Promise<void> {
  const tasks = await listTasks('open')
  let failures = 0

  for (const t of tasks) {
    const url = calendarUrl({ title: t.title, details: t.detail, date: t.dueDate })
    const ok = isOpenableUrl(url)
    if (!ok) failures++

    const params = new URL(url).searchParams
    const dates = params.get('dates')
    console.log(
      `  ${ok ? 'OK  ' : 'FALLA'}  ${dates !== null ? dates : '  sin fecha       '}  ` +
        `${params.get('text')?.slice(0, 52)}`
    )
    if (!ok) console.log(`         ${url}`)
  }

  console.log(`\n${tasks.length - failures}/${tasks.length} pasan el allowlist.`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
