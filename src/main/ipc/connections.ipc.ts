import { z } from 'zod'
import { BrowserWindow } from 'electron'
import { registerHandler } from './register-handler'
import { IpcChannels, IpcEvents, type ConnectionInfo, type ConnectionStepRow } from '../../shared/ipc'
import {
  applyConnections,
  connectWithBrowser,
  listConnections,
  openCredentialPage,
  service
} from '../connections/registry'
import { forgetCachedToken } from '../drive/client'

const IdSchema = z.object({ id: z.string().min(1).max(40) })

/**
 * El token viaja del renderer al main una sola vez y nunca vuelve. `jobsStatus`
 * y `connections:list` devuelven si HAY token, jamás cuál — un secreto que la
 * UI puede leer es un secreto que termina en un log de React.
 */
const TokenSchema = z.object({
  id: z.string().min(1).max(40),
  token: z.string().min(8).max(500)
})

export function registerConnectionHandlers(): void {
  registerHandler(IpcChannels.CONNECTIONS_LIST, async (): Promise<ConnectionInfo[]> =>
    listConnections()
  )

  registerHandler(IpcChannels.CONNECTIONS_BROWSER, async (payload: unknown, event) => {
    const { id } = IdSchema.parse(payload)

    /**
     * Cada paso sale para la UI apenas ocurre.
     *
     * El `invoke` de abajo no contesta hasta que todo termina —y conectar
     * Notion puede tardar minutos si hay que loguearse—, así que sin este
     * canal el usuario mira una pantalla congelada. Se manda a la ventana que
     * hizo el pedido, no a todas: el que no preguntó no tiene por qué recibir.
     */
    const target = event?.sender ?? BrowserWindow.getAllWindows()[0]?.webContents ?? null

    const onStep = (p: { step: string; ok: boolean; detail: string; screenshot?: string }): void => {
      if (target === null || target.isDestroyed()) return
      const row: ConnectionStepRow = { id, ...p }
      target.send(IpcEvents.CONNECTIONS_STEP, row)
    }

    const r = await connectWithBrowser(id, onStep)

    // Sin esto el cambio no se nota hasta reiniciar, que es medio del pedido.
    applyConnections()
    forgetCachedToken()

    return { ok: r.ok, message: r.message, connections: await listConnections() }
  })

  registerHandler(IpcChannels.CONNECTIONS_TOKEN, async (payload: unknown) => {
    const { id, token } = TokenSchema.parse(payload)
    const s = service(id)
    if (s === null) throw new Error(`no conozco el servicio "${id}"`)
    if (s.saveToken === undefined) throw new Error(`${s.name} no se conecta con token`)

    s.saveToken(token)
    applyConnections()
    forgetCachedToken()

    // Se devuelve la lista recalculada: el estado real, no el que suponemos.
    return { ok: true, message: `${s.name} conectado`, connections: await listConnections() }
  })

  registerHandler(IpcChannels.CONNECTIONS_OPEN, async (payload: unknown) => {
    const { id } = IdSchema.parse(payload)
    await openCredentialPage(id)
    return { opened: true }
  })

  registerHandler(IpcChannels.CONNECTIONS_CLEAR, async (payload: unknown) => {
    const { id } = IdSchema.parse(payload)
    const s = service(id)
    if (s === null) throw new Error(`no conozco el servicio "${id}"`)

    s.disconnect?.()
    applyConnections()
    forgetCachedToken()

    return { ok: true, connections: await listConnections() }
  })
}
