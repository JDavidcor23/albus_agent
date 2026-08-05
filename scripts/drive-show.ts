/**
 * Muestra el contenido de las carpetas destino de Albus.
 *
 *   npx tsx scripts/drive-show.ts
 *
 * Solo lectura. Sirve para comprobar contra Drive lo que un batch dice haber
 * archivado, sin creerle al reporte del propio batch.
 */
import { listAll, FOLDER_MIME } from './lib/drive'

const DESTINOS = ['pagos', 'qr-eventos', 'contactos', 'info', 'sin-clasificar']

async function main(): Promise<void> {
  const carpetas = await listAll(
    `mimeType = '${FOLDER_MIME}' and trashed = false and 'root' in parents`
  )

  for (const nombre of DESTINOS) {
    const carpeta = carpetas.find((c) => c.name === nombre)
    if (!carpeta) {
      console.log(`\n${nombre}/  NO EXISTE`)
      continue
    }

    const hijos = await listAll(`'${carpeta.id}' in parents and trashed = false`)
    console.log(`\n${nombre}/  (${hijos.length})`)

    for (const h of hijos.sort((a, b) => a.name.localeCompare(b.name))) {
      const kb = h.size ? `${Math.round(Number(h.size) / 1024)} KB` : ''
      console.log(`   ${h.name.padEnd(58)} ${kb}`)
    }
  }
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
