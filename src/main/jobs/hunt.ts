import type { LlmTier } from '../core/jobs/answers-llm'
import { applyFloor, rankJobs, type JobCandidate, type RankedJob } from '../core/jobs/rank'
import { notionStatus, scrubPii, type NotionRow } from '../core/jobs/notion-map'
import { isNotionConfigured } from '../notion/client'
import { knownPostLinks, upsertApplication } from '../notion/applications'
import { search, withDetail, dedupe, type SearchQuery } from './search'
import { loadProfile } from './workspace'

/**
 * "Buscame trabajos": scrapear, deduplicar, puntuar, guardar en Notion.
 *
 * El orden no es decorativo. Traer el detalle de una vacante es una request
 * HTTP y puntuarla cuesta cuota, así que las dos cosas pasan DESPUÉS del
 * dedupe: pagar por rankear una vacante a la que ya te postulaste es tirar
 * plata y tiempo.
 */

/** Las búsquedas por defecto. La UI las puede pisar. */
export const DEFAULT_QUERIES = [
  'frontend developer',
  'react developer',
  'full stack developer',
  'software engineer frontend'
]

/**
 * La escalera de antigüedad.
 *
 * El usuario NO tiene que elegir esto. Se lo preguntábamos —"últimos días"— y
 * su respuesta fue la correcta: "si voy a buscar trabajo, busco trabajo". Lo
 * que él quiere es un lote bueno; cuántos días haya que mirar para
 * conseguirlo es problema del programa.
 *
 * Se arranca por lo fresco, que es donde uno tiene ventaja de tiempo contra
 * los otros postulantes, y solo se abre el rango si el lote sale corto. Es la
 * misma regla que ya estaba escrita en el ritual del workspace: ampliar la
 * búsqueda ANTES que bajar la vara.
 */
const DAY_LADDER = [7, 14, 30]

/** Debajo de esto se amplía. Tres es el lote diario que el usuario definió. */
const TARGET_BATCH = 3

export interface HuntRequest {
  queries: string[]
  location: string
  /** Cuántas se rankean como mucho. Cada una cuesta un detalle + tokens. */
  maxRank: number
  llm: LlmTier
  /** Escribir las que califican en Notion como Backlog. */
  saveToNotion: boolean
  onProgress?: (phase: string, detail: string) => void
}

export interface HuntReport {
  found: number
  duplicates: number
  ranked: number
  qualified: RankedJob[]
  rejected: RankedJob[]
  notion: { writes: number; error: string | null }
  /** Explica en una línea por qué el lote salió como salió. */
  summary: string
}

export async function hunt(req: HuntRequest): Promise<HuntReport> {
  const step = (phase: string, detail: string): void => {
    console.log(`[hunt] ${phase}: ${detail}`)
    req.onProgress?.(phase, detail)
  }

  const profile = await loadProfile()

  // ── 1. sacar lo ya visto (una sola vez, antes de scrapear) ───────────────
  let inNotion = new Set<string>()
  if (req.saveToNotion && isNotionConfigured()) {
    try {
      inNotion = await knownPostLinks()
    } catch (error: unknown) {
      step('notion', `no pude leer la base para deduplicar: ${String(error)}`)
    }
  }

  // ── 2. buscar y puntuar, ampliando hasta juntar un lote ──────────────────
  //
  // La condición para ampliar es cuántas CALIFICAN, no cuántas aparecieron.
  // Son cosas distintas y confundirlas fue un error real: una vuelta trajo
  // once vacantes —de sobra para no ampliar— y ninguna daba la talla, así que
  // el usuario se quedó con cero y con el rango sin abrir. Encontrar mucho no
  // es encontrar algo bueno.
  const byUrl = new Map<string, JobCandidate>()
  const ranked: RankedJob[] = []
  const alreadyScored = new Set<string>()
  let duplicates = 0
  let daysUsed = DAY_LADDER[0]
  let skippedByCap = 0

  for (const days of DAY_LADDER) {
    daysUsed = days

    for (const query of req.queries) {
      step('buscando', days === DAY_LADDER[0] ? query : `${query} · últimos ${days} días`)
      try {
        const q: SearchQuery = {
          query,
          location: req.location,
          jobAgeDays: days,
          remote: 'remote',
          limit: 25
        }
        // El Map dedupe entre queries Y entre vueltas: la vuelta de 14 días
        // vuelve a traer todo lo de 7, y sin esto se pagaría el detalle dos veces.
        for (const c of await search(q)) byUrl.set(c.url, c)
      } catch (error: unknown) {
        // Un portal caído no puede tumbar la búsqueda entera.
        step('buscando', `"${query}" falló: ${String(error)}`)
      }
    }

    const r = await dedupe([...byUrl.values()], { notion: inNotion })
    duplicates = r.duplicates

    // Solo lo que apareció en esta vuelta y todavía no se puntuó: repuntuar
    // lo mismo es gastar cuota para llegar al mismo número.
    const pending = r.unseen.filter((c) => !alreadyScored.has(c.url))
    const budget = req.maxRank - ranked.length

    if (budget <= 0) {
      skippedByCap += pending.length
      step('tope', `llegué al tope de ${req.maxRank} vacantes puntuadas`)
      break
    }

    const toRank = pending.slice(0, budget)
    skippedByCap += pending.length - toRank.length

    if (toRank.length > 0) {
      step('leyendo', `${toRank.length} vacantes nuevas`)
      const withText = await withDetail(toRank)

      step('puntuando', `${withText.length} contra tu perfil`)
      ranked.push(...(await rankJobs(withText, profile, req.llm)))
      for (const c of toRank) alreadyScored.add(c.url)
    }

    const howMany = applyFloor(ranked).qualified.length
    step('criba', `${howMany} valen la pena de ${ranked.length} miradas`)

    if (howMany >= TARGET_BATCH) break
    if (days !== DAY_LADDER[DAY_LADDER.length - 1]) {
      step('ampliando', `con ${days} días junté ${howMany}, abro el rango`)
    }
  }

  const unique = [...byUrl.values()]
  step('encontradas', `${unique.length} únicas en los últimos ${daysUsed} días`)

  if (skippedByCap > 0) {
    // Un tope silencioso se lee como "no había más". Se dice.
    step('tope', `${skippedByCap} quedaron sin mirar por el tope de ${req.maxRank}`)
  }

  if (ranked.length === 0) {
    return {
      found: unique.length,
      duplicates,
      ranked: 0,
      qualified: [],
      rejected: [],
      notion: { writes: 0, error: null },
      summary: 'no hay nada nuevo: todo lo que salió ya lo habías visto'
    }
  }

  const { qualified, rejected } = applyFloor(ranked)

  // ── 4. espejo en Notion ──────────────────────────────────────────────────
  let writes = 0
  let notionError: string | null = null

  if (req.saveToNotion) {
    if (!isNotionConfigured()) {
      notionError = 'falta NOTION_TOKEN en .env'
    } else {
      for (const j of qualified) {
        try {
          await upsertApplication(rowFromRanked(j, scrubPii(j.reason, profile)))
          writes++
        } catch (error: unknown) {
          notionError = error instanceof Error ? error.message : String(error)
          step('notion', `falló ${j.company}: ${notionError}`)
        }
      }
    }
  }

  return {
    found: unique.length,
    duplicates,
    ranked: ranked.length,
    qualified,
    rejected,
    notion: { writes, error: notionError },
    summary: summarize(qualified.length, rejected.length, duplicates, daysUsed)
  }
}

function rowFromRanked(j: RankedJob, cleanReason: string): NotionRow {
  const status = notionStatus('ranked')
  if (status === null) throw new Error('estado "ranked" sin mapear')

  return {
    company: j.company,
    role: j.title,
    status,
    date: new Date().toISOString().slice(0, 10),
    fitScore: j.score,
    postLink: j.url,
    // Va la URL de la vacante, no un correo. La PII de contacto no entra acá.
    contactUrl: j.url,
    jobDescription: j.description.slice(0, 1200),
    coverLetter: '',
    nextAction: j.angle !== '' ? `Ángulo: ${j.angle}` : cleanReason
  }
}

/**
 * El mensaje dice la verdad incluso cuando es incómoda. "Encontré 1" es un
 * resultado; "encontré 3" habiendo rellenado con dos fits flojos es una
 * mentira que se paga con dos días de trabajo en CVs que no van a ningún lado.
 */
function summarize(
  qualified: number,
  rejected: number,
  duplicates: number,
  days: number
): string {
  // El rango solo se menciona si hubo que ampliarlo: si no, es ruido.
  const range = days === DAY_LADDER[0] ? '' : ` (miré hasta ${days} días atrás)`

  if (qualified === 0) {
    return `ninguna de las ${rejected} nuevas da la talla${range}. Probá con otras palabras de búsqueda: bajar la vara no sirve.`
  }
  if (qualified < TARGET_BATCH) {
    return `${qualified} valen la pena${range}. Son las que hay: no relleno el lote con fits flojos para llegar a tres.`
  }
  return `${qualified} valen la pena${range}, ${rejected} quedaron afuera, ${duplicates} ya las habías visto.`
}
