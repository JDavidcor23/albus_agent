import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TrackerRow, TrackerSink } from '../core/jobs/ports'
import { workspaceDir } from './workspace'

/**
 * `job_search_tracker.csv` es la fuente de verdad del usuario y ya tiene
 * historia adentro. Albus le agrega filas; no lo reescribe, no lo reordena y
 * no le cambia el encabezado. Un worker que le pisa el CSV al dueño del CSV
 * es un worker que se usa una vez.
 */

export const TRACKER_FILE = 'job_search_tracker.csv'

/**
 * The 13 header strings are FROZEN: they are the contract with the sibling
 * `ai-job-search` workspace, which this repo does not solely own. `'source'`
 * is the dedupe lookup key.
 */
export const COLUMNS: (keyof TrackerRow)[] = [
  'date',
  'company',
  'sector',
  'role',
  'roleType',
  'channel',
  'status',
  'contactPerson',
  'fitRating',
  'notes',
  'cvFile',
  'coverLetterFile',
  'source'
]

export function trackerPath(): string {
  return join(workspaceDir(), TRACKER_FILE)
}

/** Comillas solo cuando hacen falta, y las internas se duplican. Es RFC 4180. */
export function csvEscape(value: string): string {
  if (!/[",\n\r]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

export function toCsvLine(row: TrackerRow): string {
  return COLUMNS.map((c) => csvEscape(row[c] ?? '')).join(',')
}

/**
 * Parser mínimo pero correcto: el CSV real tiene campos con comas adentro
 * (la columna `notes` lleva el historial completo entre comillas). Partir por
 * coma acá devolvería columnas corridas y el dedupe leería cualquier cosa.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }

    if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') {
      field += c
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

export function createCsvTracker(): TrackerSink {
  return {
    async append(row: TrackerRow): Promise<void> {
      const path = trackerPath()

      // Si el archivo no termina en salto, la fila nueva se pega a la anterior.
      const current = await readFile(path, 'utf8').catch(() => '')
      const prefix = current === '' || current.endsWith('\n') ? '' : '\n'

      await appendFile(path, `${prefix}${toCsvLine(row)}\n`, 'utf8')
    },

    async seenUrls(): Promise<Set<string>> {
      const raw = await readFile(trackerPath(), 'utf8').catch(() => '')
      if (raw === '') return new Set()

      const rows = parseCsv(raw)
      if (rows.length === 0) return new Set()

      const idx = rows[0].indexOf('source')
      if (idx === -1) return new Set()

      return new Set(
        rows
          .slice(1)
          .map((r) => (r[idx] ?? '').trim())
          .filter((u) => u !== '')
      )
    }
  }
}
