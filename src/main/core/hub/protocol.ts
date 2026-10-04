import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'

/**
 * The agent's stdout, one JSON line = one event. Everything else is log.
 *
 * `npm` prints banners, `console.log` exists, and a third party's code will
 * eventually print something that is not one of our events. A parser that
 * rejected the odd line would break on the first real agent, so the rule is:
 * valid JSON object with a known `type` → that event; anything else → `log`.
 * Validated line by line, same as every other external feed in this project —
 * one bad line never aborts the run. See `.claude/docs/agents-hub.md`.
 */

const MAX_EVENT_LENGTH = 4000

export type AgentEvent =
  | { type: 'progress'; message: string; percent?: number }
  | { type: 'result'; path: string | null; message: string }
  | { type: 'question'; question: string; context: string; options: string[] }
  | { type: 'error'; message: string }
  | { type: 'log'; text: string }

const ProgressSchema = z.object({
  type: z.literal('progress'),
  message: z.string(),
  percent: z.number().optional()
})

const ResultSchema = z.object({
  type: z.literal('result'),
  path: z.string().nullable().default(null),
  message: z.string().default('')
})

const QuestionSchema = z.object({
  type: z.literal('question'),
  question: z.string(),
  context: z.string().default(''),
  options: z.array(z.string()).default([])
})

const ErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string()
})

function asLog(text: string): AgentEvent {
  return { type: 'log', text }
}

export function parseEventLine(line: string): AgentEvent {
  const text = line.length > MAX_EVENT_LENGTH ? line.slice(0, MAX_EVENT_LENGTH) : line
  const trimmed = text.trim()
  if (trimmed === '') return asLog(text)

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return asLog(text)
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return asLog(text)

  const type = (raw as { type?: unknown }).type

  switch (type) {
    case 'progress': {
      const parsed = ProgressSchema.safeParse(raw)
      return parsed.success ? parsed.data : asLog(text)
    }
    case 'result': {
      const parsed = ResultSchema.safeParse(raw)
      return parsed.success ? parsed.data : asLog(text)
    }
    case 'question': {
      const parsed = QuestionSchema.safeParse(raw)
      return parsed.success ? parsed.data : asLog(text)
    }
    case 'error': {
      const parsed = ErrorSchema.safeParse(raw)
      return parsed.success ? parsed.data : asLog(text)
    }
    default:
      // Unknown `type` → log, on purpose: an agent built against a newer
      // `protocol` must not break an older Albus. See agents-hub.md.
      return asLog(text)
  }
}

/**
 * Resolves a `result.path` against the agent's results folder. `null` means
 * either "nothing to show" (the agent said so) or "that path escapes the
 * results folder" (the agent is lying) — the caller cannot tell which from
 * this return value alone, and does not need to: both cases mean "don't open
 * anything". An agent must never make Albus open a path outside its own
 * results folder.
 */
export function resolveResultPath(resultsDir: string, raw: string | null): string | null {
  if (raw === null) return null
  const trimmed = raw.trim()
  if (trimmed === '') return null

  const absolute = resolve(resultsDir, trimmed)
  const rel = relative(resultsDir, absolute)
  if (rel.startsWith('..') || isAbsolute(rel)) return null

  return absolute
}
