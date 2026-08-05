import { useCallback, useEffect, useState } from 'react'
import type { CliProviderInfo, Graph, ResultRow } from '../../shared/ipc'
import { LeftPanel } from './components/LeftPanel'
import { ResultsFeed } from './components/ResultsFeed'
import { ErrorBanner } from './components/ErrorBanner'
import { GraphView } from './components/GraphView'
import { ChatPanel } from './components/ChatPanel'

/** Un item que ya arrancó pero todavía no terminó: se pinta con su spinner. */
export interface PendingRow {
  id: string
  label: string
}

function App(): React.JSX.Element {
  const [rows, setRows] = useState<ResultRow[]>([])
  const [enCurso, setEnCurso] = useState<PendingRow | null>(null)
  const [progreso, setProgreso] = useState<{ hechos: number; total: number } | null>(null)
  const [procesando, setProcesando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [providers, setProviders] = useState<CliProviderInfo[]>([])
  const [providerId, setProviderId] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)
  const [tab, setTab] = useState<'feed' | 'grafo' | 'pendientes'>('pendientes')
  const [refrescandoCli, setRefrescandoCli] = useState(false)
  const [cargandoCli, setCargandoCli] = useState(true)
  const [graph, setGraph] = useState<Graph | null>(null)
  const [graphPath, setGraphPath] = useState('')
  const [construyendo, setConstruyendo] = useState(false)
  const [graphProg, setGraphProg] = useState<{ hechos: number; total: number } | null>(null)

  const cargarExistentes = useCallback(async (): Promise<void> => {
    const res = await window.api.listResults()
    if (res.ok) setRows(res.data)
    else setError(res.error.message)
  }, [])

  // Arrancar mostrando lo ya extraído: si no, la pantalla parece vacía aunque
  // haya 48 resultados guardados.
  useEffect(() => {
    void cargarExistentes()
    void window.api.loadGraph().then((res) => {
      if (!res.ok) return
      setGraph(res.data.graph)
      setGraphPath(res.data.path)
    })
    void window.api.listCliProviders().then((res) => {
      setCargandoCli(false)
      if (!res.ok) return
      setProviders(res.data)
      // Arranca con el primero detectado: el selector informa qué hay, no
      // pregunta si usarlo.
      const primero = res.data[0]
      if (primero !== undefined) {
        setProviderId(primero.id)
        setModelId(primero.models[0]?.id ?? null)
      }
    })
  }, [cargarExistentes])

  useEffect(() => {
    const offStart = window.api.onItemStart((e) => {
      setEnCurso({ id: e.id, label: e.label })
      setProgreso({ hechos: e.index, total: e.total })
    })

    const offDone = window.api.onItemDone((row) => {
      setEnCurso(null)
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

  const construirGrafo = async (): Promise<void> => {
    if (providerId === null) {
      setError('no hay CLI detectado para construir el grafo')
      return
    }
    setError(null)
    setConstruyendo(true)
    setGraphProg(null)

    try {
      const res = await window.api.buildGraph(providerId, modelId)
      if (res.ok) {
        setGraph(res.data.graph)
        setGraphPath(res.data.path)
        if (res.data.lotesFallidos > 0) {
          setError(`${res.data.lotesFallidos} lote(s) fallaron; el grafo salió incompleto`)
        }
      } else {
        setError(res.error.message)
      }
    } finally {
      setConstruyendo(false)
      setGraphProg(null)
    }
  }

  const procesar = async (): Promise<void> => {
    setError(null)
    setProcesando(true)
    setProgreso(null)

    try {
      const res = await window.api.runExtraction({ providerId, modelId })
      if (!res.ok) setError(res.error.message)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProcesando(false)
      setEnCurso(null)
      setProgreso(null)
    }
  }

  const reprocesar = async (): Promise<void> => {
    setError(null)
    setProcesando(true)

    try {
      const borrado = await window.api.resetResults()
      if (!borrado.ok) {
        setError(borrado.error.message)
        return
      }
      setRows([])
      const res = await window.api.runExtraction({ providerId, modelId })
      if (!res.ok) setError(res.error.message)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProcesando(false)
      setEnCurso(null)
      setProgreso(null)
    }
  }

  return (
    <div className="app-container">
      <LeftPanel
        procesando={procesando}
        providers={providers}
        providerId={providerId}
        modelId={modelId}
        refrescandoCli={refrescandoCli}
        cargandoCli={cargandoCli}
        onCliChange={(p, m) => {
          setProviderId(p)
          setModelId(m)
        }}
        onRefrescarCli={() => {
          setRefrescandoCli(true)
          void window.api.refreshCliProviders().then((res) => {
            if (res.ok) setProviders(res.data)
            else setError(res.error.message)
            setRefrescandoCli(false)
          })
        }}
        progreso={progreso}
        total={rows.length}
        onProcesar={procesar}
        onReprocesar={reprocesar}
      />
      <main className="panel-right">
        <nav className="tabs">
          <button
            type="button"
            className={`pick ${tab === 'pendientes' ? 'pick-on' : ''}`}
            onClick={() => setTab('pendientes')}
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
            className={`pick ${tab === 'grafo' ? 'pick-on' : ''}`}
            onClick={() => setTab('grafo')}
          >
            grafo
          </button>
        </nav>

        {error !== null && <ErrorBanner message={error} />}

        {tab === 'pendientes' ? (
          <ChatPanel onError={setError} />
        ) : tab === 'feed' ? (
          <ResultsFeed rows={rows} enCurso={enCurso} procesando={procesando} />
        ) : (
          <GraphView
            graph={graph}
            path={graphPath}
            construyendo={construyendo}
            progreso={graphProg}
            onConstruir={construirGrafo}
            onAbrirCarpeta={() => void window.api.revealGraph()}
          />
        )}
      </main>
    </div>
  )
}

export default App
