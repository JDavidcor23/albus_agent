import { ipcMain } from 'electron'
import type { IpcResult } from '../../shared/ipc'

export function registerHandler<T>(
  channel: string,
  handler: (...args: unknown[]) => Promise<T> | T
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<IpcResult<T>> => {
    const start = Date.now()
    try {
      const data = await handler(...args)
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
