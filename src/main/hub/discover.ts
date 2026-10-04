import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { agentsCodeDir } from '../paths'
import { parseAgentJson, type AgentManifest } from '../core/hub/manifest'
import { resolveBinary } from '../providers/cli-common'

/**
 * Every subfolder of `agents/` is one external agent, valid or not.
 *
 * A broken `agent.json` is listed WITH its problem, never hidden — same rule
 * as a broken `.md` rules file or a corrupt `.agente.json`: "a hidden agent
 * is an agent the user believes never existed" (`.claude/docs/agents.md`).
 */
export interface ExternalAgentEntry {
  /** The folder name. Equals `manifest.id` when the manifest is valid. */
  id: string
  dir: string
  manifest: AgentManifest | null
  /** Empty string = healthy. Non-empty = why it is listed but not runnable. */
  problem: string
}

const nodeCache: { value: string | null | undefined } = { value: undefined }

function readManifest(dir: string, folderName: string): { manifest: AgentManifest | null; problem: string } {
  const manifestFile = join(dir, 'agent.json')
  if (!existsSync(manifestFile)) return { manifest: null, problem: 'missing agent.json' }

  let raw: string
  try {
    raw = readFileSync(manifestFile, 'utf8')
  } catch (error: unknown) {
    return { manifest: null, problem: `cannot read agent.json: ${String(error)}` }
  }

  const parsed = parseAgentJson(folderName, raw)
  if (!parsed.ok) return { manifest: null, problem: parsed.reason }
  return { manifest: parsed.manifest, problem: '' }
}

function availabilityProblem(dir: string, nodeAvailable: boolean): string {
  if (!nodeAvailable) return 'node is not resolvable on PATH'

  const hasPackageJson = existsSync(join(dir, 'package.json'))
  const hasNodeModules = existsSync(join(dir, 'node_modules'))
  if (hasPackageJson && !hasNodeModules) return 'dependencies not installed'

  return ''
}

/**
 * Lists every agent folder. Never throws, never skips a broken one. `hubDir`
 * lets checks isolate by parameter instead of mutating `ALBUS_AGENTS_HUB_DIR` —
 * see the note on test isolation in `.claude/docs/frozen-contracts.md` §5.
 */
export async function listExternalAgents(hubDir?: string): Promise<ExternalAgentEntry[]> {
  const codeDir = hubDir !== undefined ? join(hubDir, 'agents') : agentsCodeDir()
  if (!existsSync(codeDir)) return []

  let names: string[]
  try {
    names = readdirSync(codeDir)
  } catch {
    return []
  }

  const nodeBin = await resolveBinary('node', nodeCache)

  const entries: ExternalAgentEntry[] = []
  for (const name of names) {
    // A leading dot is our own staging folder (`.staging-xxxx`), never a real agent.
    if (name.startsWith('.')) continue

    const dir = join(codeDir, name)
    let isDirectory = false
    try {
      isDirectory = statSync(dir).isDirectory()
    } catch {
      continue
    }
    if (!isDirectory) continue

    const { manifest, problem } = readManifest(dir, name)
    const finalProblem = problem !== '' ? problem : availabilityProblem(dir, nodeBin !== null)

    entries.push({ id: name, dir, manifest, problem: finalProblem })
  }

  // Stable order: a list that reshuffles itself between opens reads as a bug.
  return entries.sort((a, b) => a.id.localeCompare(b.id))
}
