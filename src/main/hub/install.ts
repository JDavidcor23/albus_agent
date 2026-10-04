import { randomBytes } from 'node:crypto'
import { execFile, type ExecFileException } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { agentsCodeDir } from '../paths'
import { parseAgentJson, type AgentManifest } from '../core/hub/manifest'
import { buildSystemEnv } from '../core/hub/env'
import { resolveBinary } from '../providers/cli-common'
import { resolveProgram } from './process'
import { runAgent } from './runner'

/**
 * The minimal marketplace: turn a source (a git URL, a local folder with or
 * without `.git`, or a local folder to develop in place) into an installed
 * agent under `agents/<id>/`. See `.claude/docs/agents-hub.md`.
 *
 * There is deliberately no uninstall yet. A `link` install is a filesystem
 * junction, and `rmSync({ recursive: true })` on the wrong path deletes the
 * agent's ORIGINAL folder, not a copy. That needs its own careful pass.
 */

export interface InstallStep {
  step: string
  ok: boolean
  detail: string
}

export interface InstallReport {
  ok: boolean
  id: string | null
  dir: string | null
  steps: InstallStep[]
}

export interface InstallOptions {
  source: string
  link?: boolean
  hubDir?: string
  onStep?: (step: InstallStep) => void
  /**
   * Forwarded to the automatic `check` run. Exists so a check script can
   * isolate a question the fixture agent raises during install from the
   * user's real question queue — same reasoning as `hubDir`.
   */
  onQuestion?: (agentId: string, question: string, opts: { context?: string; options?: string[] }) => void
}

const COPY_SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'out'])
const CLONE_TIMEOUT_MS = 5 * 60_000
const DEPS_TIMEOUT_MS = 10 * 60_000
const CHECK_TIMEOUT_MS = 5 * 60_000

const gitCache: { value: string | null | undefined } = { value: undefined }

function isGitUrl(source: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/)/i.test(source)
}

function exitCodeFromExecError(error: ExecFileException | null): number {
  if (error === null) return 0
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : 1
}

function runCommand(
  file: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number }
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((settle) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        windowsHide: true,
        encoding: 'utf8',
        // Without this, execFile defaults to the full `process.env` —
        // including Albus's Supabase service_role key — for `git clone` and
        // `npm ci`/`npm install`. Same allowlist the agent's own run gets;
        // see `core/hub/env.ts`.
        env: buildSystemEnv(process.env)
      },
      (error, stdout, stderr) => {
        settle({ code: exitCodeFromExecError(error), stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}

async function cloneGit(source: string, destination: string): Promise<{ ok: boolean; detail: string }> {
  const git = await resolveBinary('git', gitCache)
  if (git === null) return { ok: false, detail: 'git is not resolvable on PATH' }

  // `--` separates the URL from any option-looking argument (a path starting with `-`).
  const result = await runCommand(git, ['clone', '--depth', '1', '--', source, destination], {
    timeoutMs: CLONE_TIMEOUT_MS
  })
  if (result.code === 0) return { ok: true, detail: destination }
  return { ok: false, detail: result.stderr.trim().slice(0, 500) || `git clone exited with code ${result.code}` }
}

function copyAgentSource(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  for (const name of readdirSync(source)) {
    if (COPY_SKIP.has(name)) continue
    if (name.startsWith('.env')) continue
    cpSync(join(source, name), join(destination, name), { recursive: true })
  }
}

/**
 * Validates an `agent.json` body without yet knowing which folder it will
 * land in — the folder name for a fresh install IS the id the manifest
 * declares. Reuses `parseAgentJson`'s schema check by feeding it the id it
 * reads back out of the same JSON, so the folder-match check inside it is
 * trivially true and the only thing that can fail is the schema itself.
 */
function parseManifestBody(raw: string): { ok: true; manifest: AgentManifest } | { ok: false; reason: string } {
  let idGuess = '__invalid__'
  try {
    const data: unknown = JSON.parse(raw)
    if (typeof data === 'object' && data !== null && typeof (data as { id?: unknown }).id === 'string') {
      idGuess = (data as { id: string }).id
    }
  } catch (error: unknown) {
    return { ok: false, reason: `agent.json is not valid JSON: ${String(error)}` }
  }

  return parseAgentJson(idGuess, raw)
}

async function installDependenciesAndCheck(
  agentId: string,
  dir: string,
  manifest: AgentManifest,
  hubDir: string | undefined,
  isLink: boolean,
  report: (step: string, ok: boolean, detail?: string) => void,
  onQuestion?: (agentId: string, question: string, opts: { context?: string; options?: string[] }) => void
): Promise<void> {
  const hasPackageJson = existsSync(join(dir, 'package.json'))
  const hasNodeModules = existsSync(join(dir, 'node_modules'))

  if (hasPackageJson) {
    if (isLink && hasNodeModules) {
      report('install-dependencies', true, 'node_modules already present (link mode)')
    } else {
      const useCi = existsSync(join(dir, 'package-lock.json'))
      try {
        const resolved = await resolveProgram('npm', useCi ? ['ci'] : ['install'])
        const result = await runCommand(resolved.file, resolved.args, { cwd: dir, timeoutMs: DEPS_TIMEOUT_MS })
        report(
          'install-dependencies',
          result.code === 0,
          result.code === 0 ? (useCi ? 'npm ci' : 'npm install') : result.stderr.trim().slice(0, 500)
        )
      } catch (error: unknown) {
        report('install-dependencies', false, String(error))
      }
    }
  }

  if (manifest.commands.check !== undefined) {
    try {
      const summary = await Promise.race([
        runAgent({ agentId, command: 'check', hubDir, onQuestion }),
        new Promise<null>((r) => setTimeout(() => r(null), CHECK_TIMEOUT_MS))
      ])
      if (summary === null) {
        report('check', false, `check did not finish within ${CHECK_TIMEOUT_MS / 60_000} minute(s)`)
      } else {
        report('check', summary.status === 'ok', summary.message)
      }
    } catch (error: unknown) {
      report('check', false, String(error))
    }
  }
}

export async function installAgent(options: InstallOptions): Promise<InstallReport> {
  const steps: InstallStep[] = []
  const addStep = (step: string, ok: boolean, detail = ''): void => {
    const entry = { step, ok, detail }
    steps.push(entry)
    options.onStep?.(entry)
  }

  const codeDir = options.hubDir !== undefined ? join(options.hubDir, 'agents') : agentsCodeDir()
  mkdirSync(codeDir, { recursive: true })

  const link = options.link === true

  if (link) {
    if (isGitUrl(options.source)) {
      addStep('validate-source', false, 'link mode only accepts a local folder, not a git URL')
      return { ok: false, id: null, dir: null, steps }
    }
    if (!existsSync(options.source)) {
      addStep('validate-source', false, `source does not exist: ${options.source}`)
      return { ok: false, id: null, dir: null, steps }
    }

    const manifestFile = join(options.source, 'agent.json')
    if (!existsSync(manifestFile)) {
      addStep('read-manifest', false, 'source has no agent.json')
      return { ok: false, id: null, dir: null, steps }
    }

    let raw: string
    try {
      raw = readFileSync(manifestFile, 'utf8')
    } catch (error: unknown) {
      addStep('read-manifest', false, String(error))
      return { ok: false, id: null, dir: null, steps }
    }

    const parsed = parseManifestBody(raw)
    if (!parsed.ok) {
      addStep('read-manifest', false, parsed.reason)
      return { ok: false, id: null, dir: null, steps }
    }
    addStep('read-manifest', true, parsed.manifest.id)

    const id = parsed.manifest.id
    const targetDir = join(codeDir, id)
    if (existsSync(targetDir)) {
      addStep('link', false, `already installed: ${targetDir}`)
      return { ok: false, id, dir: targetDir, steps }
    }

    try {
      symlinkSync(resolve(options.source), targetDir, 'junction')
      addStep('link', true, targetDir)
    } catch (error: unknown) {
      addStep('link', false, String(error))
      return { ok: false, id, dir: targetDir, steps }
    }

    await installDependenciesAndCheck(id, targetDir, parsed.manifest, options.hubDir, true, addStep, options.onQuestion)
    return { ok: true, id, dir: targetDir, steps }
  }

  // Non-link: stage first, validate, then move into place — never build
  // directly inside `agents/` so a failed clone never leaves a half folder
  // where a real agent id could later want to live.
  const stagingDir = join(codeDir, `.staging-${randomBytes(4).toString('hex')}`)
  const cleanupStaging = (): void => {
    try {
      rmSync(stagingDir, { recursive: true, force: true })
    } catch {
      // Best-effort: it is only our own staging folder.
    }
  }

  if (isGitUrl(options.source)) {
    const cloned = await cloneGit(options.source, stagingDir)
    addStep('clone', cloned.ok, cloned.detail)
    if (!cloned.ok) {
      cleanupStaging()
      return { ok: false, id: null, dir: null, steps }
    }
  } else if (!existsSync(options.source)) {
    addStep('validate-source', false, `source does not exist: ${options.source}`)
    return { ok: false, id: null, dir: null, steps }
  } else if (existsSync(join(options.source, '.git'))) {
    // Cloning FROM the local folder (instead of copying it) means only what
    // is committed travels — sessions, `.env`, anything in `.gitignore` stays behind.
    const cloned = await cloneGit(options.source, stagingDir)
    addStep('clone', cloned.ok, cloned.detail)
    if (!cloned.ok) {
      cleanupStaging()
      return { ok: false, id: null, dir: null, steps }
    }
  } else {
    try {
      copyAgentSource(options.source, stagingDir)
      addStep('copy', true, stagingDir)
    } catch (error: unknown) {
      addStep('copy', false, String(error))
      cleanupStaging()
      return { ok: false, id: null, dir: null, steps }
    }
  }

  const manifestFile = join(stagingDir, 'agent.json')
  if (!existsSync(manifestFile)) {
    addStep('read-manifest', false, 'source has no agent.json')
    cleanupStaging()
    return { ok: false, id: null, dir: null, steps }
  }

  let raw: string
  try {
    raw = readFileSync(manifestFile, 'utf8')
  } catch (error: unknown) {
    addStep('read-manifest', false, String(error))
    cleanupStaging()
    return { ok: false, id: null, dir: null, steps }
  }

  const parsed = parseManifestBody(raw)
  if (!parsed.ok) {
    addStep('read-manifest', false, parsed.reason)
    cleanupStaging()
    return { ok: false, id: null, dir: null, steps }
  }
  addStep('read-manifest', true, parsed.manifest.id)

  const id = parsed.manifest.id
  const targetDir = join(codeDir, id)
  if (existsSync(targetDir)) {
    addStep('move', false, `already installed: ${targetDir}`)
    cleanupStaging()
    return { ok: false, id, dir: targetDir, steps }
  }

  try {
    renameSync(stagingDir, targetDir)
    addStep('move', true, targetDir)
  } catch (error: unknown) {
    addStep('move', false, String(error))
    cleanupStaging()
    return { ok: false, id, dir: targetDir, steps }
  }

  await installDependenciesAndCheck(id, targetDir, parsed.manifest, options.hubDir, false, addStep, options.onQuestion)
  return { ok: true, id, dir: targetDir, steps }
}
