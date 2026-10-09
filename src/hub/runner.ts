import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { agentResultsDir, agentRunsDir } from '../paths'
import { rulesPath } from '../agents/rules'
import { enqueueQuestion } from '../agents/questions'
import { parseCommand } from '../core/hub/command'
import { buildAgentEnv } from '../core/hub/env'
import { parseEventLine, resolveResultPath, type AgentEvent } from '../core/hub/protocol'
import { listExternalAgents } from './discover'
import { createLineSplitter, killTree, resolveProgram } from './process'

/**
 * Runs one command of one external agent, start to finish.
 *
 * Every precondition failure (unknown agent, unknown command, a command the
 * allowlist rejects, a `node` script that escapes its own folder) resolves
 * to a `failed` summary instead of throwing — same reasoning as the
 * extraction cascade: the caller gets a value it can show the user, not an
 * exception it has to remember to catch.
 */

export interface RunSummary {
  runId: string
  agentId: string
  command: string
  status: 'ok' | 'failed' | 'timeout' | 'cancelled'
  exitCode: number | null
  message: string
  results: { path: string | null; message: string }[]
  /** The last 500 events of the run — more than that and nobody is reading them live anyway. */
  events: AgentEvent[]
}

export interface RunOptions {
  agentId: string
  command?: string
  hubDir?: string
  onEvent?: (event: AgentEvent) => void
  signal?: AbortSignal
  /** Override for tests: the default enqueues into the user's real question queue. */
  onQuestion?: (agentId: string, question: string, opts: { context?: string; options?: string[] }) => void
}

const MAX_EVENTS = 500

interface ActiveRun {
  controller: AbortController
}

const activeRunsMap = new Map<string, ActiveRun>()

/** Agent ids with a run in flight right now. */
export function activeRuns(): string[] {
  return [...activeRunsMap.keys()]
}

/** `true` if there was a run to cancel. Killing the process is async; this only requests it. */
export function cancelRun(agentId: string): boolean {
  const run = activeRunsMap.get(agentId)
  if (run === undefined) return false
  run.controller.abort()
  return true
}

function makeRunId(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const suffix = Math.random().toString(16).slice(2, 6).padEnd(4, '0')
  return `${stamp}-${suffix}`
}

function defaultOnQuestion(
  agentId: string,
  question: string,
  opts: { context?: string; options?: string[] }
): void {
  enqueueQuestion(agentId, question, opts)
}

function failSummary(runId: string, agentId: string, command: string, message: string): RunSummary {
  return { runId, agentId, command, status: 'failed', exitCode: null, message, results: [], events: [] }
}

export async function runAgent(options: RunOptions): Promise<RunSummary> {
  const { agentId, command = 'run', hubDir, onEvent, onQuestion = defaultOnQuestion } = options
  const runId = makeRunId()

  // One run per agent id at a time: a second "run" click while one is still
  // going must not spawn a competing process writing to the same results dir.
  if (activeRunsMap.has(agentId)) {
    return failSummary(runId, agentId, command, `agent "${agentId}" is already running`)
  }

  const agents = await listExternalAgents(hubDir)
  const entry = agents.find((a) => a.id === agentId)
  if (entry === undefined) {
    return failSummary(runId, agentId, command, `agent "${agentId}" was not found`)
  }
  const manifest = entry.manifest
  if (manifest === null) {
    return failSummary(runId, agentId, command, entry.problem || 'agent.json is invalid')
  }

  const line = manifest.commands[command]
  if (line === undefined) {
    return failSummary(runId, agentId, command, `agent "${agentId}" has no command named "${command}"`)
  }

  const parsedCommand = parseCommand(line)
  if (!parsedCommand.ok) {
    return failSummary(runId, agentId, command, `command "${command}" is not allowed: ${parsedCommand.reason}`)
  }

  if (parsedCommand.program === 'node') {
    const scriptArg = parsedCommand.args[0]
    let realScript: string
    let realDir: string
    try {
      realScript = realpathSync(resolve(entry.dir, scriptArg))
      realDir = realpathSync(entry.dir)
    } catch (error: unknown) {
      return failSummary(runId, agentId, command, `script not found: ${scriptArg} (${String(error)})`)
    }
    const rel = relative(realDir, realScript)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return failSummary(runId, agentId, command, `script escapes its own agent folder: ${scriptArg}`)
    }
  }

  const resultsDir = hubDir !== undefined ? join(hubDir, 'results', agentId) : agentResultsDir(agentId)
  mkdirSync(resultsDir, { recursive: true })

  const runsDir = join(agentRunsDir(), agentId)
  mkdirSync(runsDir, { recursive: true })
  const runLogPath = join(runsDir, `${runId}.jsonl`)

  const env = buildAgentEnv(process.env, {
    agentId,
    runId,
    resultsDir,
    rulesPath: rulesPath(agentId)
  })

  let resolved: { file: string; args: string[] }
  try {
    resolved = await resolveProgram(parsedCommand.program, parsedCommand.args)
  } catch (error: unknown) {
    return failSummary(runId, agentId, command, `could not resolve ${parsedCommand.program}: ${String(error)}`)
  }

  const controller = new AbortController()
  activeRunsMap.set(agentId, { controller })

  const events: AgentEvent[] = []
  const results: { path: string | null; message: string }[] = []

  function record(event: AgentEvent): void {
    events.push(event)
    if (events.length > MAX_EVENTS) events.shift()
    try {
      appendFileSync(runLogPath, `${JSON.stringify(event)}\n`, 'utf8')
    } catch {
      // Diagnostic log only — never fail a run over its own diagnostics.
    }
    onEvent?.(event)
  }

  function handleStdoutLine(rawLine: string): void {
    const event = parseEventLine(rawLine)

    if (event.type === 'result') {
      // `event.path` is what the agent SAID; `resolved` is where it actually
      // points once resolved against the real results folder. They can
      // disagree only when the agent tried to escape it.
      const resolvedPath = resolveResultPath(resultsDir, event.path)
      if (event.path !== null && resolvedPath === null) {
        record({ type: 'log', text: `rejected result path escaping results dir: ${event.path}` })
        return
      }
      results.push({ path: resolvedPath, message: event.message })
      record({ ...event, path: resolvedPath })
      return
    }

    if (event.type === 'question') {
      try {
        onQuestion(agentId, event.question, { context: event.context, options: event.options })
      } catch (error: unknown) {
        record({ type: 'log', text: `could not enqueue question: ${String(error)}` })
      }
      record(event)
      return
    }

    record(event)
  }

  function handleStderrLine(rawLine: string): void {
    // stderr is log, not error — the verdict is the exit code, not noise on stderr.
    record({ type: 'log', text: rawLine.length > 4000 ? rawLine.slice(0, 4000) : rawLine })
  }

  return new Promise<RunSummary>((settle) => {
    const child: ChildProcess = spawn(resolved.file, resolved.args, {
      cwd: entry.dir,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const stdoutSplitter = createLineSplitter(handleStdoutLine)
    const stderrSplitter = createLineSplitter(handleStderrLine)

    child.stdout?.on('data', (chunk: Buffer) => stdoutSplitter.push(chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => stderrSplitter.push(chunk.toString('utf8')))

    let timedOut = false
    let cancelled = false

    const timeoutMs = manifest.timeoutMinutes * 60_000
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)

    const onAbort = (): void => {
      cancelled = true
      killTree(child)
    }
    options.signal?.addEventListener('abort', onAbort)
    controller.signal.addEventListener('abort', onAbort)

    function cleanup(): void {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      controller.signal.removeEventListener('abort', onAbort)
      activeRunsMap.delete(agentId)
    }

    child.on('error', (error) => {
      cleanup()
      settle(failSummary(runId, agentId, command, `could not start process: ${String(error)}`))
    })

    child.on('close', (code) => {
      stdoutSplitter.flush()
      stderrSplitter.flush()
      cleanup()

      let status: RunSummary['status']
      let message: string

      if (timedOut) {
        status = 'timeout'
        message = `timed out after ${manifest.timeoutMinutes} minute(s)`
      } else if (cancelled) {
        status = 'cancelled'
        message = 'cancelled'
      } else if (code === 0) {
        status = 'ok'
        const lastResult = [...events].reverse().find((e) => e.type === 'result')
        message = lastResult?.type === 'result' ? lastResult.message : 'done'
      } else {
        status = 'failed'
        const manifestMessage = manifest.exitCodes[String(code ?? '')]
        const lastError = [...events].reverse().find((e) => e.type === 'error')
        message =
          manifestMessage ?? (lastError?.type === 'error' ? lastError.message : `exited with code ${String(code)}`)
      }

      settle({
        runId,
        agentId,
        command,
        status,
        exitCode: code ?? null,
        message,
        results,
        events: events.slice(-MAX_EVENTS)
      })
    })
  })
}
