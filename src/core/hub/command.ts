/**
 * The allowlist that stands between a third party's `agent.json` and a shell.
 *
 * A command is one line, split on whitespace, with no quoting and no escapes.
 * The first token has to be `npm` or `node` — nothing else — and every token
 * has to match a plain allowlist of characters: no `&`, `|`, `>`, `;`, quotes,
 * `%` or `$`. See `.claude/docs/agents-hub.md` for the full rule set.
 *
 * What the agent's own `package.json` script does once `npm run <script>`
 * starts is the agent's code — installing it already means trusting it. This
 * allowlist protects against `agent.json` as the attack surface, not against
 * the agent itself.
 */

const TOKEN_PATTERN = /^[A-Za-z0-9@._:=/+,-]+$/
const NODE_SCRIPT_PATTERN = /\.(js|mjs|cjs|ts)$/i

export type ParsedCommand =
  | { ok: true; program: 'npm' | 'node'; args: string[] }
  | { ok: false; reason: string }

function validateTokens(tokens: string[]): string | null {
  for (const token of tokens) {
    if (!TOKEN_PATTERN.test(token)) return `token not allowed: "${token}"`
  }
  return null
}

function parseNpm(args: string[]): ParsedCommand {
  const [sub, ...rest] = args

  if (sub === 'test' || sub === 'start') {
    if (rest.length > 0) return { ok: false, reason: `npm ${sub} takes no extra arguments` }
    return { ok: true, program: 'npm', args }
  }

  if (sub === 'run' || sub === 'run-script') {
    const script = rest[0]
    if (script === undefined || script === '' || script === '--') {
      return { ok: false, reason: `npm ${sub} needs a script name` }
    }

    const extra = rest.slice(1)
    if (extra.length > 0 && extra[0] !== '--') {
      return { ok: false, reason: 'extra arguments to npm run must come after "--"' }
    }

    return { ok: true, program: 'npm', args }
  }

  return { ok: false, reason: `npm subcommand not allowed: "${sub ?? ''}" (only run, run-script, test, start)` }
}

function parseNode(args: string[]): ParsedCommand {
  const script = args[0]
  if (script === undefined || script === '') {
    return { ok: false, reason: 'node needs a script path' }
  }

  if (!NODE_SCRIPT_PATTERN.test(script)) {
    return { ok: false, reason: `node script must end in .js, .mjs, .cjs or .ts: "${script}"` }
  }

  if (script.startsWith('/') || script.startsWith('~') || /^[A-Za-z]:[\\/]/.test(script)) {
    return { ok: false, reason: `node script must be a relative path: "${script}"` }
  }

  if (script.split(/[\\/]/).includes('..')) {
    return { ok: false, reason: `node script must not contain ".." segments: "${script}"` }
  }

  // Real containment inside the agent's folder is checked again by the
  // runner with `realpathSync` — this only rejects the obvious cases a pure
  // function can see without touching disk.
  return { ok: true, program: 'node', args }
}

export function parseCommand(line: string): ParsedCommand {
  const tokens = line.trim().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return { ok: false, reason: 'empty command' }

  const badToken = validateTokens(tokens)
  if (badToken !== null) return { ok: false, reason: badToken }

  const [program, ...args] = tokens

  if (program === 'npm') return parseNpm(args)
  if (program === 'node') return parseNode(args)

  return { ok: false, reason: `program must be "npm" or "node", got "${program}"` }
}
