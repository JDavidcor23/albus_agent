import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '../../shared/ipc'

/**
 * El handler recibe el payload y, como segundo argumento, el evento de Electron.
 *
 * El evento hace falta para los handlers que tardan y quieren ir contando qué
 * hacen: `invoke` no contesta hasta terminar, así que el progreso sale por
 * `evento.sender.send(...)` hacia la ventana que preguntó. Los handlers que no
 * lo necesitan simplemente no lo declaran.
 */
export function registerHandler<T>(
  channel: string,
  handler: (payload: unknown, event: IpcMainInvokeEvent) => Promise<T> | T
): void {
  ipcMain.handle(channel, async (event, payload: unknown): Promise<IpcResult<T>> => {
    const start = Date.now()
    try {
      const data = await handler(payload, event)
      const duration = Date.now() - start
      console.log(`[ipc] ${channel} ok (${duration}ms)`)
      return { ok: true, data }
    } catch (error: unknown) {
      const duration = Date.now() - start
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[ipc] ${channel} ERROR (${duration}ms): ${message}`)
      return {
        ok: false,
        error: {
          code: 'IPC_HANDLER_ERROR',
          message
        }
      }
    }
  })
}
