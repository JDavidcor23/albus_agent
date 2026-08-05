import { useState } from 'react'
import type { Graph } from '../../../shared/ipc'
import { GraphCanvas } from './GraphCanvas'

interface Props {
  graph: Graph | null
  path: string
  construyendo: boolean
  progreso: { hechos: number; total: number } | null
  onConstruir: () => void
  onAbrirCarpeta: () => void
}

export function GraphView({
  graph,
  path,
  construyendo,
  progreso,
  onConstruir,
  onAbrirCarpeta
}: Props): React.JSX.Element {
  const [seleccion, setSeleccion] = useState<string | null>(null)
  const nodo = graph?.nodes.find((n) => n.id === seleccion) ?? null

  const vecinos =
    graph !== null && nodo !== null
      ? graph.edges
          .filter((e) => e.from === nodo.id || e.to === nodo.id)
          .map((e) => {
            const otroId = e.from === nodo.id ? e.to : e.from
            const otro = graph.nodes.find((n) => n.id === otroId)
            return { label: e.label, hacia: otro?.label ?? otroId }
          })
      : []

  if (construyendo) {
    return (
      <div className="graph-empty">
        <span className="feed-spinner" />
        <p className="idle-text">
          El CLI está leyendo las extracciones y armando el grafo.
          {progreso !== null && ` Lote ${progreso.hechos} de ${progreso.total}.`}
        </p>
      </div>
    )
  }

  if (graph === null) {
    return (
      <div className="graph-empty">
        <div className="idle-icon">◇</div>
        <p className="idle-text">
          Todavía no hay grafo. Se construye con el CLI a partir de lo extraído y queda
          guardado como archivo tuyo, fuera de la app.
        </p>
        <code className="graph-path">{path}</code>
        <button type="button" className="btn-brass" onClick={onConstruir}>
          construir grafo
        </button>
      </div>
    )
  }

  return (
    <div className="graph-wrap">
      <div className="graph-bar">
        <span className="graph-stat">
          {graph.stats.nodes} nodos · {graph.stats.edges} relaciones
        </span>
        <span className="graph-actions">
          <button type="button" className="pick" onClick={onAbrirCarpeta}>
            abrir carpeta
          </button>
          <span className="pick-sep">·</span>
          <button type="button" className="pick" onClick={onConstruir}>
            reconstruir
          </button>
        </span>
      </div>

      <GraphCanvas graph={graph} onSelect={setSeleccion} />

      {nodo !== null && (
        <div className="graph-detail">
          <div className="graph-detail-head">
            <span className="feed-label">{nodo.label}</span>
            <span className="feed-kind">
              {nodo.type} · {nodo.provenance === 'EXTRACTED' ? 'dato duro' : 'inferido'}
            </span>
          </div>

          {Object.entries(nodo.attrs).map(([k, v]) => (
            <p key={k} className="feed-summary">
              {k}: {v}
            </p>
          ))}

          {vecinos.map((v, i) => (
            <p key={i} className="feed-summary">
              {v.label} → {v.hacia}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
