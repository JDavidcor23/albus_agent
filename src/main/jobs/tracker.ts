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

export const COLUMNAS: (keyof TrackerRow)[] = [
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
export function csvEscape(valor: string): string {
  if (!/[",\n\r]/.test(valor)) return valor
  return `"${valor.replace(/"/g, '""')}"`
}

export function toCsvLine(row: TrackerRow): string {
  return COLUMNAS.map((c) => csvEscape(row[c] ?? '')).join(',')
}

/**
 * Parser mínimo pero correcto: el CSV real tiene campos con comas adentro
 * (la columna `notes` lleva el historial completo entre comillas). Partir por
 * coma acá devolvería columnas corridas y el dedupe leería cualquier cosa.
 */
export function parseCsv(texto: string): string[][] {
  const filas: string[][] = []
  let fila: string[] = []
  let campo = ''
  let enComillas = false

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]

    if (enComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"'
          i++
        } else {
          enComillas = false
        }
      } else {
        campo += c
      }
      continue
    }

    if (c === '"') {
      enComillas = true
    } else if (c === ',') {
      fila.push(campo)
      campo = ''
    } else if (c === '\n') {
      fila.push(campo)
      filas.push(fila)
      fila = []
      campo = ''
    } else if (c !== '\r') {
      campo += c
    }
  }

  if (campo !== '' || fila.length > 0) {
    fila.push(campo)
    filas.push(fila)
  }

  return filas
}

export function createCsvTracker(): TrackerSink {
  return {
    async append(row: TrackerRow): Promise<void> {
      const ruta = trackerPath()

      // Si el archivo no termina en salto, la fila nueva se pega a la anterior.
      const actual = await readFile(ruta, 'utf8').catch(() => '')
      const prefijo = actual === '' || actual.endsWith('\n') ? '' : '\n'

      await appendFile(ruta, `${prefijo}${toCsvLine(row)}\n`, 'utf8')
    },

    async seenUrls(): Promise<Set<string>> {
      const crudo = await readFile(trackerPath(), 'utf8').catch(() => '')
      if (crudo === '') return new Set()

      const filas = parseCsv(crudo)
      if (filas.length === 0) return new Set()

      const idx = filas[0].indexOf('source')
      if (idx === -1) return new Set()

      return new Set(
        filas
          .slice(1)
          .map((f) => (f[idx] ?? '').trim())
          .filter((u) => u !== '')
      )
    }
  }
}
