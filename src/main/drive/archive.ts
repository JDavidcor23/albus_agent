import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { driveFetch, driveUpload } from './client'
import { archiveFileName, archiveKey, type ArchiveFolder, type ArchivedRef } from '../core/extraction/archive'
import type { ArchivePort } from '../core/extraction/ports'
import type { ExtractionResult, PendingItem } from '../core/extraction/types'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

/** La clave de idempotencia viaja en appProperties, que es privado de la app. */
const KEY_PROP = 'albusKey'

const FileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  webViewLink: z.string().optional()
})

const ListSchema = z.object({ files: z.array(z.unknown()) })

/** Drive interpreta la comilla simple como delimitador; hay que escaparla. */
function q(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export function createDriveArchive(): ArchivePort {
  // Los IDs de carpeta no cambian entre items del mismo lote.
  const folderIds = new Map<ArchiveFolder, string>()

  async function resolveFolder(name: ArchiveFolder): Promise<string> {
    const cached = folderIds.get(name)
    if (cached) return cached

    const params = new URLSearchParams({
      q: `mimeType='${FOLDER_MIME}' and name='${q(name)}' and trashed=false and 'root' in parents`,
      fields: 'files(id,name)',
      pageSize: '10'
    })

    const list = ListSchema.parse(await driveFetch(`/files?${params}`))
    const first = list.files.map((f) => FileSchema.safeParse(f)).find((r) => r.success)

    if (first?.success) {
      folderIds.set(name, first.data.id)
      return first.data.id
    }

    // Se autorepara: si alguien borró la carpeta a mano, la volvemos a crear en
    // vez de fallar todo el lote.
    const created = FileSchema.parse(
      await driveFetch('/files?fields=id,name', {
        method: 'POST',
        body: JSON.stringify({ name, mimeType: FOLDER_MIME })
      })
    )
    console.warn(`[drive] carpeta "${name}" no existía, se creó (${created.id})`)
    folderIds.set(name, created.id)
    return created.id
  }

  /**
   * Drive no tiene unique constraints: subir dos veces crea dos archivos con el
   * mismo nombre y nadie se queja. La idempotencia la damos buscando la clave en
   * appProperties antes de subir — es el equivalente al unique
   * (entry_id, attachment_path) que ya protege la tabla `extractions`.
   */
  async function findExisting(key: string): Promise<ArchivedRef | null> {
    const params = new URLSearchParams({
      q: `appProperties has { key='${KEY_PROP}' and value='${q(key)}' } and trashed=false`,
      fields: 'files(id,name,webViewLink)',
      pageSize: '10'
    })

    const list = ListSchema.parse(await driveFetch(`/files?${params}`))
    const hit = list.files.map((f) => FileSchema.safeParse(f)).find((r) => r.success)
    if (!hit?.success) return null

    return {
      fileId: hit.data.id,
      folder: 'pagos', // se sobreescribe abajo con la carpeta real pedida
      webViewLink: hit.data.webViewLink ?? null,
      reused: true
    }
  }

  return {
    async archive(
      item: PendingItem,
      result: ExtractionResult,
      folder: ArchiveFolder,
      bytes: Uint8Array
    ): Promise<ArchivedRef> {
      const key = archiveKey(item)

      const existing = await findExisting(key)
      if (existing !== null) return { ...existing, folder }

      const parentId = await resolveFolder(folder)
      const metadata = {
        name: archiveFileName(item, result),
        parents: [parentId],
        appProperties: {
          [KEY_PROP]: key,
          albusKind: result.kind,
          albusEntry: item.entryId
        }
      }

      // multipart/related a mano: no es multipart/form-data, así que FormData no
      // sirve. Parte JSON con la metadata, parte binaria con la imagen.
      const boundary = `albus-${randomUUID()}`
      const head = Buffer.from(
        `--${boundary}\r\n` +
          'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
          `${JSON.stringify(metadata)}\r\n` +
          `--${boundary}\r\n` +
          `Content-Type: ${item.mime}\r\n\r\n`
      )
      const tail = Buffer.from(`\r\n--${boundary}--`)
      const body = Buffer.concat([head, Buffer.from(bytes), tail])

      const uploaded = FileSchema.parse(
        await driveUpload(body, `multipart/related; boundary=${boundary}`)
      )

      return {
        fileId: uploaded.id,
        folder,
        webViewLink: uploaded.webViewLink ?? null,
        reused: false
      }
    }
  }
}
