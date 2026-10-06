import { z } from 'zod'

/**
 * `agent.json`: the contract between Albus and an external agent's folder.
 *
 * This is untrusted input twice over — it is a file on disk (the user, or an
 * installer, can hand-edit it) AND it is written by a third party (whoever
 * wrote the agent). Every field gets a safe default so a manifest that is
 * merely incomplete still opens; only a manifest that is actually wrong
 * (bad id, missing `commands.run`) gets rejected. See `.claude/docs/agents-hub.md`.
 */

/** CONTRACT — the id shape: lowercase, digits, hyphens, 2-49 chars, never starting with a hyphen. */
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/

const INTEGER_KEY_PATTERN = /^\d+$/

/**
 * `commands` is a free-form map (an agent can declare `run`, `check`, or any
 * other name it wants to expose), but `run` is the one thing Albus actually
 * needs. `z.record` cannot express "this one key is required" on its own, so
 * that rule is a `.refine` instead.
 */
export const CommandsSchema = z
  .record(z.string(), z.string())
  .refine((commands) => typeof commands.run === 'string' && commands.run.trim() !== '', {
    message: 'commands.run is required'
  })

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/
const TOOL_PATTERN = /^[a-z0-9._-]+$/

/**
 * A service name, as it appears in `provides`, as a value inside `grants`, or
 * after the `:` in a `uses` entry — lowercase, digits, dot (for a namespaced
 * name like `drive.upload`), hyphen, or the literal `*` (only meaningful in
 * `grants`, where it means "every service this provider has"). See
 * `.claude/docs/agent-services.md`.
 */
const SERVICE_PATTERN = /^[a-z0-9.*-]+$/

/**
 * A `uses` entry: `<provider id>:<service or group>`. The provider half
 * reuses `AGENT_ID_PATTERN` (it IS an agent id — the folder name of whoever
 * provides the service), the service half is `SERVICE_PATTERN`.
 */
const USES_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}:[a-z0-9.*-]+$/

/** A path relative to the agent folder that can never climb out of it. */
const InsidePath = z.string().min(1).refine(
  (p) => !p.split(/[\\/]/).includes('..') && !/^([a-zA-Z]:|[\\/])/.test(p),
  { message: 'path must stay inside the agent folder' }
)

export const SetupSchema = z
  .object({
    tools: z.array(z.string().regex(TOOL_PATTERN)).default([]),
    env: z
      .array(
        z.object({
          key: z.string().regex(ENV_KEY_PATTERN),
          label: z.string().min(1),
          help: z.string().default(''),
          secret: z.boolean().default(true),
          optional: z.boolean().default(false)
        })
      )
      .default([]),
    envFile: z.enum(['.env', '.env.local']).default('.env'),
    auth: z
      .array(
        z.object({
          label: z.string().min(1),
          /** The NAME of an entry in `commands` — never a command line: it must go through the allowlist. */
          command: z.string().min(1),
          doneWhen: InsidePath
        })
      )
      .default([])
  })
  .default({ tools: [], env: [], envFile: '.env', auth: [] })

export type AgentSetup = z.infer<typeof SetupSchema>

/**
 * Exit codes are keyed by the process's numeric exit code, carried as a
 * string because JSON object keys always are. A non-numeric key is a typo in
 * the agent's own file — reject it rather than silently never matching.
 */
const ExitCodesSchema = z
  .record(z.string(), z.string())
  .default({})
  .refine((codes) => Object.keys(codes).every((key) => INTEGER_KEY_PATTERN.test(key)), {
    message: 'exitCodes keys must be integer strings, e.g. "2"'
  })

export const AgentJsonSchema = z.object({
  /** Only `1` exists today. Without this, a future format change has no way to tell agents apart. */
  protocol: z.literal(1),
  /** Must equal the folder name it lives in — enforced in `parseAgentJson`, not here, because this schema does not know the folder. */
  id: z.string().regex(AGENT_ID_PATTERN),
  name: z.string().min(1),
  description: z.string().default(''),
  version: z.string().default('0.0.0'),
  commands: CommandsSchema,
  timeoutMinutes: z.number().int().min(1).max(240).default(30),
  /** Informative only — Albus cannot probe a third-party session. See `agents-hub.md`. */
  needs: z.array(z.string()).default([]),
  /** Informative only — Albus does not schedule anything. */
  schedule: z.string().default(''),
  exitCodes: ExitCodesSchema,
  /**
   * The label the agent wants on its own primary run button, e.g. "Generate digest".
   * `''` (the default, and what a manifest that predates this field parses to)
   * means the UI falls back to the generic "Run" — no `.min(1)` here on purpose:
   * an agent that sets `runLabel: ""` explicitly gets the same fallback instead
   * of a rejected manifest over a cosmetic field.
   */
  runLabel: z.string().max(40).default(''),
  /**
   * An explicit owner opt-out: this agent is run from the CLI (or Orca) only
   * and should not show up in the Albus agents list. Defaults to `false` so a
   * manifest written before this field existed stays visible exactly as
   * before. This is NOT the same thing as a broken manifest being hidden —
   * a broken `agent.json` always lists with its problem (see `discover.ts`);
   * `hidden: true` is the owner saying "I know this is healthy, don't show
   * it." `hub -- list` still prints it, marked `(hidden)`, and `hub -- run
   * <id>` still runs it — only the renderer-facing list filters it out.
   */
  hidden: z.boolean().default(false),
  /**
   * Optional setup contract: tools, environment variables, files, and auth commands.
   * The TUI reads this to guide the user through initial setup of a newly installed agent.
   * Defaults to empty when not present — old manifests stay valid.
   */
  setup: SetupSchema,
  /**
   * The services this agent's `scripts/call.ts` exposes to OTHER agents on
   * this hub, e.g. `["fetch", "drive.upload"]`. Non-empty is what makes an
   * agent a PROVIDER in the TUI's Connections group. Empty (the default, and
   * what every manifest written before this field existed parses to) means
   * "not a provider" — it stays a plain agent. See `.claude/docs/agent-services.md`.
   */
  provides: z.array(z.string().regex(SERVICE_PATTERN)).default([]),
  /**
   * Who this provider lets call which of its services: `{ <caller id>:
   * [<service or group>, ...] }`. `"*"` in the array means every service this
   * provider exposes. A caller id not listed here gets `not_granted` from the
   * provider at call time — `grants` is the provider's OWN allowlist, not a
   * request the caller makes. Defaults to `{}`: a provider that declares no
   * grants grants nothing, which is the safe default for a fresh install.
   */
  grants: z.record(z.string().regex(AGENT_ID_PATTERN), z.array(z.string().regex(SERVICE_PATTERN))).default({}),
  /**
   * The services this agent calls on OTHER agents, as `<provider id>:<service
   * or group>`, e.g. `["google:gmail-read", "notion:fetch"]`. Informative for
   * `hub:check` and the TUI (`core/hub/services.ts` resolves it against every
   * manifest's `provides`/`grants`) — Albus itself never spawns the call,
   * each agent calls the provider directly. Defaults to `[]`: old manifests,
   * and any agent with no external dependency, stay valid.
   */
  uses: z.array(z.string().regex(USES_PATTERN)).default([])
})

export type AgentManifest = z.infer<typeof AgentJsonSchema>

export type ParsedAgentJson =
  | { ok: true; manifest: AgentManifest }
  | { ok: false; reason: string }

/**
 * Parses one `agent.json` file. `folderName` is the name of the folder the
 * file was found in — the id must match it, or two agents could end up
 * writing into the same `results/<id>` folder. See `agents-hub.md`.
 */
export function parseAgentJson(folderName: string, raw: string): ParsedAgentJson {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (error: unknown) {
    return { ok: false, reason: `agent.json is not valid JSON: ${String(error)}` }
  }

  const parsed = AgentJsonSchema.safeParse(data)
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((issue) => issue.message).join('; ') }
  }

  if (parsed.data.id !== folderName) {
    return {
      ok: false,
      reason: `agent.json id "${parsed.data.id}" does not match its folder name "${folderName}"`
    }
  }

  // Cross-field validation: auth commands must exist in the commands list.
  // This is enforced here instead of in the schema because it requires checking
  // two fields against each other, and the allowlist pattern (commands are declared,
  // not arbitrary) is critical for security — we only run commands that the agent
  // explicitly declared, never a string from `setup.auth[].command`.
  for (const auth of parsed.data.setup.auth) {
    if (!(auth.command in parsed.data.commands)) {
      return {
        ok: false,
        reason: `setup.auth command "${auth.command}" is not declared in commands`
      }
    }
  }

  return { ok: true, manifest: parsed.data }
}
