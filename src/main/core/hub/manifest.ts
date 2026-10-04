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
const CommandsSchema = z
  .record(z.string(), z.string())
  .refine((commands) => typeof commands.run === 'string' && commands.run.trim() !== '', {
    message: 'commands.run is required'
  })

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
  runLabel: z.string().max(40).default('')
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

  return { ok: true, manifest: parsed.data }
}
