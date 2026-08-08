import { useState } from 'react'
import type { Graph } from '../../../shared/ipc'
import { GraphCanvas } from './GraphCanvas'

interface Props {
  graph: Graph | null
  path: string
  building: boolean
  progress: { done: number; total: number } | null
  onBuild: () => void
  onOpenFolder: () => void
}

export function GraphView({
  graph,
  path,
  building,
  progress,
  onBuild,
  onOpenFolder
}: Props): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const node = graph?.nodes.find((n) => n.id === selected) ?? null

  const neighbors =
    graph !== null && node !== null
      ? graph.edges
          .filter((e) => e.from === node.id || e.to === node.id)
          .map((e) => {
            const otherId = e.from === node.id ? e.to : e.from
            const other = graph.nodes.find((n) => n.id === otherId)
            return { label: e.label, to: other?.label ?? otherId }
          })
      : []

  if (building) {
    return (
      <div className="graph-empty">
        <span className="feed-spinner" />
        <p className="idle-text">
          El CLI está leyendo las extracciones y armando el grafo.
          {progress !== null && ` Lote ${progress.done} de ${progress.total}.`}
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
        <button type="button" className="btn-brass" onClick={onBuild}>
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
          <button type="button" className="pick" onClick={onOpenFolder}>
            abrir carpeta
          </button>
          <span className="pick-sep">·</span>
          <button type="button" className="pick" onClick={onBuild}>
            reconstruir
          </button>
        </span>
      </div>

      <GraphCanvas graph={graph} onSelect={setSelected} />

      {node !== null && (
        <div className="graph-detail">
          <div className="graph-detail-head">
            <span className="feed-label">{node.label}</span>
            <span className="feed-kind">
              {node.type} · {node.provenance === 'EXTRACTED' ? 'dato duro' : 'inferido'}
            </span>
          </div>

          {Object.entries(node.attrs).map(([k, v]) => (
            <p key={k} className="feed-summary">
              {k}: {v}
            </p>
          ))}

          {neighbors.map((n, i) => (
            <p key={i} className="feed-summary">
              {n.label} → {n.to}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
