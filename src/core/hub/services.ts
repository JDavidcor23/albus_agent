import type { AgentManifest } from './manifest'

/**
 * Resolves `uses` against `provides`/`grants` across every manifest in the
 * hub — the pure half of the agent-services contract (`.claude/docs/agent-services.md`).
 * Pure: it never touches disk. The caller (`scripts/check-hub.ts`, the TUI's
 * `setup-data.ts`) supplies the manifests it already read.
 *
 * This answers exactly two questions per `uses` entry: is the provider
 * installed (present in the manifest list, with a valid manifest), and did
 * it grant THIS caller the service or group asked for? It deliberately does
 * NOT know whether the provider's own setup (env, auth) is actually filled
 * in — that is disk-dependent (`setup-status.ts#computeSetupStatus`) and is
 * layered on top by the TUI, not here.
 */

/** One manifest as it exists in the hub, by id. `manifest: null` covers both "no such folder" and "broken agent.json" — from a consumer's point of view, neither can grant anything. */
export interface ManifestEntry {
  id: string
  manifest: AgentManifest | null
}

export type UseStatus = 'ok' | 'provider-not-installed' | 'not-granted'

export interface UseFinding {
  /** The raw `uses` entry, e.g. `"google:gmail-read"`. */
  use: string
  providerId: string
  service: string
  status: UseStatus
}

export interface ConsumerFindings {
  consumerId: string
  findings: UseFinding[]
}

/** Splits a `uses` entry into its provider and service halves. `uses` is already validated by `USES_PATTERN` at parse time, so `use.indexOf(':')` always finds one. */
function splitUse(use: string): { providerId: string; service: string } {
  const sep = use.indexOf(':')
  return sep === -1 ? { providerId: use, service: '' } : { providerId: use.slice(0, sep), service: use.slice(sep + 1) }
}

/** A grant list covers a service when it names it directly, or carries the `"*"` wildcard ("every service this provider has"). */
function grantCovers(grants: readonly string[], service: string): boolean {
  return grants.includes('*') || grants.includes(service)
}

/**
 * Resolves every manifest's `uses` entries against the full set. Only
 * manifests that actually declare `uses` show up in the result — an agent
 * with none is not a consumer and has nothing to report.
 */
export function resolveServices(manifests: ManifestEntry[]): ConsumerFindings[] {
  const byId = new Map(manifests.map((entry) => [entry.id, entry]))

  const out: ConsumerFindings[] = []
  for (const entry of manifests) {
    if (entry.manifest === null || entry.manifest.uses.length === 0) continue

    const findings: UseFinding[] = entry.manifest.uses.map((use) => {
      const { providerId, service } = splitUse(use)
      const provider = byId.get(providerId)

      if (provider === undefined || provider.manifest === null) {
        return { use, providerId, service, status: 'provider-not-installed' }
      }

      const grants = provider.manifest.grants[entry.id] ?? []
      if (!grantCovers(grants, service)) {
        return { use, providerId, service, status: 'not-granted' }
      }

      return { use, providerId, service, status: 'ok' }
    })

    out.push({ consumerId: entry.id, findings })
  }

  return out
}
