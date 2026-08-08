import { z } from 'zod'
import { BrowserWindow } from 'electron'
import { registerHandler } from './register-handler'
import { IpcChannels, IpcEvents, type ConnectionInfo, type ConnectionStepRow } from '../../shared/ipc'
import {
  abrirDondeSacarlo,
  aplicarConexiones,
  conectarConNavegador,
  listarConexiones,
  servicio
} from '../connections/registry'
import { olvidarTokenCacheado } from '../drive/client'

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
    listarConexiones()
  )

  registerHandler(IpcChannels.CONNECTIONS_BROWSER, async (payload: unknown, evento) => {
    const { id } = IdSchema.parse(payload)

    /**
     * Cada paso sale para la UI apenas ocurre.
     *
     * El `invoke` de abajo no contesta hasta que todo termina —y conectar
     * Notion puede tardar minutos si hay que loguearse—, así que sin este
     * canal el usuario mira una pantalla congelada. Se manda a la ventana que
     * hizo el pedido, no a todas: el que no preguntó no tiene por qué recibir.
     */
    const destino = evento?.sender ?? BrowserWindow.getAllWindows()[0]?.webContents ?? null

    const onPaso = (p: { paso: string; ok: boolean; detalle: string; captura?: string }): void => {
      if (destino === null || destino.isDestroyed()) return
      const row: ConnectionStepRow = { id, ...p }
      destino.send(IpcEvents.CONNECTIONS_STEP, row)
    }

    const r = await conectarConNavegador(id, onPaso)

    // Sin esto el cambio no se nota hasta reiniciar, que es medio del pedido.
    aplicarConexiones()
    olvidarTokenCacheado()

    return { ok: r.ok, mensaje: r.mensaje, conexiones: await listarConexiones() }
  })

  registerHandler(IpcChannels.CONNECTIONS_TOKEN, async (payload: unknown) => {
    const { id, token } = TokenSchema.parse(payload)
    const s = servicio(id)
    if (s === null) throw new Error(`no conozco el servicio "${id}"`)
    if (s.guardarToken === undefined) throw new Error(`${s.nombre} no se conecta con token`)

    s.guardarToken(token)
    aplicarConexiones()
    olvidarTokenCacheado()

    // Se devuelve la lista recalculada: el estado real, no el que suponemos.
    return { ok: true, mensaje: `${s.nombre} conectado`, conexiones: await listarConexiones() }
  })

  registerHandler(IpcChannels.CONNECTIONS_OPEN, async (payload: unknown) => {
    const { id } = IdSchema.parse(payload)
    await abrirDondeSacarlo(id)
    return { abierto: true }
  })

  registerHandler(IpcChannels.CONNECTIONS_CLEAR, async (payload: unknown) => {
    const { id } = IdSchema.parse(payload)
    const s = servicio(id)
    if (s === null) throw new Error(`no conozco el servicio "${id}"`)

    s.desconectar?.()
    aplicarConexiones()
    olvidarTokenCacheado()

    return { ok: true, conexiones: await listarConexiones() }
  })
}
