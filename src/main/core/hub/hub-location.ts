import path from 'node:path'

/**
 * Where the agents hub lives, and the rules around a user-chosen location.
 *
 * Pure domain logic (`core/`): string operations and `node:path`'s `win32`
 * join only — no `node:fs`, no `electron`. `src/main/paths.ts#agentsHubDir()`
 * (which may import `electron`) calls `resolveHubDir` so there is exactly
 * ONE source of truth for the rule, shared with the setup TUI, which must
 * not import `paths.ts`.
 */

/** CONTRACT — root folder name for the agents hub. Renaming it orphans every installed agent and its results. */
export const HUB_FOLDER = 'agents-hub'

/**
 * `parent` + `HUB_FOLDER`, unless `parent` already ends in `HUB_FOLDER` — in
 * which case it is returned unchanged, so picking a folder that is already
 * the hub itself does not nest a second `agents-hub` inside it.
 */
export function hubDirFromParent(parent: string): string {
  const trimmed = parent.replace(/[\\/]+$/, '')
  const lastSegment = trimmed.split(/[\\/]/).pop()
  if (lastSegment === HUB_FOLDER) return trimmed
  return path.win32.join(parent, HUB_FOLDER)
}

/**
 * Validates a user-chosen hub PARENT folder (the TUI's "where should the hub
 * live" prompt). Returns `null` when it is fine to use, or a human-readable
 * reason otherwise.
 */
export function validateHubParent(parent: string): string | null {
  const trimmed = parent.trim()
  if (trimmed === '') return 'path is empty'
  if (!path.win32.isAbsolute(trimmed)) return 'path must be absolute'
  if (trimmed.split(/[\\/]/).includes('..')) return 'path must not contain ".."'
  return null
}

/**
 * The hub folder: `ALBUS_AGENTS_HUB_DIR` when set and non-blank (trimmed),
 * else `<home>\Documents\agents-hub`. The ONE source of truth both
 * `paths.ts#agentsHubDir()` and the setup TUI call into.
 */
export function resolveHubDir(env: Record<string, string | undefined>, home: string): string {
  const override = env.ALBUS_AGENTS_HUB_DIR?.trim()
  if (override !== undefined && override !== '') return override

  return path.win32.join(home, 'Documents', HUB_FOLDER)
}
