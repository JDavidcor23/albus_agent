import { useCallback, useEffect, useState } from 'react'
import type { CliProviderInfo, Graph, ResultRow } from '../../shared/ipc'
import { Rail, type View } from './components/Rail'
import { ResultsFeed } from './components/ResultsFeed'
import { ErrorBanner } from './components/ErrorBanner'
import { GraphView } from './components/GraphView'
import { ChatPanel } from './components/ChatPanel'
import { AgentsPanel } from './components/AgentsPanel'
import { SettingsPanel } from './components/SettingsPanel'

/** An item that started but has not finished yet: drawn with its spinner. */
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
  const [view, setView] = useState<View>('chat')
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

  // Start by showing what was already extracted: otherwise the screen looks
  // empty even with 48 saved results.
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
      // Starts with the first one found: the picker reports what is there, it
      // does not ask whether to use it.
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
      // Replaces instead of stacking: reprocessing an item does not duplicate
      // it on screen.
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
      setError('no CLI detected to build the graph')
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
          setError(`${res.data.failedBatches} batch(es) failed; the graph came out incomplete`)
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

  const refreshCli = (): void => {
    setRefreshingCli(true)
    void window.api.refreshCliProviders().then((res) => {
      if (res.ok) setProviders(res.data)
      else setError(res.error.message)
      setRefreshingCli(false)
    })
  }

  return (
    <div className="app-container">
      <Rail
        view={view}
        onView={setView}
        providerId={providerId}
        modelId={modelId}
        total={rows.length}
      />

      <main className="panel-right">
        {error !== null && <ErrorBanner message={error} />}

        {view === 'chat' ? (
          <AgentsPanel
            providers={providers}
            providerId={providerId}
            modelId={modelId}
            onError={setError}
          />
        ) : view === 'tasks' ? (
          <ChatPanel onError={setError} />
        ) : view === 'extractions' ? (
          <ResultsFeed
            rows={rows}
            inProgress={inProgress}
            processing={processing}
            progress={progress}
            onProcess={processBatch}
            onReprocess={reprocessAll}
          />
        ) : view === 'settings' ? (
          <SettingsPanel
            providers={providers}
            providerId={providerId}
            modelId={modelId}
            refreshing={refreshingCli}
            loading={loadingCli}
            onCliChange={(p, m) => {
              setProviderId(p)
              setModelId(m)
            }}
            onRefreshCli={refreshCli}
            onError={setError}
          />
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
