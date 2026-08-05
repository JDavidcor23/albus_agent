/**
 * Libera Supabase Storage borrando los adjuntos que ya estan a salvo en Drive.
 *
 *   npx tsx scripts/storage-prune.ts           (dry-run, no borra nada)
 *   npx tsx scripts/storage-prune.ts --apply
 *
 * ATENCION: el borrado en Supabase Storage es PERMANENTE. No hay papelera, a
 * diferencia de Drive. Por eso cada archivo pasa cuatro filtros y basta que uno
 * falle para saltearlo:
 *
 *   1. La extraccion tiene una referencia de Drive guardada.
 *   2. Ese archivo EXISTE hoy en Drive (no se confia en el payload: el usuario
 *      pudo haberlo borrado despues).
 *   3. No esta en la papelera de Drive.
 *   4. El md5 de los bytes en Storage coincide con el md5 que reporta Drive.
 *      Sin esta prueba no se borra: "esta en Drive" no alcanza, tiene que ser
 *      EL MISMO archivo.
 *
 * OJO: My Notes muestra las fotos desde Storage. Despues de correr esto con
 * --apply, esa app va a mostrar imagenes rotas hasta que aprenda a leerlas
 * desde Drive.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { getSupabaseClient } from '../src/main/supabase/client'
import { getFileMeta } from './lib/drive'

const APPLY = process.argv.includes('--apply')
const MB = 1024 * 1024

const Fila = z.object({
  attachment_path: z.string(),
  kind: z.string(),
  payload: z
    .object({
      context: z.string().optional(),
      drive: z.object({ fileId: z.string(), folder: z.string() }).optional()
    })
    .nullable()
})

async function main(): Promise<void> {
  console.log(APPLY ? 'MODO APPLY — borrado PERMANENTE\n' : 'MODO DRY-RUN — no se toca nada\n')

  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('extractions')
    .select('attachment_path, kind, payload')
  if (error) throw new Error(error.message)

  const candidatos: { path: string; fileId: string; kind: string; context: string }[] = []
  let sinDrive = 0

  for (const raw of Array.isArray(data) ? data : []) {
    const parsed = Fila.safeParse(raw)
    if (!parsed.success) continue
    const f = parsed.data
    if (f.attachment_path === '') continue

    const drive = f.payload?.drive
    if (!drive) {
      sinDrive++
      continue
    }
    candidatos.push({
      path: f.attachment_path,
      fileId: drive.fileId,
      kind: f.kind,
      context: f.payload?.context ?? ''
    })
  }

  console.log(`Adjuntos con copia en Drive : ${candidatos.length}`)
  console.log(`Adjuntos SIN copia en Drive : ${sinDrive}  (no se tocan, se perderian)\n`)

  const aBorrar: string[] = []
  let liberado = 0

  for (const c of candidatos) {
    const meta = await getFileMeta(c.fileId)

    if (meta === null) {
      console.log(`  SALTEADO  ${c.context || c.kind} — el archivo ya no existe en Drive`)
      continue
    }
    if (meta.trashed === true) {
      console.log(`  SALTEADO  ${c.context || c.kind} — esta en la papelera de Drive`)
      continue
    }

    const { data: blob, error: e } = await supabase.storage.from('attachments').download(c.path)
    if (e || !blob) {
      console.log(`  SALTEADO  ${c.context || c.kind} — no se pudo leer de Storage`)
      continue
    }

    const bytes = Buffer.from(await blob.arrayBuffer())
    const md5Local = createHash('md5').update(bytes).digest('hex')

    if (meta.md5Checksum === undefined) {
      console.log(`  SALTEADO  ${c.context || c.kind} — Drive no reporta md5, no puedo probar`)
      continue
    }
    if (md5Local !== meta.md5Checksum) {
      console.log(
        `  SALTEADO  ${c.context || c.kind} — md5 DISTINTO (storage ${md5Local.slice(0, 8)} vs drive ${meta.md5Checksum.slice(0, 8)})`
      )
      continue
    }

    console.log(
      `  ${APPLY ? 'BORRADO ' : 'se borraria'}  ${(c.context || c.kind).padEnd(38)} ` +
        `${(bytes.length / 1024).toFixed(0)} KB  md5 ok`
    )
    aBorrar.push(c.path)
    liberado += bytes.length
  }

  if (APPLY && aBorrar.length > 0) {
    const { error: e } = await supabase.storage.from('attachments').remove(aBorrar)
    if (e) throw new Error(`Error borrando de Storage: ${e.message}`)
  }

  console.log(
    `\n${APPLY ? 'Liberados' : 'Se liberarian'} ${(liberado / MB).toFixed(2)} MB ` +
      `en ${aBorrar.length} archivos.`
  )
  if (!APPLY && aBorrar.length > 0) {
    console.log('\nPara aplicar: npx tsx scripts/storage-prune.ts --apply')
    console.log('Recorda: My Notes va a mostrar esas fotos rotas hasta que lea desde Drive.')
  }
}

main().catch((err) => {
  console.error('\nError:', err instanceof Error ? err.message : err)
  process.exit(1)
})
