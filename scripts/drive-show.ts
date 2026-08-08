/**
 * Muestra el contenido de las carpetas destino de Albus.
 *
 *   npx tsx scripts/drive-show.ts
 *
 * Solo lectura. Sirve para comprobar contra Drive lo que un batch dice haber
 * archivado, sin creerle al reporte del propio batch.
 */
import { listAll, FOLDER_MIME } from './lib/drive'

const TARGETS = ['pagos', 'qr-eventos', 'contactos', 'info', 'sin-clasificar']

async function main(): Promise<void> {
  const folders = await listAll(
    `mimeType = '${FOLDER_MIME}' and trashed = false and 'root' in parents`
  )

  for (const name of TARGETS) {
    const folder = folders.find((c) => c.name === name)
    if (!folder) {
      console.log(`\n${name}/  NO EXISTE`)
      continue
    }

    const children = await listAll(`'${folder.id}' in parents and trashed = false`)
    console.log(`\n${name}/  (${children.length})`)

    for (const h of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const kb = h.size ? `${Math.round(Number(h.size) / 1024)} KB` : ''
      console.log(`   ${h.name.padEnd(58)} ${kb}`)
    }
  }
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
