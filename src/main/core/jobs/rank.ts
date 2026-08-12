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

/**
 * Lo que el usuario escribió bajo `## Qué NO quiero` en su `.md`.
 *
 * La plantilla le promete, con esas palabras, que *"el agente lo respeta"*, y
 * durante todo este tiempo esa sección no llegaba a ningún lado: el prompt solo
 * veía el perfil. Escribir "nada con Java" y que igual te aparezcan vacantes de
 * Java es peor que no tener el campo, porque el usuario cree que está filtrado.
 *
 * Va DESPUÉS de la escala de puntaje y antes de las vacantes: es lo último que
 * el modelo lee antes de los datos.
 */
function avoidBlock(avoid: string[]): string {
  if (avoid.length === 0) return ''

  return `
LO QUE EL CANDIDATO NO QUIERE — lo escribió él, pesa MÁS que el fit técnico:
${avoid.map((a) => `- ${a}`).join('\n')}
Si una vacante choca con algo de esa lista, dejala abajo de 65 aunque encaje
bien en lo demás, y decilo en "reason". Si además cae en un corte duro de los
de arriba, poné el gate.
`
}

export function buildRankPrompt(
  candidates: JobCandidate[],
  p: CandidateProfile,
  avoid: string[] = []
): string {
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
${avoidBlock(avoid)}
VACANTES
${jobs}

Devolvé SOLO este JSON, sin markdown, con EXACTAMENTE ${candidates.length} entrada(s) en "jobs": una por cada vacante de arriba, con su id tal cual, en el mismo orden. No omitas ninguna ni agregues ids que no estén en la lista. Si una no te convence, va igual con puntaje bajo — omitirla NO es descartarla.
Sé breve en "reason" y "angle": una oración corta cada uno. Es preferible que entren las ${candidates.length} a que dos queden lindas y el resto se corte.
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
 * Cuántas vacantes entran en UNA llamada al modelo.
 *
 * El prompt lleva todas las candidatas juntas y espera un JSON con una entrada
 * por cada una. Eso no escala: con cuarenta, la respuesta se corta a la mitad,
 * `RankSchema.parse` tira, y `unscored()` devuelve las CUARENTA con score 0 —
 * el usuario ve "califican 0 de 40" y no hay forma de distinguirlo de un lote
 * genuinamente malo. Y el modo silencioso es peor: si el modelo devuelve
 * treinta y omite diez, esas diez quedan en `'el modelo no la puntuó'`.
 *
 * En lotes chicos, un lote que falla se lleva diez y no cuarenta, y las demás
 * conservan su puntaje.
 */
export const RANK_BATCH = 10

/** Parte en lotes de `RANK_BATCH`, conservando el orden. */
function chunk(items: JobCandidate[]): JobCandidate[][] {
  const out: JobCandidate[][] = []
  for (let i = 0; i < items.length; i += RANK_BATCH) out.push(items.slice(i, i + RANK_BATCH))
  return out
}

type Scored = z.infer<typeof RankSchema>['jobs'][number]

/**
 * Cuántas veces se vuelve a pedir lo que el modelo dejó afuera.
 *
 * Un modelo al que le pasás diez vacantes puede devolverte tres. No es un
 * error que se pueda detectar como error: la respuesta es JSON válido y el
 * schema pasa — simplemente faltan ids. Esas quedaban en "el modelo no la
 * puntuó" con score 0, indistinguibles de una vacante mala, y así se perdió
 * una que en la corrida anterior había sacado 78.
 *
 * Los faltantes se vuelven a pedir solos, en un lote más chico. Dos vueltas
 * alcanzan: si a la tercera sigue sin devolverla, el problema no es el tamaño.
 */
const MAX_REFILLS = 2

/** Una llamada. `null` = falló de verdad (no hubo JSON), distinto de "faltan". */
async function askModel(
  candidates: JobCandidate[],
  p: CandidateProfile,
  tier: LlmTier,
  avoid: string[]
): Promise<Map<string, Scored> | { error: string }> {
  try {
    const output = await tier.provider.run(buildRankPrompt(candidates, p, avoid), tier.model)
    const batch = RankSchema.parse(extractJson(output))
    return new Map(batch.jobs.map((j) => [j.id, j]))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[jobs] el ranking falló: ${message}`)
    return { error: message }
  }
}

/**
 * Un lote, con recuperación de lo que el modelo se saltee.
 *
 * Nunca tira: lo que no se pudo puntuar vuelve con score 0 y el motivo puesto.
 */
async function rankOne(
  candidates: JobCandidate[],
  p: CandidateProfile,
  tier: LlmTier,
  avoid: string[]
): Promise<RankedJob[]> {
  const found = new Map<string, Scored>()
  let missing = candidates
  let failure = ''

  for (let round = 0; round <= MAX_REFILLS && missing.length > 0; round++) {
    const got = await askModel(missing, p, tier, avoid)

    if ('error' in got) {
      // Falla dura: no hubo JSON. Reintentar lo mismo va a fallar igual.
      failure = got.error
      break
    }

    for (const [id, j] of got) if (!found.has(id)) found.set(id, j)

    const before = missing.length
    missing = missing.filter((c) => !found.has(c.id))
    if (missing.length === 0) break

    // Se dice, y con nombre: el síntoma en pantalla era "el modelo no la
    // puntuó" sin ninguna pista de por qué ni de cuántas.
    console.warn(
      `[jobs] el modelo devolvió ${before - missing.length} de ${before}; ` +
        `vuelvo a pedir ${missing.length}: ${missing.map((c) => c.title).join(', ')}`
    )
  }

  return candidates.map((c) => {
    const j = found.get(c.id)
    if (j === undefined) {
      return {
        ...c,
        score: 0,
        gates: [],
        reason:
          failure !== ''
            ? `no se pudo puntuar: ${failure}`
            : `el modelo la omitió ${MAX_REFILLS + 1} veces — no es un puntaje bajo, es que no la miró`,
        angle: ''
      }
    }

    // Un gate que el modelo se inventó no descalifica: la lista es cerrada.
    const gates = j.gates.filter((g): g is HardGate =>
      (HARD_GATES as readonly string[]).includes(g)
    )

    return { ...c, score: j.score, gates, reason: j.reason, angle: j.angle }
  })
}

/**
 * Puntúa TODAS las candidatas, en lotes.
 *
 * Nunca tira. Si un lote falla, esas vuelven con score 0 y la razón puesta —
 * el usuario ve "no pude puntuar" en vez de un lote vacío sin explicación—, y
 * los demás lotes conservan su puntaje.
 *
 * En SERIE y no en paralelo: cada lote es un proceso de CLI hablando con la
 * API del proveedor, y cuatro a la vez es la forma más rápida de comerse un
 * rate limit. Acá la prisa no paga: el barrido ya tarda minutos por el
 * scraping, y un 429 arruina la corrida entera.
 */
export async function rankJobs(
  candidates: JobCandidate[],
  p: CandidateProfile,
  tier: LlmTier,
  avoid: string[] = [],
  onBatch?: (done: number, total: number) => void
): Promise<RankedJob[]> {
  if (candidates.length === 0) return []

  const batches = chunk(candidates)
  const ranked: RankedJob[] = []

  for (const [i, batch] of batches.entries()) {
    onBatch?.(i + 1, batches.length)
    ranked.push(...(await rankOne(batch, p, tier, avoid)))
  }

  return ranked
}
