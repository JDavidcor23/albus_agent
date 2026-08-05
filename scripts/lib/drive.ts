/**
 * Cliente minimo de Google Drive para los scripts de mantenimiento.
 * Sin dependencias: solo fetch. La respuesta de Drive es input externo,
 * asi que todo lo que se consume se valida con zod antes de usarse.
 */
import { z } from 'zod'
import 'dotenv/config'

const DriveFile = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  parents: z.array(z.string()).optional(),
  size: z.string().optional(),
  createdTime: z.string().optional(),
  modifiedTime: z.string().optional(),
  trashed: z.boolean().optional(),
  /** Privadas de la app. Albus marca acá lo que sube, con la clave `albusKey`. */
  appProperties: z.record(z.string(), z.string()).optional()
})

export type DriveFile = z.infer<typeof DriveFile>

const ListResponse = z.object({
  files: z.array(z.unknown()),
  nextPageToken: z.string().optional()
})

export const FOLDER_MIME = 'application/vnd.google-apps.folder'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Falta ${name} en .env`)
  return v
}

let cachedToken: { value: string; expiresAt: number } | null = null

/** Canjea el refresh token por un access token, cacheado en memoria. */
export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.value

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requireEnv('GOOGLE_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
      refresh_token: requireEnv('GOOGLE_REFRESH_TOKEN'),
      grant_type: 'refresh_token'
    })
  })

  const json: unknown = await res.json()
  if (!res.ok) throw new Error(`No se pudo refrescar el token: ${JSON.stringify(json)}`)

  const parsed = z
    .object({ access_token: z.string().min(1), expires_in: z.number() })
    .safeParse(json)
  if (!parsed.success) throw new Error(`Token con forma inesperada: ${parsed.error.message}`)

  cachedToken = {
    value: parsed.data.access_token,
    expiresAt: Date.now() + parsed.data.expires_in * 1000
  }
  return cachedToken.value
}

async function driveFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await getAccessToken()
  const res = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {})
    }
  })
  const json: unknown = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Drive ${res.status}: ${JSON.stringify(json)}`)
  return json
}

/**
 * Lista TODO lo que matchea la query, paginando hasta el final.
 * Nada de limites fijos: una pagina sola deja archivos viejos fuera del alcance.
 * Valida fila por fila con safeParse — un registro raro no puede tumbar el lote.
 */
export async function listAll(query: string): Promise<DriveFile[]> {
  const out: DriveFile[] = []
  let pageToken: string | undefined
  let skipped = 0

  do {
    const params = new URLSearchParams({
      q: query,
      pageSize: '1000',
      fields:
        'nextPageToken,files(id,name,mimeType,parents,size,createdTime,modifiedTime,appProperties)',
      spaces: 'drive'
    })
    if (pageToken) params.set('pageToken', pageToken)

    const raw = await driveFetch(`/files?${params}`)
    const page = ListResponse.parse(raw)

    for (const row of page.files) {
      const parsed = DriveFile.safeParse(row)
      if (parsed.success) out.push(parsed.data)
      else skipped++
    }
    pageToken = page.nextPageToken
  } while (pageToken)

  if (skipped) console.warn(`  (${skipped} entradas salteadas por forma inesperada)`)
  return out
}

const FileMeta = z.object({
  id: z.string(),
  name: z.string(),
  size: z.string().optional(),
  trashed: z.boolean().optional(),
  /** Drive lo calcula sobre los bytes subidos. Solo existe para binarios. */
  md5Checksum: z.string().optional()
})

export type DriveFileMeta = z.infer<typeof FileMeta>

/** Metadata de UN archivo. Devuelve null si no existe o ya no es accesible. */
export async function getFileMeta(fileId: string): Promise<DriveFileMeta | null> {
  try {
    const raw = await driveFetch(`/files/${fileId}?fields=id,name,size,trashed,md5Checksum`)
    return FileMeta.parse(raw)
  } catch {
    return null
  }
}

export async function createFolder(name: string, parentId?: string): Promise<DriveFile> {
  const raw = await driveFetch('/files?fields=id,name,mimeType,parents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME,
      ...(parentId ? { parents: [parentId] } : {})
    })
  })
  return DriveFile.parse(raw)
}

/** Mueve un archivo: en Drive es cambiar de padre, no copiar. */
export async function moveFile(
  fileId: string,
  toParentId: string,
  fromParentId: string
): Promise<void> {
  const params = new URLSearchParams({
    addParents: toParentId,
    removeParents: fromParentId,
    fields: 'id,parents'
  })
  await driveFetch(`/files/${fileId}?${params}`, { method: 'PATCH', body: '{}' })
}

/**
 * Manda a la papelera. NO usa DELETE: en Drive `files.delete` es permanente y
 * saltea Trash. Con trashed:true quedan 30 dias para revertir.
 */
export async function trashFile(fileId: string): Promise<void> {
  await driveFetch(`/files/${fileId}?fields=id,trashed`, {
    method: 'PATCH',
    body: JSON.stringify({ trashed: true })
  })
}

export async function getStorageQuota(): Promise<{ limit: string; usage: string }> {
  const token = await getAccessToken()
  const res = await fetch(
    'https://www.googleapis.com/drive/v3/about?fields=storageQuota(limit,usage)',
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const json: unknown = await res.json()
  const parsed = z
    .object({ storageQuota: z.object({ limit: z.string().optional(), usage: z.string() }) })
    .safeParse(json)
  if (!parsed.success) return { limit: '0', usage: '0' }
  return { limit: parsed.data.storageQuota.limit ?? '0', usage: parsed.data.storageQuota.usage }
}
