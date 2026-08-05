/**
 * Muestra el detalle de un pendiente tal como lo va a recibir la UI.
 *
 *   npx tsx scripts/inspect-task-detail.ts               (el primero que haya)
 *   npx tsx scripts/inspect-task-detail.ts postularme    (el primero que matchee)
 *
 * Solo lectura. Sirve para saber si el detalle ALCANZA para actuar, o si el dato
 * simplemente no está en lo capturado — que es una respuesta distinta de "el
 * detalle no funciona".
 */
import { getTaskDetail, listTasks } from '../src/main/supabase/tasks-repo'

const RE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/g
const RE_URL = /https?:\/\/[^\s<>"')\]]+/g

async function main(): Promise<void> {
  const filtro = (process.argv[2] ?? '').toLowerCase()
  const abiertos = await listTasks('open')

  const elegido =
    filtro.length > 0
      ? abiertos.find((t) => t.title.toLowerCase().includes(filtro))
      : abiertos[0]

  if (elegido === undefined) {
    console.log(
      filtro ? `Ningún pendiente abierto matchea "${filtro}".` : 'No hay pendientes abiertos.'
    )
    return
  }

  const d = await getTaskDetail(elegido.id)
  if (d === null) {
    console.log('El pendiente ya no existe.')
    return
  }

  console.log('='.repeat(72))
  console.log(d.task.title)
  console.log(`origen: ${d.task.source} · confianza ${d.task.confidence}`)
  console.log('='.repeat(72))

  console.log(`\n--- lo que escribiste ---\n${d.noteBody || '(nada)'}`)

  const todoElTexto = d.sources.map((s) => s.text ?? '').join('\n')
  const emails = [...new Set(todoElTexto.match(RE_EMAIL) ?? [])]
  const urls = [...new Set(todoElTexto.match(RE_URL) ?? [])]

  console.log(`\n--- cómo contactar (lo que la UI va a resaltar) ---`)
  if (emails.length === 0 && urls.length === 0) {
    console.log('  NADA. La captura no traía email ni link.')
    console.log('  Ninguna interfaz puede inventar esto: hay que abrir la imagen original.')
  } else {
    for (const e of emails) console.log(`  email: ${e}`)
    for (const u of urls) console.log(`  link : ${u}`)
  }

  console.log(`\n--- capturas (${d.sources.length}) ---`)
  for (const [i, s] of d.sources.entries()) {
    console.log(`\n  [${i + 1}] ${s.kind}${s.driveFolder ? ` · drive/${s.driveFolder}` : ''}`)
    console.log(`      abrir original: ${s.driveLink ?? 'NO HAY LINK'}`)
    const texto = (s.text ?? '').trim()
    console.log(
      texto.length > 0
        ? `      texto (${texto.length} chars):\n${texto
            .split('\n')
            .slice(0, 14)
            .map((l) => `        ${l}`)
            .join('\n')}`
        : '      (sin texto)'
    )
  }
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
