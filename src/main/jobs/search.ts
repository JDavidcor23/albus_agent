import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { collect, resolveBinary } from '../providers/cli-common'
import type { JobCandidate } from '../core/jobs/rank'
import { workspaceDir } from './workspace'
import { createCsvTracker } from './tracker'

/**
 * La búsqueda vive en el workspace, no acá.
 *
 * `ai-job-search` ya tiene seis CLIs de portales, escritos, testeados y con su
 * propio parser de HTML. Albus los ejecuta; no los reimplementa. Cuando
 * LinkedIn cambie el markup se arregla en un solo lugar, que además es el que
 * el usuario ya sabe mantener.
 */

const bunCache: { value: string | null | undefined } = { value: undefined }

/**
 * `.nullish()` y no `.optional()`, y no es un detalle de estilo.
 *
 * `z.string().optional()` acepta `undefined` pero RECHAZA `null`, y el CLI
 * devuelve `null` en los campos que LinkedIn no publica — `date` y `applyUrl`
 * vienen así todo el tiempo. Con `.optional()` el `safeParse` del objeto
 * entero fallaba por un campo que ni usamos, y la descripción se perdía en
 * silencio: las tarjetas decían "sin descripción" con la descripción ahí,
 * en el JSON, intacta.
 *
 * Es el modo de falla más caro de esta clase de código: no tira, no loguea,
 * simplemente devuelve vacío y todo lo de abajo se degrada.
 */
const optionalText = z
  .string()
  .nullish()
  .transform((v) => v ?? '')

const ResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  company: z.string(),
  location: optionalText,
  date: optionalText,
  url: z.string()
})

const SearchSchema = z.object({ results: z.array(z.unknown()) })

const DetailSchema = z.object({
  description: optionalText,
  applyUrl: optionalText,
  seniority: optionalText,
  employmentType: optionalText
})

function cliPath(skill: string): string {
  return join(workspaceDir(), '.agents', 'skills', skill, 'cli', 'src', 'cli.ts')
}

async function bun(): Promise<string> {
  const bin = await resolveBinary('bun', bunCache)
  if (bin === null) {
    throw new Error('bun no está en el PATH — los CLIs de búsqueda corren con bun')
  }
  return bin
}

async function runCli(args: string[], label: string): Promise<string> {
  const bin = await bun()
  // Los argumentos son nuestros o vienen validados por zod. Nada del usuario
  // llega crudo a argv, y no se usa `exec` con strings armados a mano.
  const child = spawn(`"${bin}"`, ['run', ...args], {
    shell: true,
    windowsHide: true,
    cwd: workspaceDir(),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return collect(child, label, null)
}

/** Exportados para que el verificador los pruebe contra la forma real del CLI. */
export const INTERNAL_SCHEMAS = { ResultSchema, DetailSchema }

export interface SearchQuery {
  query: string
  location: string
  jobAgeDays: number
  remote: 'remote' | 'hybrid' | 'onsite' | null
  limit: number
}

/**
 * Valida FILA POR FILA, no el lote entero. Una vacante con un campo raro no
 * puede costar la búsqueda completa — misma regla que rige la extracción.
 */
export async function search(q: SearchQuery): Promise<JobCandidate[]> {
  const args = [
    cliPath('linkedin-search'),
    'search',
    '--query',
    q.query,
    '--location',
    q.location,
    '--format',
    'json',
    '--limit',
    String(q.limit)
  ]
  if (q.jobAgeDays > 0) args.push('--jobage', String(q.jobAgeDays))
  if (q.remote !== null) args.push('--remote', q.remote)

  const output = await runCli(args, `linkedin-search "${q.query}"`)

  const batch = SearchSchema.safeParse(JSON.parse(output))
  if (!batch.success) return []

  const candidates: JobCandidate[] = []
  let skipped = 0

  for (const raw of batch.data.results) {
    const row = ResultSchema.safeParse(raw)
    if (!row.success) {
      skipped++
      continue
    }
    candidates.push({ ...row.data, description: '' })
  }

  if (skipped > 0) console.warn(`[jobs] ${skipped} resultado(s) con forma inesperada`)
  return candidates
}

/**
 * Cuántos detalles se traen a la vez.
 *
 * Cada uno es un proceso de `bun` que arranca, hace una request y muere: en
 * serie, once vacantes tardaban 106 segundos y el usuario miraba una pantalla
 * quieta. Cuatro en paralelo lo bajan a un cuarto sin parecer un scraper
 * agresivo — que es justo lo que no queremos parecerle a LinkedIn.
 */
const DETAILS_IN_PARALLEL = 4

/** Corre `fn` sobre todos, de a `limit`, conservando el orden de entrada. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const output = new Array<R>(items.length)
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      output[i] = await fn(items[i], i)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return output
}

/**
 * Trae la descripción de cada vacante. Es una request por vacante, así que se
 * hace DESPUÉS del dedupe y solo sobre las que van a puntuarse.
 */
export async function withDetail(candidates: JobCandidate[]): Promise<JobCandidate[]> {
  return mapWithLimit(candidates, DETAILS_IN_PARALLEL, async (c) => {
    try {
      const output = await runCli(
        [cliPath('linkedin-search'), 'detail', c.id, '--format', 'json'],
        `detail ${c.id}`
      )
      const d = DetailSchema.safeParse(JSON.parse(output))
      if (!d.success) {
        // Ruidoso: que el detalle no parsee degrada TODAS las tarjetas y el
        // ranking, y sin este log el síntoma es "sin descripción" sin causa.
        console.warn(`[jobs] el detalle de ${c.id} no parseó: ${d.error.message.slice(0, 200)}`)
        return c
      }
      return { ...c, description: d.data.description }
    } catch (error: unknown) {
      // Una vacante sin detalle se puntúa por el título con confianza baja. No
      // frena el lote: es exactamente el caso que el prompt contempla.
      console.warn(`[jobs] sin detalle para ${c.id}: ${String(error)}`)
      return c
    }
  })
}

const SeenSchema = z.object({ seen: z.record(z.string(), z.unknown()) })

/**
 * URLs que el workspace ya vio en corridas anteriores.
 *
 * `job_scraper/seen_jobs.json` y su clave `seen` son FROZEN: pertenecen al
 * workspace hermano `ai-job-search`.
 */
export async function seenJobsUrls(): Promise<Set<string>> {
  try {
    const raw = await readFile(join(workspaceDir(), 'job_scraper', 'seen_jobs.json'), 'utf8')
    const parsed = SeenSchema.safeParse(JSON.parse(raw))
    return parsed.success ? new Set(Object.keys(parsed.data.seen)) : new Set()
  } catch {
    return new Set()
  }
}

/**
 * Las URLs de LinkedIn vienen con host variable (`co.`, `es.`, `www.`) y con
 * el slug del puesto adelante. Lo único estable es el id numérico del final:
 * comparar strings enteros haría que la misma vacante entre dos veces.
 */
export function dedupeKey(url: string): string {
  const id = url.match(/(\d{8,})/)
  if (id !== null) return `li:${id[1]}`
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase()
}

export interface DedupeSources {
  /** Las de Notion. Vacío si no está configurado: no bloquea la búsqueda. */
  notion: Set<string>
}

export async function dedupe(
  candidates: JobCandidate[],
  sources: DedupeSources
): Promise<{ unseen: JobCandidate[]; duplicates: number }> {
  const seen = new Set<string>()

  for (const url of await seenJobsUrls()) seen.add(dedupeKey(url))
  for (const url of await createCsvTracker().seenUrls()) seen.add(dedupeKey(url))
  for (const url of sources.notion) seen.add(dedupeKey(url))

  const unseen = candidates.filter((c) => !seen.has(dedupeKey(c.url)))
  return { unseen, duplicates: candidates.length - unseen.length }
}
