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

const cacheBun: { value: string | null | undefined } = { value: undefined }

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
const textoOpcional = z.string().nullish().transform((v) => v ?? '')

const ResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  company: z.string(),
  location: textoOpcional,
  date: textoOpcional,
  url: z.string()
})

const SearchSchema = z.object({ results: z.array(z.unknown()) })

const DetailSchema = z.object({
  description: textoOpcional,
  applyUrl: textoOpcional,
  seniority: textoOpcional,
  employmentType: textoOpcional
})

function cliPath(skill: string): string {
  return join(workspaceDir(), '.agents', 'skills', skill, 'cli', 'src', 'cli.ts')
}

async function bun(): Promise<string> {
  const bin = await resolveBinary('bun', cacheBun)
  if (bin === null) {
    throw new Error('bun no está en el PATH — los CLIs de búsqueda corren con bun')
  }
  return bin
}

async function correrCli(args: string[], etiqueta: string): Promise<string> {
  const bin = await bun()
  // Los argumentos son nuestros o vienen validados por zod. Nada del usuario
  // llega crudo a argv, y no se usa `exec` con strings armados a mano.
  const child = spawn(`"${bin}"`, ['run', ...args], {
    shell: true,
    windowsHide: true,
    cwd: workspaceDir(),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return collect(child, etiqueta, null)
}

/** Exportados para que el verificador los pruebe contra la forma real del CLI. */
export const SCHEMAS_INTERNOS = { ResultSchema, DetailSchema }

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
export async function buscar(q: SearchQuery): Promise<JobCandidate[]> {
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

  const salida = await correrCli(args, `linkedin-search "${q.query}"`)

  const lote = SearchSchema.safeParse(JSON.parse(salida))
  if (!lote.success) return []

  const candidatos: JobCandidate[] = []
  let salteadas = 0

  for (const cruda of lote.data.results) {
    const fila = ResultSchema.safeParse(cruda)
    if (!fila.success) {
      salteadas++
      continue
    }
    candidatos.push({ ...fila.data, description: '' })
  }

  if (salteadas > 0) console.warn(`[jobs] ${salteadas} resultado(s) con forma inesperada`)
  return candidatos
}

/**
 * Cuántos detalles se traen a la vez.
 *
 * Cada uno es un proceso de `bun` que arranca, hace una request y muere: en
 * serie, once vacantes tardaban 106 segundos y el usuario miraba una pantalla
 * quieta. Cuatro en paralelo lo bajan a un cuarto sin parecer un scraper
 * agresivo — que es justo lo que no queremos parecerle a LinkedIn.
 */
const DETALLES_EN_PARALELO = 4

/** Corre `fn` sobre todos, de a `limite`, conservando el orden de entrada. */
async function mapConLimite<T, R>(
  items: T[],
  limite: number,
  fn: (item: T, indice: number) => Promise<R>
): Promise<R[]> {
  const salida = new Array<R>(items.length)
  let siguiente = 0

  const obrero = async (): Promise<void> => {
    for (;;) {
      const i = siguiente++
      if (i >= items.length) return
      salida[i] = await fn(items[i], i)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, obrero))
  return salida
}

/**
 * Trae la descripción de cada vacante. Es una request por vacante, así que se
 * hace DESPUÉS del dedupe y solo sobre las que van a puntuarse.
 */
export async function conDetalle(candidatos: JobCandidate[]): Promise<JobCandidate[]> {
  return mapConLimite(candidatos, DETALLES_EN_PARALELO, async (c) => {
    try {
      const salida = await correrCli(
        [cliPath('linkedin-search'), 'detail', c.id, '--format', 'json'],
        `detail ${c.id}`
      )
      const d = DetailSchema.safeParse(JSON.parse(salida))
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

/** URLs que el workspace ya vio en corridas anteriores. */
export async function seenJobsUrls(): Promise<Set<string>> {
  try {
    const crudo = await readFile(join(workspaceDir(), 'job_scraper', 'seen_jobs.json'), 'utf8')
    const parsed = SeenSchema.safeParse(JSON.parse(crudo))
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
export function claveDedupe(url: string): string {
  const id = url.match(/(\d{8,})/)
  if (id !== null) return `li:${id[1]}`
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase()
}

export interface DedupeFuentes {
  /** Las de Notion. Vacío si no está configurado: no bloquea la búsqueda. */
  notion: Set<string>
}

export async function dedupe(
  candidatos: JobCandidate[],
  fuentes: DedupeFuentes
): Promise<{ nuevas: JobCandidate[]; repetidas: number }> {
  const vistas = new Set<string>()

  for (const url of await seenJobsUrls()) vistas.add(claveDedupe(url))
  for (const url of await createCsvTracker().seenUrls()) vistas.add(claveDedupe(url))
  for (const url of fuentes.notion) vistas.add(claveDedupe(url))

  const nuevas = candidatos.filter((c) => !vistas.has(claveDedupe(c.url)))
  return { nuevas, repetidas: candidatos.length - nuevas.length }
}
