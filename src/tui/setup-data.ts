import { computeSetupStatus, type DiskFacts, type SetupStatus } from '../main/core/hub/setup-status'
import { gatherFacts, listSetupTargets, type SetupTarget } from '../main/hub/setup-io'

/**
 * Everything the screens read, loaded in one pass: every target, the disk
 * facts behind it, and its computed status. Screens never touch the disk to
 * draw — they get this snapshot, and `[r]`/returning to Home reloads it.
 */

export interface TargetRow {
  target: SetupTarget
  facts: DiskFacts
  /** `null` when the target has no valid manifest — there is no contract to compare against. */
  status: SetupStatus | null
}

export interface ToolRow {
  name: string
  present: boolean
}

export interface SetupData {
  hubDir: string
  rows: TargetRow[]
  /** Every tool declared by any target, deduplicated, in first-seen order. */
  tools: ToolRow[]
}

export async function loadSetupData(hubDir: string): Promise<SetupData> {
  const targets = await listSetupTargets(hubDir)

  const rows = await Promise.all(
    targets.map(async (target): Promise<TargetRow> => {
      const facts = await gatherFacts(target)
      const status = target.manifest === null ? null : computeSetupStatus(target.manifest.setup, facts)
      return { target, facts, status }
    })
  )

  const tools = new Map<string, boolean>()
  for (const row of rows) {
    for (const [name, present] of row.facts.tools) {
      if (!tools.has(name)) tools.set(name, present)
    }
  }

  return {
    hubDir,
    rows,
    tools: [...tools].map(([name, present]) => ({ name, present }))
  }
}

/** The one-line summary Home shows next to each target. */
export function summarize(row: TargetRow): { text: string; color: 'green' | 'yellow' | 'red' | 'gray' } {
  if (row.target.problem !== '') return { text: `broken: ${row.target.problem}`, color: 'red' }
  if (row.status === null) return { text: 'broken: no valid manifest', color: 'red' }
  if (row.status.nothingToConfigure) return { text: 'nothing to configure', color: 'gray' }
  if (row.status.ready) return { text: 'ready', color: 'green' }

  const missing = [
    ...row.status.env.filter((item) => item.state === 'missing').map((item) => item.key),
    ...row.status.auth.filter((item) => item.state === 'missing').map((item) => item.label),
    ...row.status.tools.filter((item) => item.state === 'missing').map((item) => item.name)
  ]
  return { text: `missing ${missing.join(', ')}`, color: 'yellow' }
}

/** Every adapter call is wrapped with this: the TUI renders the message, it never crashes on it. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
