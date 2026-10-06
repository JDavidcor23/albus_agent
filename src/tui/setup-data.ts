import { computeSetupStatus, type DiskFacts, type SetupStatus } from '../main/core/hub/setup-status'
import { resolveServices, type ManifestEntry, type UseStatus } from '../main/core/hub/services'
import { gatherFacts, listSetupTargets, type SetupTarget } from '../main/hub/setup-io'

/**
 * Everything the screens read, loaded in one pass: every target, the disk
 * facts behind it, and its computed status. Screens never touch the disk to
 * draw — they get this snapshot, and `[r]`/returning to Home reloads it.
 */

/**
 * One of this target's own `uses` entries, resolved against every OTHER
 * target loaded in this same pass. `resolveServices` (pure, `core/hub/services.ts`)
 * only knows about `provides`/`grants` — it cannot tell "installed but not
 * configured yet" from "fully working", because that needs disk facts. This
 * layer adds exactly that: an otherwise-`ok` finding whose provider's OWN
 * `SetupStatus.ready` is false gets downgraded to `provider-not-ready` here.
 */
export interface UseFindingRow {
  use: string
  providerId: string
  service: string
  status: UseStatus | 'provider-not-ready'
}

export interface TargetRow {
  target: SetupTarget
  facts: DiskFacts
  /** `null` when the target has no valid manifest — there is no contract to compare against. */
  status: SetupStatus | null
  /** This target's own `uses`, resolved. Empty when it declares none. */
  uses: UseFindingRow[]
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

  const base = await Promise.all(
    targets.map(async (target): Promise<Omit<TargetRow, 'uses'>> => {
      const facts = await gatherFacts(target)
      const status = target.manifest === null ? null : computeSetupStatus(target.manifest.setup, facts)
      return { target, facts, status }
    })
  )

  // Resolve `uses` across every target loaded in this pass, then layer the
  // one thing `resolveServices` cannot know on its own: whether an `ok`
  // provider is actually READY (its own env/auth/tools are filled in).
  const manifestEntries: ManifestEntry[] = base.map((row) => ({ id: row.target.id, manifest: row.target.manifest }))
  const findingsByConsumer = new Map(resolveServices(manifestEntries).map((r) => [r.consumerId, r.findings]))
  const readyById = new Map(base.map((row) => [row.target.id, row.status?.ready ?? false]))

  const rows: TargetRow[] = base.map((row) => {
    const findings = findingsByConsumer.get(row.target.id) ?? []
    const uses: UseFindingRow[] = findings.map((finding) => {
      if (finding.status === 'ok' && readyById.get(finding.providerId) === false) {
        return { ...finding, status: 'provider-not-ready' }
      }
      return finding
    })
    return { ...row, uses }
  })

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

/**
 * The one-line summary Home shows next to each target. Own setup problems
 * (broken manifest, missing env/auth/tools) always win over a `uses` problem
 * — fix yourself before anyone can tell whether you can reach a provider.
 * Only once this target's OWN setup is ready does an unmet `uses` entry
 * (provider not installed, not granted, or installed-but-not-ready) show as
 * `needs <provider> (<service>)`.
 */
export function summarize(row: TargetRow): { text: string; color: 'green' | 'yellow' | 'red' | 'gray' } {
  if (row.target.problem !== '') return { text: `broken: ${row.target.problem}`, color: 'red' }
  if (row.status === null) return { text: 'broken: no valid manifest', color: 'red' }
  // A draft is "not published yet", not "broken" — no missing-key nagging,
  // just say so. Home also groups it separately (see home.tsx).
  if (row.target.manifest?.draft === true) return { text: 'draft', color: 'gray' }

  if (!row.status.ready) {
    const missing = [
      ...row.status.env.filter((item) => item.state === 'missing').map((item) => item.key),
      ...row.status.auth.filter((item) => item.state === 'missing').map((item) => item.label),
      ...row.status.tools.filter((item) => item.state === 'missing').map((item) => item.name)
    ]
    return { text: `missing ${missing.join(', ')}`, color: 'yellow' }
  }

  const unmet = row.uses.filter((item) => item.status !== 'ok')
  if (unmet.length > 0) {
    const text = unmet.map((item) => `${item.providerId} (${item.service})`).join(', ')
    return { text: `needs ${text}`, color: 'yellow' }
  }

  if (row.status.nothingToConfigure) return { text: 'nothing to configure', color: 'gray' }
  return { text: 'ready', color: 'green' }
}

/** Every adapter call is wrapped with this: the TUI renders the message, it never crashes on it. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
