import { useEffect, useRef } from 'react'
import cytoscape, { type Core } from 'cytoscape'
import fcose from 'cytoscape-fcose'
import type { Graph, GraphNodeType } from '../../../shared/ipc'

cytoscape.use(fcose)

const COLOR: Record<GraphNodeType, string> = {
  person: '#8B93C4',
  company: '#C9973F',
  event: '#6FA8A0',
  payment: '#C9973F',
  entity: '#B4574A',
  topic: '#C4B9A5',
  url: '#6FA8A0',
  note: '#8A8478'
}

interface Props {
  graph: Graph
  onSelect: (nodeId: string | null) => void
}

export function GraphCanvas({ graph, onSelect }: Props): React.JSX.Element {
  const container = useRef<HTMLDivElement | null>(null)
  const cyRef = useRef<Core | null>(null)

  useEffect(() => {
    if (container.current === null) return

    const cy = cytoscape({
      container: container.current,
      elements: [
        ...graph.nodes.map((n) => ({
          data: { id: n.id, label: n.label, type: n.type, prov: n.provenance }
        })),
        ...graph.edges.map((e) => ({
          data: { id: e.id, source: e.from, target: e.to, label: e.label, prov: e.provenance }
        }))
      ],
      style: [
        {
          selector: 'node',
          style: {
            'background-color': (el) => COLOR[el.data('type') as GraphNodeType] ?? '#8A8478',
            label: 'data(label)',
            color: '#E8E2D4',
            'font-family': 'Geist Mono Variable, monospace',
            'font-size': '9px',
            'text-valign': 'bottom',
            'text-margin-y': 5,
            width: 14,
            height: 14,
            'border-width': 1,
            'border-color': '#0F0E13'
          }
        },
        {
          // Lo inferido se dibuja hueco: se ve de un vistazo qué salió de un
          // dato duro y qué dedujo el modelo.
          selector: 'node[prov = "INFERRED"]',
          style: { 'background-opacity': 0.25, 'border-color': '#2A2833', 'border-width': 1.5 }
        },
        {
          selector: 'edge',
          style: {
            width: 1,
            'line-color': '#2A2833',
            'curve-style': 'bezier',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': '#2A2833',
            'arrow-scale': 0.6,
            label: 'data(label)',
            'font-family': 'Geist Mono Variable, monospace',
            'font-size': '7px',
            color: '#5A5650',
            'text-rotation': 'autorotate'
          }
        },
        {
          selector: 'node:selected',
          style: { 'border-color': '#C9973F', 'border-width': 3 }
        }
      ],
      // fcose acepta más opciones de las que declara el tipo base de cytoscape.
      layout: {
        name: 'fcose',
        nodeRepulsion: 9000,
        idealEdgeLength: 90
      } as cytoscape.LayoutOptions,
      wheelSensitivity: 0.2
    })

    cy.on('tap', 'node', (e) => onSelect(e.target.id() as string))
    cy.on('tap', (e) => {
      if (e.target === cy) onSelect(null)
    })

    cyRef.current = cy
    return () => {
      cy.destroy()
      cyRef.current = null
    }
  }, [graph, onSelect])

  return <div className="graph-canvas" ref={container} />
}
