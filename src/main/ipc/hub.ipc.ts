import { mkdirSync } from 'node:fs'
import { relative } from 'node:path'
import { dialog, shell } from 'electron'
import { z } from 'zod'
import { registerHandler } from './register-handler'
import { appWindow } from '../app-window'
import { IpcChannels, IpcEvents, type HubAgentEvent, type HubInstallReport, type HubResultFile, type HubRunSummary } from '../../shared/ipc'
import { agentResultsDir, agentsHubDir } from '../paths'
import { listExternalAgents } from '../hub/discover'
import { runAgent, cancelRun } from '../hub/runner'
import { listResults, resolveInsideResults } from '../hub/results'
import { installAgent } from '../hub/install'
import type { AgentEvent } from '../core/hub/protocol'
import type { RunSummary } from '../hub/runner'

/**
 * The hub's IPC surface: discover, run, cancel, install and open external
 * agents. See `.claude/docs/agents-hub.md` for the folder layout and the
 * `agent.json` contract these adapters already implement.
 *
 * `agents:list`/`agents:rules-open`/`agents:answer` (in `jobs.ipc.ts`) already
 * cover listing and talking to an external agent through its rules file —
 * this file is only what is specific to the hub: running its code and
 * managing its install.
 */

/** CONTRACT — same shape as `AGENT_ID_PATTERN` in `core/hub/manifest.ts`: the id arms paths. */
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/
/** A command NAME (`run`, `check`, …), not the line it maps to — that allowlist lives in `core/hub/command.ts`. */
const COMMAND_NAME_PATTERN = /^[a-z0-9:-]{1,40}$/

const RunSchema = z.object({
  agentId: z.string().regex(AGENT_ID_PATTERN),
  command: z.string().regex(COMMAND_NAME_PATTERN).default('run')
})

const AgentIdSchema = z.object({ agentId: z.string().regex(AGENT_ID_PATTERN) })

const OpenSchema = z.object({
  agentId: z.string().regex(AGENT_ID_PATTERN),
  target: z.enum(['code', 'results', 'file']),
  relPath: z.string().max(1000).optional()
})

const InstallSchema = z.object({
  source: z.string().min(1).max(1000),
  link: z.boolean()
})

const MAX_EVENTS = 50

function broadcast(channel: string, payload: unknown): void {
  appWindow()?.webContents.send(channel, payload)
}

/**
 * The agent's own event, with `result.path` turned from the ABSOLUTE path
 * `runner.ts` resolved internally into a path relative to its results
 * folder — an external agent's own folder layout on the user's disk is not
 * the renderer's business, same reasoning as `HubResultFile`.
 */
function toHubEvent(event: AgentEvent, resultsDir: string): HubAgentEvent {
  if (event.type === 'result' && event.path !== null) {
    return { ...event, path: relative(resultsDir, event.path) }
  }
  return event
}

function toHubSummary(summary: RunSummary, resultsDir: string): HubRunSummary {
  return {
    runId: summary.runId,
    agentId: summary.agentId,
    command: summary.command,
    status: summary.status,
    exitCode: summary.exitCode,
    message: summary.message,
    results: summary.results.map((r) => ({
      path: r.path !== null ? relative(resultsDir, r.path) : null,
      message: r.message
    })),
    // Capped here too, on top of `runner.ts`'s own 500: nobody reads more
    // than the tail of a run live, and the summary is not the diagnostic log.
    events: summary.events.slice(-MAX_EVENTS).map((e) => toHubEvent(e, resultsDir))
  }
}

async function openPath(path: string): Promise<{ opened: boolean }> {
  const error = await shell.openPath(path)
  if (error !== '') throw new Error(error)
  return { opened: true }
}

export function registerHubHandlers(): void {
  registerHandler<HubRunSummary>(IpcChannels.HUB_RUN, async (payload) => {
    const { agentId, command } = RunSchema.parse(payload)
    const resultsDir = agentResultsDir(agentId)

    const summary = await runAgent({
      agentId,
      command,
      onEvent: (event) => broadcast(IpcEvents.HUB_EVENT, { agentId, event: toHubEvent(event, resultsDir) })
    })

    return toHubSummary(summary, resultsDir)
  })

  registerHandler<boolean>(IpcChannels.HUB_CANCEL, async (payload) => {
    const { agentId } = AgentIdSchema.parse(payload)
    return cancelRun(agentId)
  })

  registerHandler<HubResultFile[]>(IpcChannels.HUB_RESULTS, async (payload) => {
    const { agentId } = AgentIdSchema.parse(payload)
    return listResults(agentId).map((r) => ({ relPath: r.relPath, size: r.size, modifiedAt: r.modifiedAt }))
  })

  registerHandler<{ opened: boolean }>(IpcChannels.HUB_OPEN, async (payload) => {
    const { agentId, target, relPath } = OpenSchema.parse(payload)

    if (target === 'code') {
      const entry = (await listExternalAgents()).find((e) => e.id === agentId)
      if (entry === undefined) throw new Error(`agent "${agentId}" was not found`)
      return openPath(entry.dir)
    }

    if (target === 'results') {
      const dir = agentResultsDir(agentId)
      mkdirSync(dir, { recursive: true })
      return openPath(dir)
    }

    // target === 'file': must resolve INSIDE the results folder. An agent's
    // own stdout already gets this check in `runner.ts`; this is the same
    // check for a path the RENDERER asks to open.
    if (relPath === undefined) throw new Error('relPath is required to open a file')
    const resolved = resolveInsideResults(agentId, relPath)
    if (resolved === null) throw new Error('that path escapes the results folder')
    return openPath(resolved)
  })

  registerHandler<HubInstallReport>(IpcChannels.HUB_INSTALL, async (payload) => {
    const { source, link } = InstallSchema.parse(payload)
    return installAgent({
      source,
      link,
      onStep: (step) => broadcast(IpcEvents.HUB_INSTALL_STEP, step)
    })
  })

  registerHandler<string | null>(IpcChannels.HUB_PICK_FOLDER, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose the agent folder',
      properties: ['openDirectory']
    })

    // Cancelling is not an error: `null` and the UI shows nothing red.
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  registerHandler<{ opened: boolean }>(IpcChannels.HUB_OPEN_HUB, async () => {
    const dir = agentsHubDir()
    mkdirSync(dir, { recursive: true })
    return openPath(dir)
  })
}
