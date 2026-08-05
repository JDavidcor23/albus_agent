import { nodeId, type Graph, type GraphEdge, type GraphNode, type NodeType, type Provenance } from './types'

/** Lo que aporta un item antes de fusionarse en el grafo. */
export interface Contribution {
  nodes: { type: NodeType; label: string; attrs?: Record<string, string> }[]
  edges: { fromType: NodeType; from: string; toType: NodeType; to: string; label: string }[]
  provenance: Provenance
  source: string
}

function mergeAttrs(
  destino: Record<string, string>,
  nuevos: Record<string, string>
): Record<string, string> {
  // Lo que ya estaba gana: un dato determinista no lo pisa uno inferido después.
  const salida = { ...nuevos, ...destino }
  return salida
}

function pushUnique(lista: string[], valor: string): void {
  if (!lista.includes(valor)) lista.push(valor)
}

/**
 * Funde contribuciones en un grafo. Es pura: no lee disco ni llama a nadie.
 *
 * Dos nodos con el mismo tipo y nombre son el mismo nodo, así que una persona
 * que aparece en tres capturas queda una sola vez con sus tres fuentes.
 */
export function mergeContributions(base: Graph, aportes: Contribution[]): Graph {
  const nodos = new Map<string, GraphNode>(base.nodes.map((n) => [n.id, n]))
  const aristas = new Map<string, GraphEdge>(base.edges.map((e) => [e.id, e]))

  for (const aporte of aportes) {
    for (const n of aporte.nodes) {
      const etiqueta = n.label.trim()
      if (etiqueta.length === 0) continue

      const id = nodeId(n.type, etiqueta)
      const existente = nodos.get(id)

      if (existente === undefined) {
        nodos.set(id, {
          id,
          type: n.type,
          label: etiqueta,
          provenance: aporte.provenance,
          attrs: n.attrs ?? {},
          sources: [aporte.source]
        })
      } else {
        existente.attrs = mergeAttrs(existente.attrs, n.attrs ?? {})
        pushUnique(existente.sources, aporte.source)
        // Si un dato determinista confirma algo inferido, sube de categoría.
        if (aporte.provenance === 'EXTRACTED') existente.provenance = 'EXTRACTED'
      }
    }

    for (const e of aporte.edges) {
      const desde = nodeId(e.fromType, e.from.trim())
      const hacia = nodeId(e.toType, e.to.trim())
      if (desde === hacia) continue
      if (!nodos.has(desde) || !nodos.has(hacia)) continue

      const id = `${desde}|${e.label}|${hacia}`
      const existente = aristas.get(id)

      if (existente === undefined) {
        aristas.set(id, {
          id,
          from: desde,
          to: hacia,
          label: e.label,
          provenance: aporte.provenance,
          sources: [aporte.source]
        })
      } else {
        pushUnique(existente.sources, aporte.source)
        if (aporte.provenance === 'EXTRACTED') existente.provenance = 'EXTRACTED'
      }
    }
  }

  const listaNodos = [...nodos.values()]
  const listaAristas = [...aristas.values()]
  const todo = [...listaNodos, ...listaAristas]

  return {
    version: 1,
    generatedAt: base.generatedAt,
    nodes: listaNodos,
    edges: listaAristas,
    stats: {
      nodes: listaNodos.length,
      edges: listaAristas.length,
      extracted: todo.filter((x) => x.provenance === 'EXTRACTED').length,
      inferred: todo.filter((x) => x.provenance === 'INFERRED').length
    }
  }
}
