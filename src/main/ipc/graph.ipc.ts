import { BrowserWindow, shell } from 'electron'
import { z } from 'zod'
import { registerHandler } from './register-handler'
import { IpcChannels, IpcEvents } from '../../shared/ipc'
import { listResults } from '../supabase/results-repo'
import { getProvider } from '../providers/registry'
import { buildGraph } from '../core/graph/build'
import { graphDir, graphPath, loadGraph, saveGraph } from '../graph/store'

const BuildSchema = z.object({
  providerId: z.string(),
  modelId: z.string().nullable().default(null)
})

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function registerGraphHandlers(): void {
  registerHandler(IpcChannels.GRAPH_LOAD, async () => ({
    graph: loadGraph(),
    path: graphPath()
  }))

  registerHandler(IpcChannels.GRAPH_REVEAL, async () => {
    await shell.openPath(graphDir())
    return { path: graphDir() }
  })

  registerHandler(IpcChannels.GRAPH_BUILD, async (payload: unknown) => {
    const { providerId, modelId } = BuildSchema.parse(payload ?? {})

    const provider = getProvider(providerId)
    if (provider === null) throw new Error(`proveedor desconocido: ${providerId}`)
    if (!(await provider.isAvailable())) {
      throw new Error(`${providerId} no está en el PATH`)
    }

    const rows = await listResults(500)
    if (rows.length === 0) {
      throw new Error('no hay extracciones todavía: corré un lote primero')
    }

    // El análisis lo hace el CLI. Acá solo se orquesta y se guarda.
    const { graph, failedBatches } = await buildGraph(
      rows,
      provider,
      modelId,
      new Date().toISOString(),
      { onBatch: (done, total) => broadcast(IpcEvents.GRAPH_PROGRESS, { done, total }) }
    )

    const path = saveGraph(graph)
    return { graph, path, failedBatches }
  })
}
