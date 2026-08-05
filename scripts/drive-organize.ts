/**
 * Prepara el Drive para que Albus tenga donde escribir.
 *
 *   npx tsx scripts/drive-organize.ts --dry-run   (default: no toca nada)
 *   npx tsx scripts/drive-organize.ts --apply
 *
 * Hace DOS cosas y nada mas:
 *   1. Manda `Bills` a la papelera — solo si esta realmente vacia.
 *   2. Crea las carpetas destino que falten, al lado de `pagos`.
 *
 * NO mueve archivos existentes. Reordenar 15 anios de Drive personal es otro
 * proyecto y cada movida es una decision del usuario, no de la app.
 */
import { listAll, createFolder, trashFile, FOLDER_MIME, type DriveFile } from './lib/drive'

const APPLY = process.argv.includes('--apply')

/**
 * Carpetas que Albus necesita. Espejo de `decideArchive()` en
 * src/main/core/extraction/archive.ts — si agregas una alla, agregala aca.
 *
 * Todas reciben archivos de verdad: la politica ya no tira originales, solo
 * decide donde van. Ninguna queda vacia para siempre como paso con `Bills`.
 */
const TARGETS = [
  { name: 'qr-eventos', why: 'entradas y QR de eventos — en la puerta se escanea la imagen' },
  { name: 'contactos', why: 'perfiles y QR de LinkedIn — capturas de gente' },
  { name: 'info', why: 'laminas, capturas de contenido, material de referencia' },
  { name: 'sin-clasificar', why: 'no supimos que era — razon de mas para no borrarlo' }
]

const KEEP = 'pagos'

async function main(): Promise<void> {
  console.log(APPLY ? 'MODO APPLY — se aplican cambios\n' : 'MODO DRY-RUN — no se toca nada\n')

  const all = await listAll('trashed = false')
  const folders = all.filter((f) => f.mimeType === FOLDER_MIME)
  const files = all.filter((f) => f.mimeType !== FOLDER_MIME)

  const rootFolders = new Map<string, DriveFile>()
  const folderIds = new Set(folders.map((f) => f.id))
  for (const f of folders) {
    const parent = f.parents?.[0]
    if (!parent || !folderIds.has(parent)) rootFolders.set(f.name, f)
  }

  // ---- 1. Bills ----------------------------------------------------------
  console.log('='.repeat(64))
  console.log('BILLS')
  console.log('='.repeat(64))

  const bills = folders.filter((f) => f.name.toLowerCase() === 'bills')
  if (!bills.length) {
    console.log('  No existe ninguna carpeta llamada "Bills". Nada que hacer.')
  }

  for (const folder of bills) {
    // Descendencia completa: no alcanza con mirar los hijos directos.
    const descendants = new Set<string>([folder.id])
    let grew = true
    while (grew) {
      grew = false
      for (const f of folders) {
        const p = f.parents?.[0]
        if (p && descendants.has(p) && !descendants.has(f.id)) {
          descendants.add(f.id)
          grew = true
        }
      }
    }

    const contained = files.filter((f) => f.parents?.some((p) => descendants.has(p)))
    const subfolders = folders.filter((f) => f.id !== folder.id && descendants.has(f.id))

    console.log(`  Carpeta   : ${folder.name}  (${folder.id})`)
    console.log(`  Subcarpetas: ${subfolders.map((s) => s.name).join(', ') || 'ninguna'}`)
    console.log(`  Archivos   : ${contained.length}`)

    if (contained.length > 0) {
      console.log('\n  ABORTADO: tiene archivos adentro. No la toco.')
      for (const f of contained.slice(0, 20)) console.log(`    - ${f.name}`)
      continue
    }

    if (APPLY) {
      await trashFile(folder.id)
      console.log('  -> mandada a la papelera (recuperable 30 dias)')
    } else {
      console.log('  -> se mandaria a la papelera')
    }
  }

  // ---- 2. Carpetas destino ----------------------------------------------
  console.log('\n' + '='.repeat(64))
  console.log('CARPETAS DESTINO')
  console.log('='.repeat(64))

  const keep = rootFolders.get(KEEP)
  console.log(
    keep
      ? `  ${KEEP.padEnd(12)} ya existe — Albus escribe aca los comprobantes  (${keep.id})`
      : `  ${KEEP.padEnd(12)} NO EXISTE — revisar, se esperaba encontrarla`
  )

  for (const t of TARGETS) {
    const existing = rootFolders.get(t.name)
    if (existing) {
      console.log(`  ${t.name.padEnd(12)} ya existe  (${existing.id})`)
      continue
    }
    if (APPLY) {
      const created = await createFolder(t.name)
      console.log(`  ${t.name.padEnd(12)} CREADA  (${created.id})`)
    } else {
      console.log(`  ${t.name.padEnd(12)} se crearia`)
    }
    console.log(`  ${''.padEnd(12)}   ${t.why}`)
  }

  console.log('\n' + '='.repeat(64))
  console.log('NO SE MUEVE NINGUN ARCHIVO EXISTENTE.')
  console.log(`Sueltos en la raiz sin tocar: ${files.filter((f) => {
    const p = f.parents?.[0]
    return !p || !folderIds.has(p)
  }).length}`)
  console.log('='.repeat(64))

  if (!APPLY) console.log('\nPara aplicar: npx tsx scripts/drive-organize.ts --apply')
}

main().catch((err) => {
  console.error('\nError:', err instanceof Error ? err.message : err)
  process.exit(1)
})
