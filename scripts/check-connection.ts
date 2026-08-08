/**
 * Prueba la conexión con Supabase y cuenta lo que hay pendiente.
 * No procesa nada, no escribe nada, no gasta OCR.
 *
 *   npx tsx scripts/check-connection.ts
 */
import { createItemSource } from '../src/main/supabase/item-source'

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  console.log('SUPABASE_URL                ', url ? 'OK' : 'FALTA')
  console.log('SUPABASE_SERVICE_ROLE_KEY   ', key ? `OK (${key.length} chars)` : 'FALTA')

  if (!url || !key) {
    console.log('\nFalta completar .env. El key va en Project Settings > API Keys, el que dice service_role.')
    process.exit(1)
  }

  const source = createItemSource()
  const pending = await source.listPending(500)

  const byKind = new Map<string, number>()
  for (const item of pending) {
    const kind = item.attachmentPath === '' ? 'texto (body)' : item.mime
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1)
  }

  console.log(`\nConexión OK. ${pending.length} items pendientes:\n`)
  for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${kind}`)
  }

  // Bajamos un solo archivo para confirmar que Storage también responde: que la
  // tabla se lea no garantiza que el bucket esté accesible con esta credencial.
  const firstAttachment = pending.find((i) => i.attachmentPath !== '')
  if (firstAttachment) {
    const bytes = await source.downloadAttachment(firstAttachment.attachmentPath)
    console.log(`\nStorage OK. Bajé 1 archivo de prueba: ${bytes.byteLength} bytes.`)
  } else {
    console.log('\nNo hay adjuntos pendientes que probar contra Storage.')
  }
}

main().catch((error: unknown) => {
  console.error('\nFalló:', error instanceof Error ? error.message : error)
  process.exit(1)
})
