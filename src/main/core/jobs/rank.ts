import { z } from 'zod'
import type { LlmTier } from './answers-llm'
import type { CandidateProfile } from './types'

/**
 * El triage. Puntúa vacantes contra el perfil y aplica el piso de calidad que
 * el usuario ya tenía escrito en su workspace.
 *
 * La regla que importa y que es fácil de romper sin querer: **si califican
 * menos de tres, se entregan las que hay.** Rellenar el lote con fits flojos
 * para llegar al número es exactamente lo que hace que uno mande veinte
 * postulaciones y no le contesten ninguna. El filtro es puro y tiene un assert
 * que lo verifica.
 */

export interface JobCandidate {
  id: string
  title: string
  company: string
  location: string
  date: string
  url: string
  /** La descripción completa. Vacía si no se pudo traer el detalle. */
  description: string
}

/** Los cortes duros del workspace. Cualquiera de estos descalifica sin importar el puntaje. */
export const HARD_GATES = [
  'requires-relocation',
  'salary-below-floor',
  'wrong-core-stack',
  'seniority-bar',
  'hostile-timezone'
] as const

export type HardGate = (typeof HARD_GATES)[number]

export interface RankedJob extends JobCandidate {
  score: number
  gates: HardGate[]
  reason: string
  /** Qué de la vacante engancha con el perfil. Alimenta el CV y la carta. */
  angle: string
}

/** El piso del workspace: 65 o más, y ningún corte duro. */
export const PISO_CALIDAD = 65

export interface Criba {
  califican: RankedJob[]
  descartadas: RankedJob[]
}

/**
 * Puro y sin tope: NO recorta a tres. Quién toma cuántas es decisión de quien
 * llama, y así el assert puede probar que con dos candidatas buenas devuelve
 * dos y no inventa una tercera.
 */
export function aplicarPiso(rankeadas: RankedJob[]): Criba {
  const califican: RankedJob[] = []
  const descartadas: RankedJob[] = []

  for (const j of rankeadas) {
    if (j.score >= PISO_CALIDAD && j.gates.length === 0) califican.push(j)
    else descartadas.push(j)
  }

  califican.sort((a, b) => b.score - a.score)
  descartadas.sort((a, b) => b.score - a.score)
  return { califican, descartadas }
}

/** Recorte del texto de la vacante que va al prompt. Suficiente para juzgar. */
export const MAX_DESC = 1400

const RankSchema = z.object({
  jobs: z.array(
    z.object({
      id: z.string(),
      score: z.number().min(0).max(100),
      gates: z.array(z.string()),
      reason: z.string(),
      angle: z.string().default('')
    })
  )
})

export function buildRankPrompt(candidatos: JobCandidate[], p: CandidateProfile): string {
  const years = Object.entries(p.yearsExperience)
    .filter(([k]) => k !== 'default')
    .map(([k, v]) => `${k} ${v}a`)
    .join(', ')

  const vacantes = candidatos
    .map(
      (c, i) =>
        `### ${i + 1} · id=${c.id}\n` +
        `${c.title} — ${c.company} (${c.location}, ${c.date})\n` +
        (c.description === ''
          ? '(sin descripción: puntuá solo por el título y bajá la confianza)'
          : c.description.slice(0, MAX_DESC))
    )
    .join('\n\n')

  return `Sos el filtro de un buscador de trabajo. Puntuás vacantes contra un perfil concreto y sos DURO: el candidato tiene tiempo para tres postulaciones buenas por día, no para veinte flojas.

PERFIL
${p.currentTitle} con ${p.yearsExperience.default} años. Stack: ${years}.
Ubicación: ${p.city}, ${p.country}. Solo remoto: ${p.remoteOnly}. Se muda: ${p.willingToRelocate}.
Piso salarial: USD ${p.expectedSalaryUsdMonthly}/mes. Inglés: ${p.englishLevel}.
Educación: ${p.highestEducation} (NO tiene título universitario).

CORTES DUROS — si aplica alguno, ponelo en "gates" y el puntaje no importa:
- requires-relocation : exige mudarse o presencial fuera de ${p.city}
- salary-below-floor  : banda visible por debajo de USD 3000/mes
- wrong-core-stack    : el núcleo del rol es un stack que el perfil no tiene (Python, Java, .NET, PHP, Ruby, Go, móvil nativo, data/ML)
- seniority-bar       : pide más años de los que tiene, o título universitario obligatorio
- hostile-timezone    : exige solaparse con una zona horaria imposible desde Colombia (APAC, Europa full)

PUNTAJE 0-100
  85-100  encaja casi perfecto: stack, seniority y modalidad alineados
  65-84   buen fit con alguna brecha manejable
  40-64   fit dudoso: le falta algo central
  0-39    no es para él

Sé severo con el 65: es el corte entre "vale la pena escribir un CV a medida" y "no". Ante la duda, bajá.

"angle": en una oración, qué de SU experiencia es lo más fuerte contra ESTA vacante. Sale de lo que el perfil dice, no de lo que la vacante pide.

VACANTES
${vacantes}

Devolvé SOLO este JSON, sin markdown:
{"jobs":[{"id":"...","score":72,"gates":[],"reason":"una oración","angle":"una oración"}]}`
}

function extraerJson(texto: string): unknown {
  const limpio = texto.replace(/^```(?:json)?/gm, '').replace(/```$/gm, '')
  const inicio = limpio.indexOf('{')
  const fin = limpio.lastIndexOf('}')
  if (inicio === -1 || fin <= inicio) throw new Error('el modelo no devolvió JSON')
  return JSON.parse(limpio.slice(inicio, fin + 1))
}

/**
 * Nunca tira. Si el modelo falla, todo vuelve con score 0 y la razón puesta —
 * el usuario ve "no pude puntuar" en vez de un lote vacío sin explicación.
 */
export async function rankJobs(
  candidatos: JobCandidate[],
  p: CandidateProfile,
  tier: LlmTier
): Promise<RankedJob[]> {
  if (candidatos.length === 0) return []

  const sinPuntuar = (razon: string): RankedJob[] =>
    candidatos.map((c) => ({ ...c, score: 0, gates: [], reason: razon, angle: '' }))

  let lote: z.infer<typeof RankSchema>
  try {
    const salida = await tier.provider.run(buildRankPrompt(candidatos, p), tier.model)
    lote = RankSchema.parse(extraerJson(salida))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[jobs] el ranking falló: ${message}`)
    return sinPuntuar(`no se pudo puntuar: ${message}`)
  }

  const porId = new Map(lote.jobs.map((j) => [j.id, j]))

  return candidatos.map((c) => {
    const j = porId.get(c.id)
    if (j === undefined) {
      return { ...c, score: 0, gates: [], reason: 'el modelo no la puntuó', angle: '' }
    }

    // Un gate que el modelo se inventó no descalifica: la lista es cerrada.
    const gates = j.gates.filter((g): g is HardGate =>
      (HARD_GATES as readonly string[]).includes(g)
    )

    return { ...c, score: j.score, gates, reason: j.reason, angle: j.angle }
  })
}
