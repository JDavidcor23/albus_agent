import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { registerHandler } from './register-handler'
import { IpcChannels, IpcEvents } from '../../shared/ipc'
import { createItemSource } from '../supabase/item-source'
import { createResultSink } from '../supabase/result-sink'
import { clearResults, listResults } from '../supabase/results-repo'
import { processBatch } from '../core/extraction/worker'
import { labelFor, toRow } from '../core/extraction/present'
import { detectProviders, getProvider } from '../providers/registry'
import { createDriveArchive } from '../drive/archive'
import { isDriveConfigured } from '../drive/client'

const RunPayloadSchema = z.object({
  limit: z.number().int().min(1).max(500).default(500),
  providerId: z.string().nullable().default(null),
  modelId: z.string().nullable().default(null)
})

/**
 * Un lote tarda minutos: sin empujar eventos, la ventana se queda muda hasta el
 * final. Se manda a todas las ventanas para no depender de quién disparó.
 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function registerExtractionHandlers(): void {
  registerHandler(IpcChannels.CLI_LIST, async () => await detectProviders(false))

  // Fuerza re-descubrimiento: ignora el caché y vuelve a preguntarle a cada CLI.
  registerHandler(IpcChannels.CLI_REFRESH, async () => await detectProviders(true))

  registerHandler(IpcChannels.EXTRACTION_LIST, async () => await listResults())

  registerHandler(IpcChannels.EXTRACTION_RESET, async () => {
    const deleted = await clearResults()
    return { deleted }
  })

  registerHandler(IpcChannels.EXTRACTION_RUN, async (payload: unknown) => {
    const { limit, providerId, modelId } = RunPayloadSchema.parse(payload ?? {})

    // Sin proveedor elegido la cascada corta en los patrones y no gasta cuota.
    const provider = providerId !== null ? getProvider(providerId) : null
    if (providerId !== null && provider === null) {
      throw new Error(`proveedor desconocido: ${providerId}`)
    }
    const llm = provider !== null ? { provider, model: modelId } : undefined

    // Sin credenciales de Google la app funciona igual: extrae y guarda en
    // Postgres, solo que no archiva la imagen. No es motivo para no arrancar.
    const archive = isDriveConfigured() ? createDriveArchive() : undefined
    if (archive === undefined) {
      console.warn('[extraction] Drive sin configurar: no se archivan imágenes')
    }

    return await processBatch(createItemSource(), createResultSink(), limit, {
      onItemStart: (item, index, total) => {
        broadcast(IpcEvents.ITEM_START, {
          id: `${item.entryId}:${item.attachmentPath}`,
          label: labelFor(item.attachmentPath),
          index,
          total
        })
      },
      onItemDone: (item, result) => {
        broadcast(IpcEvents.ITEM_DONE, toRow(item, result))
      }
    }, llm, archive)
  })
}
