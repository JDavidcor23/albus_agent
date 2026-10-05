import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'

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
 */
export function writeEnvValue(dir: string, envFile: string, key: string, value: string): void {
  const file = join(dir, envFile)
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const updated = setDotenvValue(existing, key, value)

  const tmpFile = join(dir, `.${envFile}.tmp-${process.pid}-${Date.now()}`)
  writeFileSync(tmpFile, updated, 'utf8')
  renameSync(tmpFile, file)
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
export async function installTool(name: string): Promise<{ ok: boolean; output: string }> {
  const known = KNOWN_TOOLS[name]
  if (known === undefined || known.winget === undefined) {
    return {
      ok: false,
      output: `"${name}" has no automatic installer — run it yourself: ${known?.hint ?? 'unknown tool'}`
    }
  }

  const wingetId = known.winget
  return new Promise((resolve) => {
    execFile(
      'winget',
      ['install', '--id', wingetId, '-e', '--accept-package-agreements', '--accept-source-agreements'],
      { timeout: INSTALL_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim().slice(-4000)
        resolve({ ok: err === null, output })
      }
    )
  })
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
 * Runs the target's declared `check` command, piped (not attached to a
 * terminal) — this is the "is this agent healthy" probe the TUI runs
 * unattended, so stdout/stderr are captured instead of shown live.
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

  const resolved = await resolveProgram(parsed.program, parsed.args)
  const env = { ...buildSystemEnv(process.env), NO_COLOR: '1' }

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

    const timer = setTimeout(() => killTree(child), CHECK_TIMEOUT_MS)

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, output: `${output}${String(err)}`.trim().slice(-4000) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output: output.trim().slice(-4000) })
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
 * Persists the hub location for future shells/processes via `setx` (a
 * per-user environment variable on Windows — it does NOT affect the current
 * process, which is why `process.env` is also updated here so the rest of
 * THIS run sees the new value immediately).
 */
export async function setHubDirPersistently(hubDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('setx', ['ALBUS_AGENTS_HUB_DIR', hubDir], {
      stdio: 'ignore',
      shell: false,
      windowsHide: true
    })

    const timer = setTimeout(() => {
      killTree(child)
      reject(new Error('setx timed out'))
    }, SETX_TIMEOUT_MS)

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`setx exited with code ${code}`))
    })
  })

  process.env.ALBUS_AGENTS_HUB_DIR = hubDir
}

const ROBOCOPY_TIMEOUT_MS = 30 * 60_000

/**
 * Copies the whole hub (every installed agent's code AND its results) from
 * one location to another via `robocopy /E` — `node_modules` is excluded on
 * purpose: it is reinstalled per agent, not worth copying, and can be large
 * enough to make the move itself the thing that times out.
 *
 * Robocopy's own exit-code convention is NOT the usual "0 = success": any
 * code 0-7 means some combination of "files copied / no files needed
 * copying / extra files present", all success; 8 or higher is a real
 * failure (see Microsoft's robocopy docs).
 */
export async function copyHub(from: string, to: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      'robocopy',
      [from, to, '/E', '/XD', 'node_modules', '/R:1', '/W:1'],
      { timeout: ROBOCOPY_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim().slice(-4000)
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 8
        resolve({ ok: code < 8, output })
      }
    )
  })
}

/**
 * Verifies a hub copy actually landed: every `agents/<id>` folder present
 * under `from` must exist under `to` with either `agent.json` or `.git` —
 * either one is enough evidence the folder is really there and not an empty
 * shell `robocopy` created for some other reason. Returns one problem string
 * per agent that failed to verify; an empty array means the copy is sound.
 */
export async function verifyHubCopy(from: string, to: string): Promise<string[]> {
  const problems: string[] = []
  const fromAgentsDir = join(from, 'agents')
  if (!existsSync(fromAgentsDir)) return problems

  let names: string[]
  try {
    names = readdirSync(fromAgentsDir)
  } catch {
    return problems
  }

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

/** A literal hardcoded hub path, written as a backslash path, a forward-slash path, or a `path.join('Documents', 'agents-hub', ...)` call. */
const JOIN_STYLE_PATTERN = /['"`]Documents['"`]\s*,\s*['"`]agents-hub['"`]/

function lineHasHardcodedHubPath(line: string): boolean {
  // The one way to legitimately mention this path is to have derived it from
  // the env var override — if the line already does that, it is not the bug
  // this scan looks for.
  if (line.includes('ALBUS_AGENTS_HUB_DIR')) return false

  // Two literal backslash CHARACTERS, as they appear in a source file's own
  // text (e.g. the raw characters of `"Documents\\agents-hub"`), not an
  // escape sequence evaluated by this file.
  if (line.includes('Documents\\\\agents-hub')) return true
  if (line.includes('Documents/agents-hub')) return true
  return JOIN_STYLE_PATTERN.test(line)
}

function collectScannableFiles(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry)) continue

    const full = join(dir, entry)
    let isDirectory = false
    try {
      isDirectory = statSync(full).isDirectory()
    } catch {
      continue
    }

    if (isDirectory) {
      collectScannableFiles(full, out)
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
