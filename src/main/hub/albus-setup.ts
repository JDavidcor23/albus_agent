import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'

import { SetupSchema, type AgentManifest } from '../core/hub/manifest'
import type { SetupTarget } from './setup-io'

/**
 * Albus's own `setup.json`, repo root. Albus is not an external agent — it
 * is the host app — so it is NOT validated against `AgentJsonSchema` (which
 * demands `protocol`, `id`, `version`, `timeoutMinutes`, and — through the
 * shared `CommandsSchema` — a `commands.run` entry). None of that applies:
 * Albus is never installed, never launched by `commands.run`, and its own
 * `setup.json` only needs a name, a free-form `commands` map (declared
 * commands the TUI can offer to run, e.g. "check"), and the `setup` contract
 * (tools/env/auth) that `SetupSchema` already describes. Reusing
 * `CommandsSchema` verbatim here would reject Albus's own file for lacking a
 * "run" key it will never have.
 */
const AlbusSetupJsonSchema = z.object({
  name: z.string().min(1),
  commands: z.record(z.string(), z.string()),
  setup: SetupSchema
})

/**
 * The repo root, resolved from THIS file's own location rather than
 * `process.cwd()` — two callers need the same answer and only one of them
 * runs from the repo root:
 *
 * - `scripts/check-setup.ts` (`tsx scripts/check-setup.ts`) DOES run with
 *   cwd = repo root, so `process.cwd()` would happen to work there.
 * - `src/tui/index.tsx` is its own ESM package (`src/tui/package.json` has
 *   `"type": "module"`) and may be launched from elsewhere (an installed
 *   TUI, a different cwd) — it needs the real answer, not an assumption
 *   about where the shell happened to be when it started.
 *
 * This file itself (`src/main/hub/albus-setup.ts`) has no sibling
 * `package.json` between it and the repo root, so Node resolves it as
 * CommonJS (the root `package.json` has no `"type": "module"`) regardless of
 * whether the importer is the ESM TUI or the CJS check script — `tsx`
 * compiles CJS files with `__dirname` available either way. That makes
 * `resolve(__dirname, '../../..')` (hub/ -> main/ -> src/ -> repo root)
 * reliable from both callers, so it is used unconditionally instead of
 * `process.cwd()`.
 */
function repoRoot(): string {
  return resolve(__dirname, '../../..')
}

/** Default values for every `AgentManifest` field Albus's `setup.json` never declares. */
function buildManifest(parsed: z.infer<typeof AlbusSetupJsonSchema>): AgentManifest {
  return {
    protocol: 1,
    id: 'albus',
    name: parsed.name,
    description: '',
    version: '0.0.0',
    commands: parsed.commands,
    timeoutMinutes: 30,
    needs: [],
    schedule: '',
    exitCodes: {},
    runLabel: '',
    hidden: false,
    setup: parsed.setup,
    // Albus is the host, never a hub provider or consumer — it is out of
    // scope for the agent-services contract (see `.claude/docs/agent-services.md`'s
    // "Fuera de alcance" section), so these always parse to empty.
    provides: [],
    grants: {},
    uses: []
  }
}

/**
 * Builds Albus's own `SetupTarget` from `<repo root>/setup.json`. Never
 * throws: a missing file, invalid JSON, or a shape that fails
 * `AlbusSetupJsonSchema` all come back as `manifest: null` with `problem`
 * set — same contract `listExternalAgents` uses for a broken `agent.json`.
 */
export function albusSetupTarget(): SetupTarget {
  const dir = repoRoot()
  const file = join(dir, 'setup.json')

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error: unknown) {
    return { id: 'albus', name: 'Albus (the app)', dir, manifest: null, problem: `cannot read setup.json: ${String(error)}` }
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (error: unknown) {
    return { id: 'albus', name: 'Albus (the app)', dir, manifest: null, problem: `setup.json is not valid JSON: ${String(error)}` }
  }

  const result = AlbusSetupJsonSchema.safeParse(data)
  if (!result.success) {
    const reason = result.error.issues.map((issue) => issue.message).join('; ')
    return { id: 'albus', name: 'Albus (the app)', dir, manifest: null, problem: reason }
  }

  return { id: 'albus', name: result.data.name, dir, manifest: buildManifest(result.data), problem: '' }
}
