import { join } from 'node:path'

import { resolveHubDir } from './core/hub/hub-location'

/**
 * Where the USER's data lives. Never in the repo: the repo holds code, not state.
 *
 * Two places, split by whether the data can be regenerated:
 *
 * - `dataDir()` — `Documents/albus_agent`. What would be lost forever: the
 *   rules each agent reads and its queue of open questions. Visible and
 *   backup-able.
 * - `cacheDir()` — disposable: the diagnostic log of every hub run.
 *
 * Every folder name below is a FROZEN CONTRACT (see
 * `.claude/docs/frozen-contracts.md`): renaming one makes the hub start
 * looking at an empty folder, with no error.
 */

/** CONTRACT — the cache folder name. It was Electron's `userData`; the run logs still live there. */
const APP_NAME = 'albus-agent'

/** CONTRACT — the user's visible folder. Renaming it orphans every rule and question. */
const DATA_FOLDER = 'albus_agent'

/** CONTRACT — the code subfolder inside the hub. Renaming it hides every installed agent from discovery. */
const AGENTS_HUB_CODE_FOLDER = 'agents'

/** CONTRACT — the results subfolder inside the hub. Renaming it orphans everything an agent already produced. */
const AGENTS_HUB_RESULTS_FOLDER = 'results'

function homeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? process.cwd()
}

/**
 * The root of what the user would lose if it were deleted.
 *
 * `Documents` is computed by hand on purpose: on a OneDrive machine the
 * shell's "known folder" points somewhere else, and two callers disagreeing
 * on the path means one of them reads an empty folder. Whoever needs the
 * redirected folder sets `ALBUS_DATA_DIR` — explicit, never guessed.
 */
export function dataDir(): string {
  const override = process.env.ALBUS_DATA_DIR?.trim()
  if (override !== undefined && override !== '') return override

  return join(homeDir(), 'Documents', DATA_FOLDER)
}

/** The disposable side. Deleting it costs the user nothing. */
export function cacheDir(): string {
  const { APPDATA } = process.env
  const home = homeDir()

  if (process.platform === 'win32') return join(APPDATA ?? join(home, 'AppData', 'Roaming'), APP_NAME)
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', APP_NAME)
  return join(home, '.config', APP_NAME)
}

/** Each agent's rules (`<id>.md`) and question queue (`<id>.preguntas.json`). */
export function agentsDir(): string {
  return join(dataDir(), 'agents')
}

/**
 * Root of the agents hub: every agent's CODE and what it PRODUCES.
 *
 * `resolveHubDir` in `core/hub/hub-location.ts` is the single source of
 * truth shared with the setup TUI; `ALBUS_AGENTS_HUB_DIR` moves it.
 */
export function agentsHubDir(): string {
  return resolveHubDir(process.env, homeDir())
}

/** Where each agent's code lives, one folder per agent id. */
export function agentsCodeDir(): string {
  return join(agentsHubDir(), AGENTS_HUB_CODE_FOLDER)
}

/**
 * Where an agent writes what it produces. Same id as its code folder on
 * purpose — see `.claude/docs/agents-hub.md`.
 */
export function agentResultsDir(agentId: string): string {
  // The id ends up in a path, so a stray `..` must not write outside this folder.
  const clean = agentId.replace(/[^a-z0-9-]/gi, '')
  return join(agentsHubDir(), AGENTS_HUB_RESULTS_FOLDER, clean)
}

/**
 * Diagnostic log of every hub run, one JSON-lines file per run. It is the
 * hub's own diagnostic, not a deliverable, so it never goes inside the hub.
 */
export function agentRunsDir(): string {
  return join(cacheDir(), 'agent-runs')
}
