/**
 * Pure `.env` editing: parse an existing file's values, or set one value
 * while preserving everything else — comments, blank lines, key order, and
 * line endings.
 *
 * This is domain logic (`core/`): no `node:fs`, no `electron`. The caller
 * reads the file, calls `setDotenvValue`, and writes the result back.
 */

const CRLF = '\r\n'

/** `export FOO=bar` or `FOO=bar`, capturing the key and the raw (unparsed) value. */
const ASSIGNMENT_PATTERN = /^(?:export\s+)?([^=\s]+)=(.*)$/

/** A value needs quoting if it is empty, or contains whitespace, `#`, `"`, `'`, or `\`. */
const NEEDS_QUOTING_PATTERN = /[\s#"'\\]/

/** Detects which line ending the source file uses, so the output matches it. */
function detectLineEnding(text: string): string {
  return text.includes(CRLF) ? CRLF : '\n'
}

/**
 * Unquotes a raw value from the right-hand side of `KEY=`. Handles
 * double-quoted values (with `\"` and `\\` escapes), single-quoted values
 * (literal — no escapes inside, by dotenv convention), and unquoted values,
 * where anything from an unescaped ` #` onward is a trailing comment.
 */
function unquoteValue(raw: string): string {
  const trimmed = raw.trim()

  if (trimmed.startsWith('"')) {
    let result = ''
    for (let i = 1; i < trimmed.length; i++) {
      const char = trimmed[i]
      if (char === '\\' && i + 1 < trimmed.length) {
        const next = trimmed[i + 1]
        if (next === '"' || next === '\\') {
          result += next
          i++
          continue
        }
      }
      if (char === '"') break
      result += char
    }
    return result
  }

  if (trimmed.startsWith("'")) {
    // Single-quoted values are literal: no escape handling, take everything
    // up to the next single quote (or to the end, if it is never closed).
    const closingIndex = trimmed.indexOf("'", 1)
    return closingIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, closingIndex)
  }

  if (trimmed.startsWith('`')) {
    // Backtick-quoted values are ALSO literal — same rule as single quotes,
    // no escape handling. `formatValue` falls back to this style precisely
    // because neither the `dotenv` package nor `process.loadEnvFile` give a
    // backtick-quoted value any special-character treatment at all, so it is
    // the one quoting style that round-trips a value containing both an
    // apostrophe and a backslash or a double quote.
    const closingIndex = trimmed.indexOf('`', 1)
    return closingIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, closingIndex)
  }

  // Unquoted: an inline comment starts at an unescaped ` #` (space then hash).
  const commentIndex = trimmed.indexOf(' #')
  const value = commentIndex === -1 ? trimmed : trimmed.slice(0, commentIndex)
  return value.trim()
}

/** Parses `.env`-style text into a map of key → unquoted value. */
export function parseDotenv(text: string): Map<string, string> {
  const result = new Map<string, string>()
  const lines = text.split(/\r\n|\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    const match = ASSIGNMENT_PATTERN.exec(trimmed)
    if (match === null) continue

    const [, key, rawValue] = match
    result.set(key, unquoteValue(rawValue))
  }

  return result
}

/**
 * Quotes a value for output if it contains anything that would otherwise be
 * ambiguous, or is empty — chosen so the result round-trips through the TWO
 * real readers of these files: the `dotenv` package (`src/main/index.ts`) and
 * Node's `process.loadEnvFile` (every agent). Neither unescapes a backslash
 * the way a JS/TS string literal would, so `formatValue` never emits a style
 * whose own reader would mangle the value back:
 *
 *  - Single quotes are preferred: both readers treat them as fully literal,
 *    no escapes at all.
 *  - If the value itself contains `'`, single quotes cannot be used. Double
 *    quotes are the next choice, but ONLY when the value has no backslash and
 *    no `"` — both readers expand `\n` inside double quotes to a real newline
 *    and leave every OTHER backslash exactly as written, and neither escapes
 *    an embedded `"`, so a literal backslash or quote inside would come back
 *    corrupted or truncated.
 *  - Backticks are the last resort: neither reader gives them any
 *    special-character treatment, so they round-trip a value with both an
 *    apostrophe and a backslash or `"`.
 *  - A value that mixes an apostrophe, a backslash or `"`, AND a backtick has
 *    no safe quoting style here — `formatValue` throws rather than silently
 *    writing something that will not read back the same.
 */
function formatValue(value: string, key: string): string {
  if (value !== '' && !NEEDS_QUOTING_PATTERN.test(value)) return value

  if (!value.includes("'")) return `'${value}'`
  if (!value.includes('\\') && !value.includes('"')) return `"${value}"`
  if (!value.includes('`')) return `\`${value}\``

  throw new Error(
    `cannot safely quote the value for "${key}": it mixes an apostrophe, a backslash or double quote, and a backtick — no quoting style round-trips`
  )
}

/**
 * Sets `key` to `value` inside `text`, preserving every other line
 * (comments, blank lines, other keys, their order). Replaces the FIRST
 * matching assignment line in place; drops any later duplicate assignments
 * of the same key. If the key is not present, appends a new line at the end.
 *
 * Throws if `value` contains a newline — never echoing the value itself.
 */
export function setDotenvValue(text: string, key: string, value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(`value for ${key} contains a newline`)
  }

  const eol = detectLineEnding(text)
  // An empty file has ZERO lines, not one empty line — `''.split(/\n/)`
  // would otherwise yield `['']` and a brand-new `.env` would get a leading
  // blank line before the first key.
  const lines = text === '' ? [] : text.split(/\r\n|\n/)
  // split on a line ending leaves a trailing '' entry when text ends in one.
  const endsWithNewline = text.length > 0 && (text.endsWith('\n') || text.endsWith('\r\n'))
  if (endsWithNewline) lines.pop()

  const formatted = `${key}=${formatValue(value, key)}`
  let replaced = false
  const output: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    const match = trimmed.startsWith('#') ? null : ASSIGNMENT_PATTERN.exec(trimmed)

    if (match !== null && match[1] === key) {
      if (replaced) continue // drop later duplicates
      // Keep an `export ` prefix the original line had.
      output.push(/^export\s+/.test(trimmed) ? `export ${formatted}` : formatted)
      replaced = true
      continue
    }

    output.push(line)
  }

  if (!replaced) output.push(formatted)

  return output.join(eol) + eol
}
