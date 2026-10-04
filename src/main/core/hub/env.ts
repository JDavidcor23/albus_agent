/**
 * The environment an external agent gets — an allowlist, never an inheritance.
 *
 * Albus's own `process.env` carries the Supabase `service_role` key, which
 * bypasses RLS entirely (see `frozen-contracts.md` and the top-level
 * `CLAUDE.md`). Handing that to a third-party agent because it happened to be
 * installed would be the exact same security hole as importing
 * `src/main/supabase/` into the renderer, one layer further down the stack.
 *
 * So the agent does not inherit `process.env`. It gets a brand-new object:
 * the handful of system variables Node and npm themselves need to run, plus
 * the contract described in `.claude/docs/agents-hub.md`. Secrets the agent
 * needs are its own problem — its own `.env`, loaded by its own code.
 */

/**
 * Matched case-insensitively: Windows variable names are not reliably
 * cased the same way twice (`Path` vs `PATH` vs `path` all show up).
 */
const SYSTEM_VAR_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'USERPROFILE',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'USERNAME',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'ProgramData',
  'CommonProgramFiles',
  'LANG',
  'LC_ALL',
  'TERM',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS'
]

const ALLOWLIST_LOWER = new Set(SYSTEM_VAR_ALLOWLIST.map((key) => key.toLowerCase()))

export interface AgentEnvContract {
  agentId: string
  runId: string
  resultsDir: string
  rulesPath: string
}

/**
 * The same system-variable allowlist, with no agent contract attached. Used
 * by anything the hub spawns that is not yet (or not only) one agent's own
 * run — `git clone` and `npm ci`/`npm install` during an install. Without
 * this, those calls fall back to Node's default of inheriting the full
 * `process.env`, which defeats the allowlist exactly the same way handing it
 * to the agent directly would.
 */
export function buildSystemEnv(source: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {}

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (!ALLOWLIST_LOWER.has(key.toLowerCase())) continue
    output[key] = value
  }

  return output
}

/**
 * Builds the environment for one run. `source` is normally `process.env`,
 * passed in rather than read here so this stays pure and testable without
 * mutating or depending on the real process environment.
 */
export function buildAgentEnv(
  source: Record<string, string | undefined>,
  contract: AgentEnvContract
): Record<string, string> {
  const output = buildSystemEnv(source)

  output.AGENT_ID = contract.agentId
  output.AGENT_RUN_ID = contract.runId
  output.AGENT_PROTOCOL = '1'
  output.AGENT_RESULTS_DIR = contract.resultsDir
  output.AGENT_RULES_PATH = contract.rulesPath
  // ANSI color codes in stdout would corrupt the JSON-lines protocol.
  output.NO_COLOR = '1'
  output.FORCE_COLOR = '0'

  return output
}
