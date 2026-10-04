import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { agentResultsDir } from '../paths'

export interface ResultFile {
  /** Relative to the agent's results folder — what the UI shows and what `resolveInsideResults` accepts back. */
  relPath: string
  absPath: string
  size: number
  modifiedAt: string
}

const MAX_DEPTH = 3

function resultsRoot(agentId: string, hubDir?: string): string {
  return hubDir !== undefined ? join(hubDir, 'results', agentId) : agentResultsDir(agentId)
}

function walk(dir: string, root: string, depth: number, out: ResultFile[]): void {
  if (depth > MAX_DEPTH) return

  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }

  for (const name of names) {
    if (name.startsWith('.')) continue

    const full = join(dir, name)
    let isDirectory = false
    let stat
    try {
      stat = statSync(full)
      isDirectory = stat.isDirectory()
    } catch {
      continue
    }

    if (isDirectory) {
      walk(full, root, depth + 1, out)
    } else if (stat.isFile()) {
      out.push({
        relPath: relative(root, full),
        absPath: full,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      })
    }
  }
}

/** Newest first. `hubDir` isolates checks by parameter — see `frozen-contracts.md` §5. */
export function listResults(agentId: string, hubDir?: string, limit = 30): ResultFile[] {
  const root = resultsRoot(agentId, hubDir)
  const out: ResultFile[] = []
  walk(root, root, 0, out)
  out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0))
  return out.slice(0, limit)
}

/**
 * Resolves a relative path the UI wants to open back into an absolute one,
 * refusing anything that would escape the results folder. Same shape of
 * check as `resolveResultPath` in `core/hub/protocol.ts`, here for a path
 * that comes from the renderer instead of from the agent's stdout.
 */
export function resolveInsideResults(agentId: string, rel: string, hubDir?: string): string | null {
  const root = resultsRoot(agentId, hubDir)
  const absolute = resolve(root, rel)
  const relFromRoot = relative(root, absolute)
  if (relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) return null
  return absolute
}
