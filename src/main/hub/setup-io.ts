import { execFile, spawn } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, win32 } from 'node:path'

import type { AgentManifest } from '../core/hub/manifest'
import { parseDotenv, setDotenvValue } from '../core/hub/dotenv'
import type { DiskFacts } from '../core/hub/setup-status'
import { resolveHubDir } from '../core/hub/hub-location'
import { parseCommand } from '../core/hub/command'
import { buildSystemEnv } from '../core/hub/env'
import { resolveProgram, killTree } from './process'
import { listExternalAgents } from './discover'
import { albusSetupTarget } from './albus-setup'

/**
 * The setup TUI's one adapter to the outside world: disk, `where`, `winget`,
 * `setx`, `robocopy`, and running an agent's own declared commands. Every
 * function here is async or side-effecting on purpose — the pure decision
 * logic (what is missing, what state an item is in) lives in
 * `core/hub/setup-status.ts` and takes the `DiskFacts` this module gathers.
 */

export interface SetupTarget {
  id: string
  name: string
  dir: string
  manifest: AgentManifest | null
  problem: string
}

/**
 * Every target the TUI can configure: Albus itself first (it is the host,
 * not one more folder under `agents/`), then every external agent. Passing
 * `hubDir` straight to `listExternalAgents` — NOT `join(hubDir, 'agents')` —
 * because `listExternalAgents` already appends `agents` internally when
 * given a hub dir; joining it again here would look one level too deep and
 * silently return an empty list for every real hub.
 */
export async function listSetupTargets(hubDir: string): Promise<SetupTarget[]> {
  const albus = albusSetupTarget()
  const externals = await listExternalAgents(hubDir)

  const targets: SetupTarget[] = externals.map((entry) => ({
    id: entry.id,
    name: entry.manifest?.name ?? entry.id,
    dir: entry.dir,
    manifest: entry.manifest,
    problem: entry.problem
  }))

  return [albus, ...targets]
}

/** A missing `.env`/`.env.local` is not an error — it just has nothing in it yet. */
export function readEnvFile(dir: string, envFile: string): Map<string, string> {
  const file = join(dir, envFile)
  if (!existsSync(file)) return new Map()

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return new Map()
  }

  return parseDotenv(raw)
}

/**
 * Writes one env value atomically: the new content is written to a temp file
 * in the SAME directory (so the final `renameSync` is a same-volume rename,
 * which is atomic on Windows) and then renamed over the real file. A crash
 * or a second writer mid-write can never leave a half-written `.env`.
 *
 * If anything in this sequence fails — most importantly the final rename,
 * where Windows can throw `EPERM`/`EBUSY` over a file another process
 * (antivirus, a watcher, the agent itself) has open — the tmp file is
 * unlinked (best-effort) before rethrowing, so it never sits on disk holding
 * every secret under a `.tmp-*` name nobody cleans up. The rethrown error
 * carries the key name and file path only, never `value` or `updated` (the
 * full file content) — those are never interpolated into any message here.
 */
export function writeEnvValue(dir: string, envFile: string, key: string, value: string): void {
  const file = join(dir, envFile)
  const tmpFile = join(dir, `.${envFile}.tmp-${process.pid}-${Date.now()}`)

  try {
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const updated = setDotenvValue(existing, key, value)
    writeFileSync(tmpFile, updated, 'utf8')
    renameSync(tmpFile, file)
  } catch (error: unknown) {
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile)
    } catch {
      // Best-effort cleanup — the error thrown below is what the caller sees.
    }
    const reason = error instanceof Error ? error.message : 'unknown error'
    throw new Error(`failed to write "${key}" to ${file}: ${reason}`)
  }
}

/** What one captured external command came back with. */
export interface RunnerResult {
  /** Exit code; `null` when there is none (could not spawn, killed by the timeout or by maxBuffer). */
  code: number | null
  /** stdout + stderr, untrimmed. */
  output: string
  timedOut: boolean
  /** Why there is no exit code, when there is none. Empty otherwise. */
  error: string
}

/**
 * Runs one external command, captured, args array, never a shell. The three
 * functions here that CHANGE the machine — `setHubDirPersistently` (setx),
 * `copyHub` (robocopy), `installTool` (winget) — take one of these as an
 * optional last parameter so checks can pass a fake and count calls: a check
 * must never be able to touch the machine, even if a validation guard
 * regresses. (That happened once: a check run against older code really
 * spawned `setx` and left the user's ALBUS_AGENTS_HUB_DIR set to garbage.)
 */
export type CommandRunner = (
  file: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer?: number }
) => Promise<RunnerResult>

/** The real thing: `execFile`, hidden window, hard timeout. Never rejects. */
export const realRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: options.timeoutMs, windowsHide: true, maxBuffer: options.maxBuffer ?? 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`
        if (err === null) {
          resolve({ code: 0, output, timedOut: false, error: '' })
          return
        }
        const code = typeof err.code === 'number' ? err.code : null
        const timedOut = err.killed === true && code === null
        resolve({ code, output, timedOut, error: code === null ? err.message : '' })
      }
    )
  })

/** The last 4000 chars of what the command printed, plus why it failed to run when it did. */
function runnerOutputTail(result: RunnerResult): string {
  const text = result.error !== '' ? `${result.output}\n${result.error}` : result.output
  return text.trim().slice(-4000)
}

/** `where <name>`, 5s hard timeout. Never throws — not found and "took too long" both read as `false`. */
export async function whichTool(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('where', [name], { timeout: 5_000, windowsHide: true }, (err) => {
      resolve(err === null)
    })
  })
}

/**
 * Tools the setup flow knows how to detect and, for some, install via
 * `winget`. An entry with no `winget` id (whisper, claude, pdftotext) is NOT
 * missing data — those packages are not reliably one winget id across
 * machines, so the TUI can only point at the hint and ask the user to run it
 * themselves; `installTool` below refuses to guess.
 */
export const KNOWN_TOOLS: Record<string, { winget?: string; hint: string }> = {
  git: { winget: 'Git.Git', hint: 'winget install Git.Git' },
  node: { winget: 'OpenJS.NodeJS.LTS', hint: 'winget install OpenJS.NodeJS.LTS' },
  gh: { winget: 'GitHub.cli', hint: 'winget install GitHub.cli' },
  ffmpeg: { winget: 'Gyan.FFmpeg', hint: 'winget install Gyan.FFmpeg' },
  whisper: { hint: 'pip install -U openai-whisper' },
  claude: { hint: 'npm install -g @anthropic-ai/claude-code' },
  pdftotext: { hint: 'winget install oschwartz10612.Poppler' }
}

const INSTALL_TIMEOUT_MS = 5 * 60_000

/** Only ever spawns `winget` for a `KNOWN_TOOLS` entry that declares a winget id. */
export async function installTool(
  name: string,
  runner: CommandRunner = realRunner
): Promise<{ ok: boolean; output: string }> {
  const known = KNOWN_TOOLS[name]
  if (known === undefined || known.winget === undefined) {
    return {
      ok: false,
      output: `"${name}" has no automatic installer — run it yourself: ${known?.hint ?? 'unknown tool'}`
    }
  }

  const result = await runner(
    'winget',
    ['install', '--id', known.winget, '-e', '--accept-package-agreements', '--accept-source-agreements'],
    { timeoutMs: INSTALL_TIMEOUT_MS }
  )
  const output = runnerOutputTail(result)
  return { ok: result.code === 0 && !result.timedOut, output }
}

const INTERACTIVE_TIMEOUT_MS = 15 * 60_000
const CHECK_TIMEOUT_MS = 5 * 60_000

/**
 * Runs one of the target's OWN declared commands (by name, e.g. "gmail-auth")
 * attached to the user's real terminal (`stdio: 'inherit'`) — this is for
 * commands like an OAuth flow that need the user to see prompts and paste
 * something back. The command line still goes through `parseCommand`'s
 * allowlist and `resolveProgram`, same as every other hub spawn.
 *
 * `env` is the SYSTEM allowlist, never `process.env` verbatim — even though
 * this runs interactively in the user's own terminal, Albus's own process
 * may carry the Supabase `service_role` key, and an external agent's auth
 * script has no business inheriting it. The agent's own code loads its own
 * `.env` if it needs secrets.
 */
export async function runAgentCommandInteractive(target: SetupTarget, commandName: string): Promise<number> {
  if (target.manifest === null) {
    throw new Error(`"${target.id}" has no valid manifest`)
  }

  const line = target.manifest.commands[commandName]
  if (line === undefined) {
    throw new Error(`"${target.id}" does not declare a "${commandName}" command`)
  }

  const parsed = parseCommand(line)
  if (!parsed.ok) {
    throw new Error(`"${target.id}"'s "${commandName}" command is not allowed: ${parsed.reason}`)
  }

  const resolved = await resolveProgram(parsed.program, parsed.args)

  return new Promise((resolve, reject) => {
    const child = spawn(resolved.file, resolved.args, {
      cwd: target.dir,
      stdio: 'inherit',
      shell: false,
      env: buildSystemEnv(process.env)
    })

    const timer = setTimeout(() => killTree(child), INTERACTIVE_TIMEOUT_MS)

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })
}

/**
 * Replaces every occurrence of each (non-empty) secret value with `***`.
 * Plain substring replacement, not a regex — a secret can contain regex
 * metacharacters, and this must never risk interpreting the value as a
 * pattern instead of literal text.
 */
function redactSecrets(text: string, secretValues: string[]): string {
  let result = text
  for (const value of secretValues) {
    if (value === '') continue
    result = result.split(value).join('***')
  }
  return result
}

/** The target's declared secret env values that are actually set — what `runAgentCheck` must scrub from a check's output before anyone sees it. */
function secretValuesFor(target: SetupTarget): string[] {
  if (target.manifest === null) return []
  const envValues = readEnvFile(target.dir, target.manifest.setup.envFile)
  return target.manifest.setup.env
    .filter((item) => item.secret)
    .map((item) => envValues.get(item.key))
    .filter((value): value is string => value !== undefined && value !== '')
}

const CHECK_TIMEOUT_MINUTES = CHECK_TIMEOUT_MS / 60_000

/**
 * Runs the target's declared `check` command, piped (not attached to a
 * terminal) — this is the "is this agent healthy" probe the TUI runs
 * unattended, so stdout/stderr are captured instead of shown live.
 *
 * The raw output is NEVER returned as-is: a check that prints one of the
 * target's own declared secrets (a token it just validated, say) would
 * otherwise leak it straight into the TUI. Every non-empty value of an env
 * entry marked `secret: true` is redacted to `***` before this resolves.
 */
export async function runAgentCheck(target: SetupTarget): Promise<{ ok: boolean; output: string }> {
  if (target.manifest === null) {
    return { ok: false, output: 'no valid manifest' }
  }

  const line = target.manifest.commands.check
  if (line === undefined) {
    return { ok: false, output: 'no "check" command declared' }
  }

  const parsed = parseCommand(line)
  if (!parsed.ok) {
    return { ok: false, output: `"check" command is not allowed: ${parsed.reason}` }
  }

  let resolved: { file: string; args: string[] }
  try {
    resolved = await resolveProgram(parsed.program, parsed.args)
  } catch (error: unknown) {
    // Never reject: a target whose `node`/`npm` is not resolvable right now
    // is a normal, reportable check failure, not a crash of the setup TUI.
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, output: `could not resolve "${parsed.program}": ${reason}` }
  }

  const env = { ...buildSystemEnv(process.env), NO_COLOR: '1' }
  const secretValues = secretValuesFor(target)

  return new Promise((resolve) => {
    const child = spawn(resolved.file, resolved.args, {
      cwd: target.dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env
    })

    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, CHECK_TIMEOUT_MS)

    const finalize = (ok: boolean, extraLine?: string): { ok: boolean; output: string } => {
      let text = redactSecrets(output, secretValues).trim()
      if (timedOut) text = `${text}\n[timed out after ${CHECK_TIMEOUT_MINUTES} min]`.trim()
      if (extraLine !== undefined) text = `${text}\n${redactSecrets(extraLine, secretValues)}`.trim()
      return { ok: ok && !timedOut, output: text.slice(-4000) }
    }

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve(finalize(false, String(err)))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(finalize(code === 0))
    })
  })
}

/**
 * Reads the facts `computeSetupStatus` (core/hub/setup-status.ts) needs:
 * current env values, which `doneWhen` marker files exist, which declared
 * tools are on PATH. A target with no manifest (broken `agent.json`) has
 * nothing to gather — it comes back empty, never throws.
 */
export async function gatherFacts(target: SetupTarget): Promise<DiskFacts> {
  if (target.manifest === null) {
    return { envValues: new Map(), doneFiles: new Set(), tools: new Map() }
  }

  const { setup } = target.manifest
  const envValues = readEnvFile(target.dir, setup.envFile)

  const doneFiles = new Set<string>()
  for (const auth of setup.auth) {
    if (existsSync(join(target.dir, auth.doneWhen))) doneFiles.add(auth.doneWhen)
  }

  const tools = new Map<string, boolean>()
  for (const name of setup.tools) {
    tools.set(name, await whichTool(name))
  }

  return { envValues, doneFiles, tools }
}

/**
 * Where the hub currently lives, right now, in THIS process — same rule as
 * `src/main/paths.ts#agentsHubDir()`'s non-test branch
 * (`resolveHubDir(process.env, homeDir())`), reimplemented here instead of
 * imported: `paths.ts` imports `electron`, and the setup TUI runs standalone
 * under `tsx`, outside Electron, so it must never import that file (see
 * `tsconfig.tui.json`'s narrow `include` list). `USERPROFILE` is read
 * directly rather than through `os.homedir()` first because that is exactly
 * what `paths.ts#homeDir()` does on Windows; `os.homedir()` is only the
 * fallback when `USERPROFILE` is unset.
 */
export function currentHubDir(): string {
  return resolveHubDir(process.env, process.env.USERPROFILE ?? homedir())
}

const SETX_TIMEOUT_MS = 10_000

/**
 * `setx` silently truncates a value over roughly 1024 characters and still
 * exits 0 — a hub dir that long would "succeed" and persist garbage with no
 * error anywhere. Checked before spawning anything.
 */
const SETX_VALUE_MAX_LENGTH = 1024

/**
 * Persists the hub location for future shells/processes via `setx` (a
 * per-user environment variable on Windows — it does NOT affect the current
 * process, which is why `process.env` is also updated here so the rest of
 * THIS run sees the new value immediately).
 */
export async function setHubDirPersistently(hubDir: string, runner: CommandRunner = realRunner): Promise<void> {
  if (hubDir.length > SETX_VALUE_MAX_LENGTH) {
    throw new Error(
      `hub dir is ${hubDir.length} characters, over the ${SETX_VALUE_MAX_LENGTH}-character limit setx silently truncates at`
    )
  }
  if (!win32.isAbsolute(hubDir)) {
    throw new Error('hub dir must be an absolute path')
  }

  const result = await runner('setx', ['ALBUS_AGENTS_HUB_DIR', hubDir], { timeoutMs: SETX_TIMEOUT_MS })
  if (result.timedOut) throw new Error('setx timed out')
  if (result.code === null) throw new Error(`setx could not run: ${result.error}`)
  if (result.code !== 0) throw new Error(`setx exited with code ${result.code}`)

  process.env.ALBUS_AGENTS_HUB_DIR = hubDir
}

const ROBOCOPY_TIMEOUT_MS = 30 * 60_000

/**
 * `execFile`'s default `maxBuffer` is 1 MB of combined stdout+stderr. A real
 * hub copy, even with `/NFL /NDL /NP /NJH` cutting most of robocopy's own
 * chatter, can still exceed that on a hub with many agents — and when it
 * does, Node kills the child outright (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`),
 * aborting the copy mid-way. Raised well above anything a real run should
 * produce.
 */
const ROBOCOPY_MAX_BUFFER = 16 * 1024 * 1024

/**
 * Copies the whole hub (every installed agent's code AND its results) from
 * one location to another via `robocopy /E` — `node_modules` is excluded on
 * purpose: it is reinstalled per agent, not worth copying, and can be large
 * enough to make the move itself the thing that times out. `/NFL /NDL /NP
 * /NJH` drop the per-file list, per-directory list, progress percentage and
 * job header from robocopy's own output — none of it is useful here, and
 * skipping it is most of what keeps the captured output under
 * `ROBOCOPY_MAX_BUFFER` on a hub with many files.
 *
 * Robocopy's own exit-code convention is NOT the usual "0 = success": any
 * code 0-7 means some combination of "files copied / no files needed
 * copying / extra files present", all success; 8 or higher is a real
 * failure (see Microsoft's robocopy docs).
 */
export async function copyHub(
  from: string,
  to: string,
  runner: CommandRunner = realRunner
): Promise<{ ok: boolean; output: string }> {
  const result = await runner(
    'robocopy',
    [from, to, '/E', '/XD', 'node_modules', '/R:1', '/W:1', '/NFL', '/NDL', '/NP', '/NJH'],
    { timeoutMs: ROBOCOPY_TIMEOUT_MS, maxBuffer: ROBOCOPY_MAX_BUFFER }
  )
  const output = runnerOutputTail(result)
  // No numeric exit code (spawn error, timeout, maxBuffer kill) counts as a failure.
  const code = result.code ?? 8
  return { ok: code < 8, output }
}

/**
 * Verifies a hub copy actually landed: every `agents/<id>` folder present
 * under `from` must exist under `to` with either `agent.json` or `.git` —
 * either one is enough evidence the folder is really there and not an empty
 * shell `robocopy` created for some other reason. Returns one problem string
 * per agent that failed to verify; an empty array means the copy is sound.
 *
 * A missing or unreadable `from/agents` is ALSO a problem, never silently
 * `[]` — an empty array has to mean "verified, nothing wrong", not "could
 * not even look", or a caller that treats `[]` as success would report a
 * copy of a hub that was never read as sound.
 */
export async function verifyHubCopy(from: string, to: string): Promise<string[]> {
  const fromAgentsDir = join(from, 'agents')
  if (!existsSync(fromAgentsDir)) {
    return [`source has no "agents" folder: ${fromAgentsDir} does not exist`]
  }

  let names: string[]
  try {
    names = readdirSync(fromAgentsDir)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : 'unknown error'
    return [`cannot read ${fromAgentsDir}: ${reason}`]
  }

  const problems: string[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue

    let isDirectory = false
    try {
      isDirectory = statSync(join(fromAgentsDir, name)).isDirectory()
    } catch {
      continue
    }
    if (!isDirectory) continue

    const toDir = join(to, 'agents', name)
    const hasAgentJson = existsSync(join(toDir, 'agent.json'))
    const hasGit = existsSync(join(toDir, '.git'))
    if (!hasAgentJson && !hasGit) {
      problems.push(`${name}: not found under ${toDir} (no agent.json or .git)`)
    }
  }

  return problems
}

const SCAN_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.vbs', '.ps1'])
const SKIP_DIR_NAMES = new Set(['node_modules', '.git'])

/**
 * A literal hardcoded hub path, written as:
 *  - a single OR double backslash path (`Documents\agents-hub` — one
 *    backslash, exactly how a `.vbs`/`.ps1` string naturally reads once its
 *    own escaping is accounted for — or `Documents\\agents-hub`, two), or
 *  - a forward-slash path (`Documents/agents-hub`), or
 *  - a `path.join('Documents', 'agents-hub', ...)` call.
 * `[\\/]+` covers one-or-more of either slash direction in one pattern
 * instead of three separate `.includes` checks, so a `.ps1`/`.vbs` file
 * (which writes ONE backslash, not the doubled-up `\\` a JS/TS string
 * literal needs) is caught the same as a `.ts`/`.js` one.
 */
const SEPARATOR_STYLE_PATTERN = /Documents[\\/]+agents-hub/
const JOIN_STYLE_PATTERN = /['"`]Documents['"`]\s*,\s*['"`]agents-hub['"`]/

function lineHasHardcodedHubPath(line: string): boolean {
  // The one way to legitimately mention this path is to have derived it from
  // the env var override — if the line already does that, it is not the bug
  // this scan looks for.
  if (line.includes('ALBUS_AGENTS_HUB_DIR')) return false

  return SEPARATOR_STYLE_PATTERN.test(line) || JOIN_STYLE_PATTERN.test(line)
}

/**
 * Belt-and-suspenders beyond the symlink skip below: no real agent folder
 * nests this deep, so hitting this means something is looping regardless of
 * why — the scan bails out of that branch instead of hanging forever.
 */
const MAX_SCAN_DEPTH = 64

function collectScannableFiles(dir: string, out: string[], depth = 0): void {
  if (depth > MAX_SCAN_DEPTH) return

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry)) continue

    const full = join(dir, entry)
    let stats: ReturnType<typeof lstatSync>
    try {
      // `lstatSync`, never `statSync`: a junction/symlink must be identified
      // AS a symlink, which a `statSync` (follows links) would hide by
      // reporting the TARGET's type instead. The hub has had junctions
      // before (see `CLAUDE.md`'s "never --link" rule) — following one that
      // loops back on itself would recurse forever.
      stats = lstatSync(full)
    } catch {
      continue
    }

    if (stats.isSymbolicLink()) continue

    if (stats.isDirectory()) {
      collectScannableFiles(full, out, depth + 1)
      continue
    }

    if (SCAN_EXTENSIONS.has(extname(entry))) out.push(full)
  }
}

/**
 * Scans every installed agent's own files (`<hubDir>/agents/*`, skipping
 * `node_modules` and `.git`) for a hardcoded `Documents\agents-hub` /
 * `Documents/agents-hub` path — the exact bug `ALBUS_AGENTS_HUB_DIR`
 * (ruling applied in `env.ts`) exists to let an agent avoid. A line that
 * derives the path FROM that env var is not flagged, even if it also
 * mentions the literal fallback path on the same line.
 */
export function findHardcodedHubPaths(hubDir: string): { file: string; line: number }[] {
  const agentsDir = join(hubDir, 'agents')
  const files: string[] = []
  collectScannableFiles(agentsDir, files)

  const hits: { file: string; line: number }[] = []
  for (const file of files) {
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    const lines = content.split(/\r\n|\n/)
    lines.forEach((line, index) => {
      if (lineHasHardcodedHubPath(line)) hits.push({ file, line: index + 1 })
    })
  }

  return hits
}
