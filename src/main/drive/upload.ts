import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'
import { driveFetch, driveUpload } from './client'

/**
 * Subir UN archivo local a UNA carpeta de Drive.
 *
 * Distinto de `archive.ts`, que resuelve carpetas por nombre para el archivado
 * automático de la extracción. Acá la carpeta la elige el usuario —es el link
 * que pegó en sus reglas— y el nombre del archivo lo elige el agente, porque
 * eso también es una regla suya: *"el CV no puede tener nombre genérico, se
 * nota que es de IA"*. Ninguna de las dos cosas se decide en este archivo.
 */

const FileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  webViewLink: z.string().optional()
})

const ListSchema = z.object({ files: z.array(z.unknown()) })

/** Clave de idempotencia en `appProperties`, que es privado de la app. */
const KEY_PROP = 'albusUpload'

function q(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export interface UploadedFile {
  fileId: string
  name: string
  link: string | null
  /** `true` = ya estaba subido y se devolvió el de antes. */
  reused: boolean
}

/**
 * Drive no tiene unique: subir dos veces deja dos archivos iguales y nadie se
 * queja. Con el agente decidiendo cuándo subir, eso pasa seguro — se lo pedís
 * dos veces o reintenta tras un error. La clave lo hace idempotente.
 */
async function findByKey(key: string): Promise<UploadedFile | null> {
  const params = new URLSearchParams({
    q: `appProperties has { key='${KEY_PROP}' and value='${q(key)}' } and trashed=false`,
    fields: 'files(id,name,webViewLink)',
    pageSize: '5'
  })

  const list = ListSchema.parse(await driveFetch(`/files?${params}`))
  const hit = list.files.map((f) => FileSchema.safeParse(f)).find((r) => r.success)
  if (!hit?.success) return null

  return {
    fileId: hit.data.id,
    name: hit.data.name ?? '',
    link: hit.data.webViewLink ?? null,
    reused: true
  }
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  txt: 'text/plain',
  md: 'text/markdown'
}

function mimeOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME[ext] ?? 'application/octet-stream'
}

/**
 * Sube `localPath` a `folderId` con el nombre `name`.
 *
 * `folderId` vacío = la raíz del Drive. No es un default silencioso: es lo que
 * pasa cuando el usuario todavía no pegó ninguna carpeta en sus reglas, y el
 * llamador lo dice.
 */
export async function uploadToFolder(
  localPath: string,
  folderId: string,
  name?: string
): Promise<UploadedFile> {
  const bytes = await readFile(localPath)
  const finalName = name !== undefined && name.trim() !== '' ? name.trim() : basename(localPath)

  // La clave incluye el destino: el mismo CV puede ir a dos carpetas distintas
  // a propósito, y eso no es un duplicado.
  const key = `${folderId}:${finalName}`
  const existing = await findByKey(key)
  if (existing !== null) return existing

  const metadata = {
    name: finalName,
    ...(folderId !== '' ? { parents: [folderId] } : {}),
    appProperties: { [KEY_PROP]: key }
  }

  // multipart/related a mano: NO es multipart/form-data, así que `FormData` no
  // sirve — mismo motivo que en `archive.ts`.
  const boundary = `albus-${randomUUID()}`
  const head = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeOf(localPath)}\r\n\r\n`
  )
  const tail = Buffer.from(`\r\n--${boundary}--`)
  const body = Buffer.concat([head, bytes, tail])

  const uploaded = FileSchema.parse(
    await driveUpload(body, `multipart/related; boundary=${boundary}`)
  )

  return {
    fileId: uploaded.id,
    name: uploaded.name ?? finalName,
    link: uploaded.webViewLink ?? null,
    reused: false
  }
}
