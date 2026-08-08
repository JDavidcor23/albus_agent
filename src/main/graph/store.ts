import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Graph } from '../core/graph/types'

/**
 * El grafo NO vive en el repo ni en la nube: es un artefacto del usuario.
 * Por defecto va al Escritorio, en una carpeta que puede abrir y llevarse.
 *
 * Se respeta ALBUS_GRAPH_DIR si está en el .env, para poder moverlo sin tocar código.
 */
export function graphDir(): string {
  const override = process.env.ALBUS_GRAPH_DIR
  if (override !== undefined && override.trim().length > 0) return override.trim()

  return join(app.getPath('desktop'), 'albus-graph')
}

export function graphPath(): string {
  return join(graphDir(), 'graph.json')
}

export function saveGraph(graph: Graph): string {
  const dir = graphDir()
  mkdirSync(dir, { recursive: true })

  const path = join(dir, 'graph.json')
  writeFileSync(path, JSON.stringify(graph, null, 2), 'utf8')
  return path
}

/** null si todavía no se construyó ninguno. */
export function loadGraph(): Graph | null {
  const path = graphPath()
  if (!existsSync(path)) return null

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Graph
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`[graph] no se pudo leer ${path}: ${msg}`)
    return null
  }
}
