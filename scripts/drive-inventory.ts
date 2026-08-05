/**
 * Inventario de solo lectura del Drive del usuario.
 *
 *   npx tsx scripts/drive-inventory.ts
 *
 * No modifica NADA. Sirve para saber que carpetas existen y que hay suelto
 * en la raiz antes de proponer cualquier reorganizacion.
 */
import { listAll, getStorageQuota, FOLDER_MIME, type DriveFile } from './lib/drive'

const MB = 1024 * 1024

function human(bytes: number): string {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(2)} GB`
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

function sizeOf(f: DriveFile): number {
  return f.size ? Number(f.size) : 0
}

/** Agrupa por tipo grueso para ver de que esta hecho el Drive. */
function kindOf(mime: string): string {
  if (mime === FOLDER_MIME) return 'carpeta'
  if (mime.startsWith('image/')) return 'imagen'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('application/vnd.google-apps')) return 'google-doc'
  return 'otro'
}

async function main(): Promise<void> {
  console.log('Leyendo Drive (solo lectura, no se modifica nada)...\n')

  const quota = await getStorageQuota()
  const all = await listAll('trashed = false')

  const folders = all.filter((f) => f.mimeType === FOLDER_MIME)
  const files = all.filter((f) => f.mimeType !== FOLDER_MIME)
  const byId = new Map(folders.map((f) => [f.id, f]))

  console.log('='.repeat(64))
  console.log('CUENTA')
  console.log('='.repeat(64))
  const usage = Number(quota.usage)
  const limit = Number(quota.limit)
  console.log(`  Usado    : ${human(usage)}`)
  console.log(
    `  Limite   : ${limit ? human(limit) : 'sin limite'}${
      limit ? `  (${((usage / limit) * 100).toFixed(1)} % ocupado)` : ''
    }`
  )
  console.log(`  Carpetas : ${folders.length}`)
  console.log(`  Archivos : ${files.length}`)

  // Composicion por tipo
  const kinds = new Map<string, { n: number; bytes: number }>()
  for (const f of files) {
    const k = kindOf(f.mimeType)
    const cur = kinds.get(k) ?? { n: 0, bytes: 0 }
    cur.n++
    cur.bytes += sizeOf(f)
    kinds.set(k, cur)
  }

  console.log('\n' + '='.repeat(64))
  console.log('COMPOSICION')
  console.log('='.repeat(64))
  for (const [k, v] of [...kinds.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${k.padEnd(12)} ${String(v.n).padStart(5)} archivos   ${human(v.bytes)}`)
  }

  // Arbol de carpetas con conteo directo
  const childFolders = new Map<string, DriveFile[]>()
  const roots: DriveFile[] = []
  for (const f of folders) {
    const parent = f.parents?.[0]
    if (parent && byId.has(parent)) {
      const list = childFolders.get(parent) ?? []
      list.push(f)
      childFolders.set(parent, list)
    } else {
      roots.push(f)
    }
  }

  const filesIn = new Map<string, DriveFile[]>()
  const looseAtRoot: DriveFile[] = []
  for (const f of files) {
    const parent = f.parents?.[0]
    if (parent && byId.has(parent)) {
      const list = filesIn.get(parent) ?? []
      list.push(f)
      filesIn.set(parent, list)
    } else {
      looseAtRoot.push(f)
    }
  }

  console.log('\n' + '='.repeat(64))
  console.log('CARPETAS')
  console.log('='.repeat(64))

  const walk = (folder: DriveFile, depth: number): void => {
    const own = filesIn.get(folder.id) ?? []
    const bytes = own.reduce((s, f) => s + sizeOf(f), 0)
    const kindMix = [...new Set(own.map((f) => kindOf(f.mimeType)))].join(', ')
    console.log(
      `${'  '.repeat(depth)}- ${folder.name}` +
        `  [${own.length} arch.${bytes ? `, ${human(bytes)}` : ''}]` +
        (kindMix ? `  ${kindMix}` : '')
    )
    for (const c of (childFolders.get(folder.id) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      walk(c, depth + 1)
    }
  }

  for (const r of roots.sort((a, b) => a.name.localeCompare(b.name))) walk(r, 1)

  console.log('\n' + '='.repeat(64))
  console.log(`SUELTOS EN LA RAIZ  (${looseAtRoot.length})`)
  console.log('='.repeat(64))
  if (!looseAtRoot.length) {
    console.log('  nada suelto')
  } else {
    for (const f of looseAtRoot
      .sort((a, b) => (b.createdTime ?? '').localeCompare(a.createdTime ?? ''))
      .slice(0, 60)) {
      const when = (f.createdTime ?? '').slice(0, 10)
      console.log(`  ${when}  ${kindOf(f.mimeType).padEnd(10)} ${f.name}`)
    }
    if (looseAtRoot.length > 60) {
      console.log(`  ... y ${looseAtRoot.length - 60} mas (mostrados los 60 mas nuevos)`)
    }
  }
}

main().catch((err) => {
  console.error('\nError:', err instanceof Error ? err.message : err)
  process.exit(1)
})
