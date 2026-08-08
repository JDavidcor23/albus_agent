/**
 * Corre la cascada sobre los items pendientes de verdad y escribe en Supabase.
 *
 *   npx tsx scripts/run-batch.ts [limite]
 *   npx tsx scripts/run-batch.ts --reset    borra lo extraido y reprocesa todo
 *
 * El reset es reversible: reprocesar regenera las filas. Lo que NO se deshace
 * solo es lo que ya se haya subido a Drive — pero eso es idempotente por
 * appProperties, asi que re-subir reusa el archivo en vez de duplicarlo.
 */
import { createItemSource } from '../src/main/supabase/item-source'
import { createResultSink } from '../src/main/supabase/result-sink'
import { processBatch } from '../src/main/core/extraction/worker'
import { terminateOcr } from '../src/main/core/extraction/ocr'
import { createDriveArchive } from '../src/main/drive/archive'
import { isDriveConfigured } from '../src/main/drive/client'
import { clearResults, clearUnarchived } from '../src/main/supabase/results-repo'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const reset = args.includes('--reset')
  // Reset quirurgico: solo lo que NO tiene copia en Drive. Es el que hay que usar
  // despues de storage-prune, porque los archivados ya no estan en Storage y
  // reprocesarlos los degradaria a `failed`.
  const resetUnarchived = args.includes('--reset-sin-archivar')
  const limit = Number(args.find((a) => !a.startsWith('--')) ?? 500)
  const start = Date.now()

  if (reset) {
    const deleted = await clearResults()
    console.log(`Reset TOTAL: ${deleted} filas borradas de extractions\n`)
  } else if (resetUnarchived) {
    const deleted = await clearUnarchived()
    console.log(`Reset de no-archivados: ${deleted} filas borradas de extractions\n`)
  }

  const withDrive = isDriveConfigured()
  console.log(withDrive ? 'Drive: configurado, se archivan imagenes' : 'Drive: SIN configurar')

  const report = await processBatch(
    createItemSource(),
    createResultSink(),
    limit,
    {
      onItemDone: (item, result, index, total) => {
        const where =
          typeof result.payload.drive === 'object' && result.payload.drive !== null
            ? ` -> drive/${(result.payload.drive as { folder?: string }).folder}`
            : ''
        console.log(
          `  ${index + 1}/${total}  ${result.kind.padEnd(8)} ${item.attachmentPath || 'body'}${where}`
        )
      }
    },
    undefined, // sin escalon de IA: no gasta cuota del usuario
    withDrive ? createDriveArchive() : undefined
  )

  const seconds = Math.round((Date.now() - start) / 1000)

  console.log(
    `\nprocesados ${report.processed} · fallidos ${report.failed} · ` +
      `archivados en Drive ${report.archived} · ${seconds}s\n`
  )
  for (const [kind, n] of Object.entries(report.byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${kind}`)
  }

  await terminateOcr()
}

main().catch((error: unknown) => {
  console.error('Falló:', error instanceof Error ? error.message : error)
  process.exit(1)
})
