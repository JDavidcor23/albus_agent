import { z } from 'zod'
import type { LlmProvider } from '../extraction/llm-port'
import type { ResultRow } from '../extraction/present'
import { emptyGraph, type Graph, type NodeType } from './types'
import { mergeContributions, type Contribution } from './merge'

/**
 * Cuántas extracciones van por llamada al CLI. Una por item sería 48 llamadas y
 * 48 veces la cuota; el modelo relaciona mejor viendo varias juntas.
 */
const LOTE = 8

const TIPOS: NodeType[] = ['person', 'company', 'event', 'payment', 'entity', 'topic', 'url', 'note']

const RespuestaSchema = z.object({
  nodes: z
    .array(
      z.object({
        type: z.enum(TIPOS as [NodeType, ...NodeType[]]),
        label: z.string(),
        attrs: z.record(z.string(), z.string()).default({})
      })
    )
    .default([]),
  edges: z
    .array(
      z.object({
        fromType: z.enum(TIPOS as [NodeType, ...NodeType[]]),
        from: z.string(),
        toType: z.enum(TIPOS as [NodeType, ...NodeType[]]),
        to: z.string(),
        label: z.string()
      })
    )
    .default([])
})

const INSTRUCCIONES = `Construís un grafo de conocimiento a partir de extracciones de las
notas personales de alguien. Cada extracción trae un id, un tipo y un resumen.

Devolvé SOLO un objeto JSON, sin markdown ni explicación:
{"nodes": [{"type","label","attrs"}], "edges": [{"fromType","from","toType","to","label"}]}

type de un nodo, uno de:
  person   una persona concreta con nombre
  company  empresa u organización
  event    charla, meetup, conferencia
  payment  un pago puntual
  entity   banco o medio de pago (Nequi, Bancolombia, PSE…)
  topic    tema recurrente (aws, serverless, buscar trabajo)
  url      enlace
  note     una idea o pendiente del usuario

label: el nombre tal como se lo llamaría en una conversación. Sin adornos.
attrs: pares string→string con lo que sepas (role, company, date, amount, url…).

edges: relaciones reales entre los nodos que devolviste. Ejemplos de label:
  trabaja_en · conoci_en · organiza · pagado_a · trata_de · enlaza_a

Reglas:
- NO inventes nombres, empresas ni fechas que no estén en el texto.
- Si una extracción no aporta ninguna entidad clara, no devuelvas nada por ella.
- Un mismo nombre escrito distinto es el mismo nodo: normalizá a la forma más completa.`

function extraerJson(bruto: string): unknown {
  const limpio = bruto.replace(/\`\`\`(?:json)?/gi, '').trim()
  const i = limpio.indexOf('{')
  const f = limpio.lastIndexOf('}')
  if (i === -1 || f <= i) throw new Error('la respuesta no traía JSON')
  return JSON.parse(limpio.slice(i, f + 1))
}

export interface BuildHooks {
  onBatch?: (hechos: number, total: number) => void
}

/**
 * Arma el grafo pasando las extracciones por el CLI. El análisis lo hace el
 * modelo, no la app: acá solo se lotea, se valida y se funde.
 *
 * Un lote que falla no tumba la construcción: se saltea y el grafo sale con lo
 * que sí se pudo.
 */
export async function buildGraph(
  rows: ResultRow[],
  provider: LlmProvider,
  model: string | null,
  ahora: string,
  hooks: BuildHooks = {}
): Promise<{ graph: Graph; lotesFallidos: number }> {
  const utiles = rows.filter((r) => r.kind !== 'none' && r.kind !== 'failed' && r.summary.length > 0)

  const lotes: ResultRow[][] = []
  for (let i = 0; i < utiles.length; i += LOTE) lotes.push(utiles.slice(i, i + LOTE))

  let grafo = emptyGraph(ahora)
  let fallidos = 0

  for (let i = 0; i < lotes.length; i++) {
    const lote = lotes[i]

    const cuerpo = lote
      .map((r) => `- id: ${r.id}\n  tipo: ${r.kind}\n  contenido: ${r.summary}`)
      .join('\n')

    try {
      const bruto = await provider.run(`${INSTRUCCIONES}\n\n--- EXTRACCIONES ---\n${cuerpo}`, model)
      const parsed = RespuestaSchema.parse(extraerJson(bruto))

      // El modelo relaciona el lote entero, así que las fuentes son todo el lote.
      const aporte: Contribution = {
        nodes: parsed.nodes,
        edges: parsed.edges,
        // Todo lo que sale del modelo es INFERRED aunque la extracción original
        // fuera determinista: quien decidió que "Cristóbal" es una persona fue él.
        provenance: 'INFERRED',
        source: lote.map((r) => r.id).join(',')
      }

      grafo = mergeContributions(grafo, [aporte])
    } catch (error: unknown) {
      fallidos++
      const msg = error instanceof Error ? error.message : String(error)
      console.warn(`[graph] lote ${i + 1}/${lotes.length} falló: ${msg}`)
    }

    hooks.onBatch?.(i + 1, lotes.length)
  }

  return { graph: grafo, lotesFallidos: fallidos }
}
