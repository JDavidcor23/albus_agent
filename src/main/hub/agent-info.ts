import type { AgentInfo } from '../../shared/ipc'
import { pending, toAgentQuestion } from '../agents/questions'
import { readRules } from '../agents/rules'
import { agentResultsDir } from '../paths'
import { listExternalAgents } from './discover'
import { activeRuns } from './runner'

/**
 * Turns every folder under `agents-hub/agents/` into an `AgentInfo`, the same
 * shape `agents/registry.ts` builds for the builtin ones.
 *
 * Lives here and not in `registry.ts` so that file stays about the builtin
 * registry and does not grow a second, unrelated discovery mechanism inline —
 * `registry.ts` only appends what this returns.
 *
 * The rules `.md` and question queue apply identically to an external agent:
 * it gets `AGENT_RULES_PATH` in its environment (`core/hub/env.ts`) pointing
 * at the exact same file `readRules`/`pending` read here. One mechanism, two
 * kinds of agent.
 *
 * `manifest.hidden` is an explicit owner opt-out ("I run this from the CLI
 * only") and is filtered out here, before it ever reaches the renderer. It is
 * NOT the same rule as a broken manifest: a broken `agent.json` still has
 * `entry.manifest === null`, so it is never `hidden` and keeps listing with
 * its problem, exactly as `discover.ts` documents. `listExternalAgents` itself
 * stays unfiltered — `runner.ts` and the hub CLI need to find a hidden agent
 * by id to run it.
 */
export async function externalAgentInfos(builtinIds: ReadonlySet<string>): Promise<AgentInfo[]> {
  const entries = await listExternalAgents()
  const running = new Set(activeRuns())
  const out: AgentInfo[] = []

  for (const entry of entries) {
    if (entry.manifest?.hidden === true) continue

    const rules = readRules(entry.id, '')
    const name = entry.manifest?.name ?? entry.id
    const description = entry.manifest?.description ?? ''

    // The builtin registry owns its ids first: an external folder that
    // happens to share one is listed, not hidden ("a hidden agent is an
    // agent the user believes never existed"), but it never runs.
    const problem = builtinIds.has(entry.id) ? 'id already used by a built-in agent' : entry.problem

    out.push({
      id: entry.id,
      name,
      description,
      available: problem === '',
      reason: problem,
      screen: 'external',
      origin: 'external',
      external: {
        dir: entry.dir,
        resultsDir: agentResultsDir(entry.id),
        version: entry.manifest?.version ?? '',
        commands: entry.manifest !== null ? Object.keys(entry.manifest.commands) : [],
        needs: entry.manifest?.needs ?? [],
        schedule: entry.manifest?.schedule ?? '',
        running: running.has(entry.id),
        runLabel: entry.manifest?.runLabel ?? ''
      },
      rules: {
        supported: true,
        exists: rules.exists,
        path: rules.path,
        questions: pending(entry.id).map(toAgentQuestion),
        summary: rules.summary,
        notion: rules.notion.map((n) => ({ id: n.id, label: n.label })),
        drive: rules.drive.map((d) => ({ id: d.id, label: d.label }))
      }
    })
  }

  return out
}
