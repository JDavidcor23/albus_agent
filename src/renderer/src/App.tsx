import { useCallback, useEffect, useState } from 'react'
import type { CliProviderInfo, Graph, ResultRow } from '../../shared/ipc'
import { LeftPanel } from './components/LeftPanel'
import { ResultsFeed } from './components/ResultsFeed'
import { ErrorBanner } from './components/ErrorBanner'
import { GraphView } from './components/GraphView'
import { ChatPanel } from './components/ChatPanel'
import { AgentsPanel } from './components/AgentsPanel'

/** Un item que ya arrancó pero todavía no terminó: se pinta con su spinner. */
export interface PendingRow {
  id: string
  label: string
}

function App(): React.JSX.Element {
  const [rows, setRows] = useState<ResultRow[]>([])
  const [inProgress, setInProgress] = useState<PendingRow | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [providers, setProviders] = useState<CliProviderInfo[]>([])
  const [providerId, setProviderId] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)
  const [tab, setTab] = useState<'feed' | 'graph' | 'tasks' | 'agents'>('agents')
  const [refreshingCli, setRefreshingCli] = useState(false)
  const [loadingCli, setLoadingCli] = useState(true)
  const [graph, setGraph] = useState<Graph | null>(null)
  const [graphPath, setGraphPath] = useState('')
  const [building, setBuilding] = useState(false)
  const [graphProg, setGraphProg] = useState<{ done: number; total: number } | null>(null)

  const loadExisting = useCallback(async (): Promise<void> => {
    const res = await window.api.listResults()
    if (res.ok) setRows(res.data)
    else setError(res.error.message)
  }, [])

  // Arrancar mostrando lo ya extraído: si no, la pantalla parece vacía aunque
  // haya 48 resultados guardados.
  useEffect(() => {
    void loadExisting()
    void window.api.loadGraph().then((res) => {
      if (!res.ok) return
      setGraph(res.data.graph)
      setGraphPath(res.data.path)
    })
    void window.api.listCliProviders().then((res) => {
      setLoadingCli(false)
      if (!res.ok) return
      setProviders(res.data)
      // Arranca con el primero detectado: el selector informa qué hay, no
      // pregunta si usarlo.
      const first = res.data[0]
      if (first !== undefined) {
        setProviderId(first.id)
        setModelId(first.models[0]?.id ?? null)
      }
    })
  }, [loadExisting])

  useEffect(() => {
    const offStart = window.api.onItemStart((e) => {
      setInProgress({ id: e.id, label: e.label })
      setProgress({ done: e.index, total: e.total })
    })

    const offDone = window.api.onItemDone((row) => {
      setInProgress(null)
      // Reemplaza en vez de apilar: reprocesar un item no lo duplica en pantalla.
      setRows((prev) => [row, ...prev.filter((r) => r.id !== row.id)])
    })

    const offGraph = window.api.onGraphProgress(setGraphProg)

    return () => {
      offStart()
      offDone()
      offGraph()
    }
  }, [])

  const buildGraph = async (): Promise<void> => {
    if (providerId === null) {
      setError('no hay CLI detectado para construir el grafo')
      return
    }
    setError(null)
    setBuilding(true)
    setGraphProg(null)

    try {
      const res = await window.api.buildGraph(providerId, modelId)
      if (res.ok) {
        setGraph(res.data.graph)
        setGraphPath(res.data.path)
        if (res.data.failedBatches > 0) {
          setError(`${res.data.failedBatches} lote(s) fallaron; el grafo salió incompleto`)
        }
      } else {
        setError(res.error.message)
      }
    } finally {
      setBuilding(false)
      setGraphProg(null)
    }
  }

  const processBatch = async (): Promise<void> => {
    setError(null)
    setProcessing(true)
    setProgress(null)

    try {
      const res = await window.api.runExtraction({ providerId, modelId })
      if (!res.ok) setError(res.error.message)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProcessing(false)
      setInProgress(null)
      setProgress(null)
    }
  }

  const reprocessAll = async (): Promise<void> => {
    setError(null)
    setProcessing(true)

    try {
      const deleted = await window.api.resetResults()
      if (!deleted.ok) {
        setError(deleted.error.message)
        return
      }
      setRows([])
      const res = await window.api.runExtraction({ providerId, modelId })
      if (!res.ok) setError(res.error.message)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProcessing(false)
      setInProgress(null)
      setProgress(null)
    }
  }

  return (
    <div className="app-container">
      <LeftPanel
        processing={processing}
        providers={providers}
        providerId={providerId}
        modelId={modelId}
        refreshingCli={refreshingCli}
        loadingCli={loadingCli}
        onCliChange={(p, m) => {
          setProviderId(p)
          setModelId(m)
        }}
        onRefreshCli={() => {
          setRefreshingCli(true)
          void window.api.refreshCliProviders().then((res) => {
            if (res.ok) setProviders(res.data)
            else setError(res.error.message)
            setRefreshingCli(false)
          })
        }}
        progress={progress}
        total={rows.length}
        onProcess={processBatch}
        onReprocess={reprocessAll}
      />
      <main className="panel-right">
        <nav className="tabs">
          <button
            type="button"
            className={`pick ${tab === 'agents' ? 'pick-on' : ''}`}
            onClick={() => setTab('agents')}
          >
            agentes
          </button>
          <span className="pick-sep">·</span>
          <button
            type="button"
            className={`pick ${tab === 'tasks' ? 'pick-on' : ''}`}
            onClick={() => setTab('tasks')}
          >
            pendientes
          </button>
          <span className="pick-sep">·</span>
          <button
            type="button"
            className={`pick ${tab === 'feed' ? 'pick-on' : ''}`}
            onClick={() => setTab('feed')}
          >
            extracciones
          </button>
          <span className="pick-sep">·</span>
          <button
            type="button"
            className={`pick ${tab === 'graph' ? 'pick-on' : ''}`}
            onClick={() => setTab('graph')}
          >
            grafo
          </button>
        </nav>

        {error !== null && <ErrorBanner message={error} />}

        {tab === 'agents' ? (
          <AgentsPanel
            providers={providers}
            providerId={providerId}
            modelId={modelId}
            onError={setError}
          />
        ) : tab === 'tasks' ? (
          <ChatPanel onError={setError} />
        ) : tab === 'feed' ? (
          <ResultsFeed rows={rows} inProgress={inProgress} processing={processing} />
        ) : (
          <GraphView
            graph={graph}
            path={graphPath}
            building={building}
            progress={graphProg}
            onBuild={buildGraph}
            onOpenFolder={() => void window.api.revealGraph()}
          />
        )}
      </main>
    </div>
  )
}

export default App
