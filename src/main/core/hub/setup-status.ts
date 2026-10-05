import type { AgentSetup } from './manifest'

/**
 * Compares an agent's `setup` contract against the facts the caller read
 * from disk (env values, which `doneWhen` marker files exist, which tools
 * are on PATH) and reports what is still missing. Pure: the caller does the
 * reading (env file parsing, `fs.existsSync`, `which`/`where`), this module
 * only decides state.
 */

export interface DiskFacts {
  envValues: Map<string, string>
  doneFiles: Set<string>
  tools: Map<string, boolean>
}

export type ItemState = 'ok' | 'missing' | 'optional-missing'

export interface SetupStatus {
  env: { key: string; label: string; help: string; secret: boolean; state: ItemState }[]
  auth: { label: string; command: string; doneWhen: string; state: ItemState }[]
  tools: { name: string; state: ItemState }[]
  /** Nothing REQUIRED is missing — optional-missing items do not block this. */
  ready: boolean
  /** The setup contract itself is empty: no env, no auth, no tools. */
  nothingToConfigure: boolean
}

export function computeSetupStatus(setup: AgentSetup, facts: DiskFacts): SetupStatus {
  let ready = true

  const env = setup.env.map((item) => {
    const value = facts.envValues.get(item.key)
    const present = value !== undefined && value !== ''

    let state: ItemState
    if (present) {
      state = 'ok'
    } else if (item.optional) {
      state = 'optional-missing'
    } else {
      state = 'missing'
      ready = false
    }

    return { key: item.key, label: item.label, help: item.help, secret: item.secret, state }
  })

  const auth = setup.auth.map((item) => {
    const done = facts.doneFiles.has(item.doneWhen)
    const state: ItemState = done ? 'ok' : 'missing'
    if (!done) ready = false
    return { label: item.label, command: item.command, doneWhen: item.doneWhen, state }
  })

  const tools = setup.tools.map((name) => {
    const present = facts.tools.get(name) === true
    const state: ItemState = present ? 'ok' : 'missing'
    if (!present) ready = false
    return { name, state }
  })

  const nothingToConfigure = setup.env.length === 0 && setup.auth.length === 0 && setup.tools.length === 0

  return { env, auth, tools, ready, nothingToConfigure }
}

/**
 * Which OTHER agents already have a non-empty value for `key` — used to
 * offer reusing a token/credential another agent already has configured,
 * instead of asking the user to paste it again.
 */
export function agentsHavingKey(
  key: string,
  values: { agentId: string; env: Map<string, string> }[],
  exceptId: string
): string[] {
  return values
    .filter((entry) => entry.agentId !== exceptId)
    .filter((entry) => {
      const value = entry.env.get(key)
      return value !== undefined && value !== ''
    })
    .map((entry) => entry.agentId)
}
