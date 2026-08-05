/**
 * Modelo del grafo. Compatible con el `graph.json` que emite la skill graphify:
 * nodos, aristas y procedencia explícita por elemento.
 *
 * El grafo NO es código de la app. Es un artefacto que vive en disco, fuera del
 * repo, y que Albus construye y lee.
 */

export type NodeType =
  | 'person'
  | 'company'
  | 'event'
  | 'payment'
  | 'entity'
  | 'topic'
  | 'url'
  | 'note'

/**
 * De dónde salió el dato. EXTRACTED es determinista (QR, regex, OCR + patrón);
 * INFERRED lo dedujo un modelo y puede estar mal.
 */
export type Provenance = 'EXTRACTED' | 'INFERRED'

export interface GraphNode {
  id: string
  type: NodeType
  label: string
  provenance: Provenance
  /** Datos sueltos según el tipo: empresa, monto, fecha, url… */
  attrs: Record<string, string>
  /** Qué extracciones lo respaldan: `${entryId}:${attachmentPath}`. */
  sources: string[]
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  label: string
  provenance: Provenance
  sources: string[]
}

export interface Graph {
  version: 1
  generatedAt: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: {
    nodes: number
    edges: number
    extracted: number
    inferred: number
  }
}

export function emptyGraph(generatedAt: string): Graph {
  return {
    version: 1,
    generatedAt,
    nodes: [],
    edges: [],
    stats: { nodes: 0, edges: 0, extracted: 0, inferred: 0 }
  }
}

/** Clave estable para deduplicar: el mismo nombre y tipo son el mismo nodo. */
export function nodeId(type: NodeType, label: string): string {
  const normal = label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `${type}:${normal}`
}
