import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  IpcChannels,
  IpcEvents,
  type BatchSummary,
  type IpcResult,
  type CliProviderInfo,
  type AskAnswer,
  type Graph,
  type GraphState,
  type ItemStartEvent,
  type ResultRow,
  type TaskDetail,
  type TaskRow
} from '../shared/ipc'

const api = {
  listCliProviders: (): Promise<IpcResult<CliProviderInfo[]>> =>
    ipcRenderer.invoke(IpcChannels.CLI_LIST),

  refreshCliProviders: (): Promise<IpcResult<CliProviderInfo[]>> =>
    ipcRenderer.invoke(IpcChannels.CLI_REFRESH),

  runExtraction: (opts?: {
    limit?: number
    providerId?: string | null
    modelId?: string | null
  }): Promise<IpcResult<BatchSummary>> => ipcRenderer.invoke(IpcChannels.EXTRACTION_RUN, opts ?? {}),

  listResults: (): Promise<IpcResult<ResultRow[]>> =>
    ipcRenderer.invoke(IpcChannels.EXTRACTION_LIST),

  resetResults: (): Promise<IpcResult<{ deleted: number }>> =>
    ipcRenderer.invoke(IpcChannels.EXTRACTION_RESET),

  loadGraph: (): Promise<IpcResult<GraphState>> => ipcRenderer.invoke(IpcChannels.GRAPH_LOAD),

  buildGraph: (
    providerId: string,
    modelId: string | null
  ): Promise<IpcResult<{ graph: Graph; path: string; lotesFallidos: number }>> =>
    ipcRenderer.invoke(IpcChannels.GRAPH_BUILD, { providerId, modelId }),

  revealGraph: (): Promise<IpcResult<{ path: string }>> =>
    ipcRenderer.invoke(IpcChannels.GRAPH_REVEAL),

  listTasks: (): Promise<IpcResult<TaskRow[]>> => ipcRenderer.invoke(IpcChannels.TASKS_LIST),

  askTasks: (message: string): Promise<IpcResult<AskAnswer>> =>
    ipcRenderer.invoke(IpcChannels.TASKS_ASK, { message }),

  closeTask: (id: string, status: 'done' | 'dismissed'): Promise<IpcResult<TaskRow[]>> =>
    ipcRenderer.invoke(IpcChannels.TASKS_CLOSE, { id, status }),

  taskDetail: (id: string): Promise<IpcResult<TaskDetail>> =>
    ipcRenderer.invoke(IpcChannels.TASKS_DETAIL, { id }),

  openExternal: (url: string): Promise<IpcResult<{ opened: boolean }>> =>
    ipcRenderer.invoke(IpcChannels.OPEN_EXTERNAL, { url }),

  onGraphProgress: (cb: (p: { hechos: number; total: number }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { hechos: number; total: number }): void => cb(payload)
    ipcRenderer.on(IpcEvents.GRAPH_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IpcEvents.GRAPH_PROGRESS, handler)
  },

  /** Devuelven la función para desuscribirse; sin eso el StrictMode duplica handlers. */
  onItemStart: (cb: (e: ItemStartEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: ItemStartEvent): void => cb(payload)
    ipcRenderer.on(IpcEvents.ITEM_START, handler)
    return () => ipcRenderer.removeListener(IpcEvents.ITEM_START, handler)
  },

  onItemDone: (cb: (row: ResultRow) => void): (() => void) => {
    const handler = (_e: unknown, payload: ResultRow): void => cb(payload)
    ipcRenderer.on(IpcEvents.ITEM_DONE, handler)
    return () => ipcRenderer.removeListener(IpcEvents.ITEM_DONE, handler)
  }
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
