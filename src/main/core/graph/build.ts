import { z } from 'zod'
import type { LlmProvider } from '../extraction/llm-port'
import type { ResultRow } from '../extraction/present'
import { emptyGraph, type Graph, type NodeType } from './types'
import { mergeContributions, type Contribution } from './merge'

/**
 * Cuántas extracciones van por llamada al CLI. Una por item sería 48 llamadas y
 * 48 veces la cuota; el modelo relaciona mejor viendo varias juntas.
 */
const BATCH_SIZE = 8

const TYPES: NodeType[] = ['person', 'company', 'event', 'payment', 'entity', 'topic', 'url', 'note']

const ResponseSchema = z.object({
  nodes: z
    .array(
      z.object({
        type: z.enum(TYPES as [NodeType, ...NodeType[]]),
        label: z.string(),
        attrs: z.record(z.string(), z.string()).default({})
      })
    )
    .default([]),
  edges: z
    .array(
      z.object({
        fromType: z.enum(TYPES as [NodeType, ...NodeType[]]),
        from: z.string(),
        toType: z.enum(TYPES as [NodeType, ...NodeType[]]),
        to: z.string(),
        label: z.string()
      })
    )
    .default([])
})

const INSTRUCTIONS = `Construís un grafo de conocimiento a partir de extracciones de las
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

function extractJson(raw: string): unknown {
  const clean = raw.replace(/\`\`\`(?:json)?/gi, '').trim()
  const i = clean.indexOf('{')
  const f = clean.lastIndexOf('}')
  if (i === -1 || f <= i) throw new Error('la respuesta no traía JSON')
  return JSON.parse(clean.slice(i, f + 1))
}

export interface BuildHooks {
  onBatch?: (done: number, total: number) => void
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
  now: string,
  hooks: BuildHooks = {}
): Promise<{ graph: Graph; failedBatches: number }> {
  const useful = rows.filter((r) => r.kind !== 'none' && r.kind !== 'failed' && r.summary.length > 0)

  const batches: ResultRow[][] = []
  for (let i = 0; i < useful.length; i += BATCH_SIZE) batches.push(useful.slice(i, i + BATCH_SIZE))

  let graph = emptyGraph(now)
  let failed = 0

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]

    const body = batch
      .map((r) => `- id: ${r.id}\n  tipo: ${r.kind}\n  contenido: ${r.summary}`)
      .join('\n')

    try {
      const raw = await provider.run(`${INSTRUCTIONS}\n\n--- EXTRACCIONES ---\n${body}`, model)
      const parsed = ResponseSchema.parse(extractJson(raw))

      // El modelo relaciona el lote entero, así que las fuentes son todo el lote.
      const contribution: Contribution = {
        nodes: parsed.nodes,
        edges: parsed.edges,
        // Todo lo que sale del modelo es INFERRED aunque la extracción original
        // fuera determinista: quien decidió que "Cristóbal" es una persona fue él.
        provenance: 'INFERRED',
        source: batch.map((r) => r.id).join(',')
      }

      graph = mergeContributions(graph, [contribution])
    } catch (error: unknown) {
      failed++
      const msg = error instanceof Error ? error.message : String(error)
      console.warn(`[graph] lote ${i + 1}/${batches.length} falló: ${msg}`)
    }

    hooks.onBatch?.(i + 1, batches.length)
  }

  return { graph, failedBatches: failed }
}
