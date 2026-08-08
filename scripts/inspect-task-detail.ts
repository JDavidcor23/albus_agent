/**
 * Muestra el detalle de un pendiente tal como lo va a recibir la UI.
 *
 *   npx tsx scripts/inspect-task-detail.ts               (el primero que haya)
 *   npx tsx scripts/inspect-task-detail.ts postularme    (el primero que matchee)
 *   npx tsx scripts/inspect-task-detail.ts --todos       (todos los abiertos)
 *
 * Solo lectura. Sirve para saber si el detalle ALCANZA para actuar, o si el dato
 * simplemente no está en lo capturado — que es una respuesta distinta de "el
 * detalle no funciona".
 */
import { getTaskDetail, listTasks } from '../src/main/supabase/tasks-repo'
import { isOpenableUrl } from '../src/shared/ipc'

const SOURCE_NAME: Record<string, string> = {
  qr: 'código QR',
  receipt: 'comprobante',
  profile: 'perfil',
  document: 'documento',
  text: 'captura',
  none: 'sin contenido',
  failed: 'falló'
}

async function show(id: string): Promise<void> {
  const d = await getTaskDetail(id)
  if (d === null) {
    console.log('El pendiente ya no existe.')
    return
  }

  console.log('='.repeat(74))
  console.log(d.task.title)
  console.log(`origen: ${d.task.source} · confianza ${d.task.confidence}`)
  if (d.task.detail !== null) console.log(`detail: ${d.task.detail}`)
  console.log('='.repeat(74))

  console.log('\n--- lo que escribiste ---')
  if (d.noteSummary !== null) {
    console.log(`  RESUMEN: ${d.noteSummary}`)
    console.log(`  (original de ${d.noteBody.length} chars, detrás de "ver la nota completa")`)
  } else {
    const short = d.noteBody.length > 320 ? `${d.noteBody.slice(0, 320)}…` : d.noteBody
    console.log(`  ${short || '(nada)'}`)
    if (d.noteBody.length > 320) {
      console.log(`  SIN RESUMEN — se recorta de ${d.noteBody.length} a 320 chars`)
    }
  }

  console.log('\n--- emails y links en las capturas ---')
  if (d.contacts.emails.length === 0 && d.contacts.urls.length === 0) {
    console.log('  NADA. Las capturas no traían email ni link.')
  } else {
    for (const e of d.contacts.emails) console.log(`  email: ${e}`)
    for (const u of d.contacts.urls) {
      console.log(`  link : ${u}  ${isOpenableUrl(u) ? '[botón]' : '[solo texto: host no permitido]'}`)
    }
  }

  console.log(`\n--- capturas: ${d.sources.length} bloque(s) ---`)
  for (const s of d.sources) {
    const name = SOURCE_NAME[s.kind] ?? s.kind
    console.log(`\n  [${name}${s.captures > 1 ? ` · ${s.captures} capturas` : ''}]`)
    console.log(`      links: ${s.driveLinks.length > 0 ? s.driveLinks.length : 'NINGUNO'}`)

    if (s.text === null) {
      console.log('      (sin texto legible — la UI explica por qué)')
      continue
    }
    const lines = s.text.split('\n')
    console.log(`      texto limpio (${s.text.length} chars, ${lines.length} líneas):`)
    for (const l of lines.slice(0, 16)) console.log(`        ${l}`)
    if (lines.length > 16) console.log(`        … y ${lines.length - 16} línea(s) más`)

    if (s.rawText !== null && s.rawText !== s.text) {
      console.log(`      crudo detrás del toggle: ${s.rawText.length} chars`)
    }
  }
  console.log()
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? ''
  const open = await listTasks('open')

  if (arg === '--todos') {
    console.log(`${open.length} pendientes abiertos\n`)
    for (const t of open) await show(t.id)
    return
  }

  const filter = arg.toLowerCase()
  const chosen =
    filter.length > 0 ? open.find((t) => t.title.toLowerCase().includes(filter)) : open[0]

  if (chosen === undefined) {
    console.log(
      filter ? `Ningún pendiente abierto matchea "${filter}".` : 'No hay pendientes abiertos.'
    )
    return
  }

  await show(chosen.id)
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
