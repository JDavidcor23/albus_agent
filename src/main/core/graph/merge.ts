import { nodeId, type Graph, type GraphEdge, type GraphNode, type NodeType, type Provenance } from './types'

/** Lo que aporta un item antes de fusionarse en el grafo. */
export interface Contribution {
  nodes: { type: NodeType; label: string; attrs?: Record<string, string> }[]
  edges: { fromType: NodeType; from: string; toType: NodeType; to: string; label: string }[]
  provenance: Provenance
  source: string
}

function mergeAttrs(
  current: Record<string, string>,
  incoming: Record<string, string>
): Record<string, string> {
  // Lo que ya estaba gana: un dato determinista no lo pisa uno inferido después.
  const output = { ...incoming, ...current }
  return output
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value)
}

/**
 * Funde contribuciones en un grafo. Es pura: no lee disco ni llama a nadie.
 *
 * Dos nodos con el mismo tipo y nombre son el mismo nodo, así que una persona
 * que aparece en tres capturas queda una sola vez con sus tres fuentes.
 */
export function mergeContributions(base: Graph, contributions: Contribution[]): Graph {
  const nodes = new Map<string, GraphNode>(base.nodes.map((n) => [n.id, n]))
  const edges = new Map<string, GraphEdge>(base.edges.map((e) => [e.id, e]))

  for (const contribution of contributions) {
    for (const n of contribution.nodes) {
      const label = n.label.trim()
      if (label.length === 0) continue

      const id = nodeId(n.type, label)
      const existing = nodes.get(id)

      if (existing === undefined) {
        nodes.set(id, {
          id,
          type: n.type,
          label,
          provenance: contribution.provenance,
          attrs: n.attrs ?? {},
          sources: [contribution.source]
        })
      } else {
        existing.attrs = mergeAttrs(existing.attrs, n.attrs ?? {})
        pushUnique(existing.sources, contribution.source)
        // Si un dato determinista confirma algo inferido, sube de categoría.
        if (contribution.provenance === 'EXTRACTED') existing.provenance = 'EXTRACTED'
      }
    }

    for (const e of contribution.edges) {
      const from = nodeId(e.fromType, e.from.trim())
      const to = nodeId(e.toType, e.to.trim())
      if (from === to) continue
      if (!nodes.has(from) || !nodes.has(to)) continue

      const id = `${from}|${e.label}|${to}`
      const existing = edges.get(id)

      if (existing === undefined) {
        edges.set(id, {
          id,
          from,
          to,
          label: e.label,
          provenance: contribution.provenance,
          sources: [contribution.source]
        })
      } else {
        pushUnique(existing.sources, contribution.source)
        if (contribution.provenance === 'EXTRACTED') existing.provenance = 'EXTRACTED'
      }
    }
  }

  const nodeList = [...nodes.values()]
  const edgeList = [...edges.values()]
  const all = [...nodeList, ...edgeList]

  return {
    version: 1,
    generatedAt: base.generatedAt,
    nodes: nodeList,
    edges: edgeList,
    stats: {
      nodes: nodeList.length,
      edges: edgeList.length,
      extracted: all.filter((x) => x.provenance === 'EXTRACTED').length,
      inferred: all.filter((x) => x.provenance === 'INFERRED').length
    }
  }
}
