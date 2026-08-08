/**
 * Manda a la papelera SOLO los archivos que subio Albus.
 *
 *   npx tsx scripts/drive-purge-albus.ts            (dry-run)
 *   npx tsx scripts/drive-purge-albus.ts --apply
 *
 * El filtro es la presencia de la appProperty `albusKey`, que SOLO tienen los
 * archivos creados por el archivado. Un archivo que subiste vos a mano no la
 * tiene, asi que nunca entra.
 *
 * Se filtra en memoria y no en la query porque el operador `has` de Drive exige
 * clave Y valor: `appProperties has { key='albusKey' }` a secas devuelve
 * 400 Invalid Value. Por eso se listan las carpetas destino y se mira cada fila.
 *
 * Sirve para reprocesar desde cero: como la idempotencia reusa por albusKey,
 * sin purgar primero un re-run conserva los archivos (y los nombres) viejos.
 */
import { listAll, trashFile, FOLDER_MIME, type DriveFile } from './lib/drive'

const APPLY = process.argv.includes('--apply')
const TARGETS = ['pagos', 'qr-eventos', 'contactos', 'info', 'sin-clasificar']

async function main(): Promise<void> {
  console.log(APPLY ? 'MODO APPLY\n' : 'MODO DRY-RUN — no se toca nada\n')

  const folders = (
    await listAll(`mimeType = '${FOLDER_MIME}' and trashed = false and 'root' in parents`)
  ).filter((c) => TARGETS.includes(c.name))

  const mine: DriveFile[] = []
  for (const c of folders) {
    const children = await listAll(`'${c.id}' in parents and trashed = false`)
    for (const h of children) {
      if (h.appProperties?.albusKey) mine.push(h)
      else console.log(`  (intacto, no es de Albus)  ${c.name}/${h.name}`)
    }
  }

  if (mine.length === 0) {
    console.log('No hay archivos de Albus en Drive.')
    return
  }

  console.log(`Archivos subidos por Albus: ${mine.length}\n`)
  for (const f of mine.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${APPLY ? 'papelera' : 'iria a papelera'}  ${f.name}`)
    if (APPLY) await trashFile(f.id)
  }

  console.log(
    APPLY
      ? `\n${mine.length} archivos a la papelera (recuperables 30 dias).`
      : '\nPara aplicar: npx tsx scripts/drive-purge-albus.ts --apply'
  )
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
