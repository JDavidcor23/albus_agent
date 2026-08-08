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
export const QUALITY_FLOOR = 65

export interface Sieve {
  qualified: RankedJob[]
  rejected: RankedJob[]
}

/**
 * Puro y sin tope: NO recorta a tres. Quién toma cuántas es decisión de quien
 * llama, y así el assert puede probar que con dos candidatas buenas devuelve
 * dos y no inventa una tercera.
 */
export function applyFloor(ranked: RankedJob[]): Sieve {
  const qualified: RankedJob[] = []
  const rejected: RankedJob[] = []

  for (const j of ranked) {
    if (j.score >= QUALITY_FLOOR && j.gates.length === 0) qualified.push(j)
    else rejected.push(j)
  }

  qualified.sort((a, b) => b.score - a.score)
  rejected.sort((a, b) => b.score - a.score)
  return { qualified, rejected }
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

export function buildRankPrompt(candidates: JobCandidate[], p: CandidateProfile): string {
  const years = Object.entries(p.yearsExperience)
    .filter(([k]) => k !== 'default')
    .map(([k, v]) => `${k} ${v}a`)
    .join(', ')

  const jobs = candidates
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
${jobs}

Devolvé SOLO este JSON, sin markdown:
{"jobs":[{"id":"...","score":72,"gates":[],"reason":"una oración","angle":"una oración"}]}`
}

function extractJson(text: string): unknown {
  const clean = text.replace(/^```(?:json)?/gm, '').replace(/```$/gm, '')
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('el modelo no devolvió JSON')
  return JSON.parse(clean.slice(start, end + 1))
}

/**
 * Nunca tira. Si el modelo falla, todo vuelve con score 0 y la razón puesta —
 * el usuario ve "no pude puntuar" en vez de un lote vacío sin explicación.
 */
export async function rankJobs(
  candidates: JobCandidate[],
  p: CandidateProfile,
  tier: LlmTier
): Promise<RankedJob[]> {
  if (candidates.length === 0) return []

  const unscored = (reason: string): RankedJob[] =>
    candidates.map((c) => ({ ...c, score: 0, gates: [], reason, angle: '' }))

  let batch: z.infer<typeof RankSchema>
  try {
    const output = await tier.provider.run(buildRankPrompt(candidates, p), tier.model)
    batch = RankSchema.parse(extractJson(output))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[jobs] el ranking falló: ${message}`)
    return unscored(`no se pudo puntuar: ${message}`)
  }

  const byId = new Map(batch.jobs.map((j) => [j.id, j]))

  return candidates.map((c) => {
    const j = byId.get(c.id)
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
