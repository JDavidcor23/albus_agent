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
          The CLI is reading the extractions and assembling the graph.
          {progress !== null && ` Batch ${progress.done} of ${progress.total}.`}
        </p>
      </div>
    )
  }

  if (graph === null) {
    return (
      <div className="graph-empty">
        <div className="idle-icon">◇</div>
        <p className="idle-text">
          No graph yet. The CLI builds it from what was extracted, and it is saved as a file
          of yours, outside the app.
        </p>
        <code className="graph-path">{path}</code>
        <button type="button" className="btn-brass" onClick={onBuild}>
          build graph
        </button>
      </div>
    )
  }

  return (
    <div className="graph-wrap">
      <div className="graph-bar">
        <span className="graph-stat">
          {graph.stats.nodes} nodes · {graph.stats.edges} relations
        </span>
        <span className="graph-actions">
          <button type="button" className="pick" onClick={onOpenFolder}>
            open folder
          </button>
          <span className="pick-sep">·</span>
          <button type="button" className="pick" onClick={onBuild}>
            rebuild
          </button>
        </span>
      </div>

      <GraphCanvas graph={graph} onSelect={setSelected} />

      {node !== null && (
        <div className="graph-detail">
          <div className="graph-detail-head">
            <span className="feed-label">{node.label}</span>
            <span className="feed-kind">
              {/* 'EXTRACTED' is a stored value, not copy — only the label changes. */}
              {node.type} · {node.provenance === 'EXTRACTED' ? 'hard data' : 'inferred'}
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
