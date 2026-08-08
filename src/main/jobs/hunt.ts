import type { LlmTier } from '../core/jobs/answers-llm'
import { aplicarPiso, rankJobs, type JobCandidate, type RankedJob } from '../core/jobs/rank'
import { estadoNotion, scrubPii, type FilaNotion } from '../core/jobs/notion-map'
import { isNotionConfigured } from '../notion/client'
import { knownPostLinks, upsertApplication } from '../notion/applications'
import { buscar, conDetalle, dedupe, type SearchQuery } from './search'
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
export const QUERIES_POR_DEFECTO = [
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
const ESCALERA_DIAS = [7, 14, 30]

/** Debajo de esto se amplía. Tres es el lote diario que el usuario definió. */
const LOTE_OBJETIVO = 3

export interface HuntRequest {
  queries: string[]
  location: string
  /** Cuántas se rankean como mucho. Cada una cuesta un detalle + tokens. */
  maxRank: number
  llm: LlmTier
  /** Escribir las que califican en Notion como Backlog. */
  guardarEnNotion: boolean
  onProgress?: (fase: string, detalle: string) => void
}

export interface HuntReport {
  encontradas: number
  repetidas: number
  rankeadas: number
  califican: RankedJob[]
  descartadas: RankedJob[]
  notion: { escritas: number; error: string | null }
  /** Explica en una línea por qué el lote salió como salió. */
  resumen: string
}

export async function hunt(req: HuntRequest): Promise<HuntReport> {
  const paso = (fase: string, detalle: string): void => {
    console.log(`[hunt] ${fase}: ${detalle}`)
    req.onProgress?.(fase, detalle)
  }

  const profile = await loadProfile()

  // ── 1. sacar lo ya visto (una sola vez, antes de scrapear) ───────────────
  let enNotion = new Set<string>()
  if (req.guardarEnNotion && isNotionConfigured()) {
    try {
      enNotion = await knownPostLinks()
    } catch (error: unknown) {
      paso('notion', `no pude leer la base para deduplicar: ${String(error)}`)
    }
  }

  // ── 2. buscar y puntuar, ampliando hasta juntar un lote ──────────────────
  //
  // La condición para ampliar es cuántas CALIFICAN, no cuántas aparecieron.
  // Son cosas distintas y confundirlas fue un error real: una vuelta trajo
  // once vacantes —de sobra para no ampliar— y ninguna daba la talla, así que
  // el usuario se quedó con cero y con el rango sin abrir. Encontrar mucho no
  // es encontrar algo bueno.
  const porUrl = new Map<string, JobCandidate>()
  const rankeadas: RankedJob[] = []
  const yaPuntuadas = new Set<string>()
  let repetidas = 0
  let diasUsados = ESCALERA_DIAS[0]
  let sinPuntuarPorTope = 0

  for (const dias of ESCALERA_DIAS) {
    diasUsados = dias

    for (const query of req.queries) {
      paso('buscando', dias === ESCALERA_DIAS[0] ? query : `${query} · últimos ${dias} días`)
      try {
        const q: SearchQuery = {
          query,
          location: req.location,
          jobAgeDays: dias,
          remote: 'remote',
          limit: 25
        }
        // El Map dedupe entre queries Y entre vueltas: la vuelta de 14 días
        // vuelve a traer todo lo de 7, y sin esto se pagaría el detalle dos veces.
        for (const c of await buscar(q)) porUrl.set(c.url, c)
      } catch (error: unknown) {
        // Un portal caído no puede tumbar la búsqueda entera.
        paso('buscando', `"${query}" falló: ${String(error)}`)
      }
    }

    const r = await dedupe([...porUrl.values()], { notion: enNotion })
    repetidas = r.repetidas

    // Solo lo que apareció en esta vuelta y todavía no se puntuó: repuntuar
    // lo mismo es gastar cuota para llegar al mismo número.
    const pendientes = r.nuevas.filter((c) => !yaPuntuadas.has(c.url))
    const presupuesto = req.maxRank - rankeadas.length

    if (presupuesto <= 0) {
      sinPuntuarPorTope += pendientes.length
      paso('tope', `llegué al tope de ${req.maxRank} vacantes puntuadas`)
      break
    }

    const aRankear = pendientes.slice(0, presupuesto)
    sinPuntuarPorTope += pendientes.length - aRankear.length

    if (aRankear.length > 0) {
      paso('leyendo', `${aRankear.length} vacantes nuevas`)
      const conTexto = await conDetalle(aRankear)

      paso('puntuando', `${conTexto.length} contra tu perfil`)
      rankeadas.push(...(await rankJobs(conTexto, profile, req.llm)))
      for (const c of aRankear) yaPuntuadas.add(c.url)
    }

    const cuantasVan = aplicarPiso(rankeadas).califican.length
    paso('criba', `${cuantasVan} valen la pena de ${rankeadas.length} miradas`)

    if (cuantasVan >= LOTE_OBJETIVO) break
    if (dias !== ESCALERA_DIAS[ESCALERA_DIAS.length - 1]) {
      paso('ampliando', `con ${dias} días junté ${cuantasVan}, abro el rango`)
    }
  }

  const unicas = [...porUrl.values()]
  paso('encontradas', `${unicas.length} únicas en los últimos ${diasUsados} días`)

  if (sinPuntuarPorTope > 0) {
    // Un tope silencioso se lee como "no había más". Se dice.
    paso('tope', `${sinPuntuarPorTope} quedaron sin mirar por el tope de ${req.maxRank}`)
  }

  if (rankeadas.length === 0) {
    return {
      encontradas: unicas.length,
      repetidas,
      rankeadas: 0,
      califican: [],
      descartadas: [],
      notion: { escritas: 0, error: null },
      resumen: 'no hay nada nuevo: todo lo que salió ya lo habías visto'
    }
  }

  const { califican, descartadas } = aplicarPiso(rankeadas)

  // ── 4. espejo en Notion ──────────────────────────────────────────────────
  let escritas = 0
  let errorNotion: string | null = null

  if (req.guardarEnNotion) {
    if (!isNotionConfigured()) {
      errorNotion = 'falta NOTION_TOKEN en .env'
    } else {
      for (const j of califican) {
        try {
          await upsertApplication(filaDeRankeada(j, scrubPii(j.reason, profile)))
          escritas++
        } catch (error: unknown) {
          errorNotion = error instanceof Error ? error.message : String(error)
          paso('notion', `falló ${j.company}: ${errorNotion}`)
        }
      }
    }
  }

  return {
    encontradas: unicas.length,
    repetidas,
    rankeadas: rankeadas.length,
    califican,
    descartadas,
    notion: { escritas, error: errorNotion },
    resumen: resumir(califican.length, descartadas.length, repetidas, diasUsados)
  }
}

function filaDeRankeada(j: RankedJob, razonLimpia: string): FilaNotion {
  const estado = estadoNotion('ranked')
  if (estado === null) throw new Error('estado "ranked" sin mapear')

  return {
    company: j.company,
    role: j.title,
    estado,
    fecha: new Date().toISOString().slice(0, 10),
    fitScore: j.score,
    postLink: j.url,
    // Va la URL de la vacante, no un correo. La PII de contacto no entra acá.
    contactUrl: j.url,
    jobDescription: j.description.slice(0, 1200),
    coverLetter: '',
    proximaAccion: j.angle !== '' ? `Ángulo: ${j.angle}` : razonLimpia
  }
}

/**
 * El mensaje dice la verdad incluso cuando es incómoda. "Encontré 1" es un
 * resultado; "encontré 3" habiendo rellenado con dos fits flojos es una
 * mentira que se paga con dos días de trabajo en CVs que no van a ningún lado.
 */
function resumir(
  califican: number,
  descartadas: number,
  repetidas: number,
  dias: number
): string {
  // El rango solo se menciona si hubo que ampliarlo: si no, es ruido.
  const rango = dias === ESCALERA_DIAS[0] ? '' : ` (miré hasta ${dias} días atrás)`

  if (califican === 0) {
    return `ninguna de las ${descartadas} nuevas da la talla${rango}. Probá con otras palabras de búsqueda: bajar la vara no sirve.`
  }
  if (califican < LOTE_OBJETIVO) {
    return `${califican} valen la pena${rango}. Son las que hay: no relleno el lote con fits flojos para llegar a tres.`
  }
  return `${califican} valen la pena${rango}, ${descartadas} quedaron afuera, ${repetidas} ya las habías visto.`
}
