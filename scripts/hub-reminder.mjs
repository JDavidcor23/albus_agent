#!/usr/bin/env node
/**
 * Stop-hook reminder, nothing more: "you have unpushed/uncommitted work in
 * agents-hub." Plain Node, zero dependencies (it runs on every Claude Code
 * stop, so it must stay fast and never need `npm install`).
 *
 * Contract: ALWAYS exits 0. Never blocks, never throws past its own
 * try/catch, never touches the network (no `git fetch` -- only local refs,
 * so this stays fast). If there is nothing new to report since the last time
 * THIS session saw it, prints nothing at all.
 *
 * Registered as a Stop hook in .claude/settings.json (this repo) and in
 * .claude/settings.json of the agents-hub monorepo itself -- same script,
 * copied, so the reminder fires from either place the user opens `claude`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function resolveHub() {
  const envHub = (process.env.ALBUS_AGENTS_HUB_DIR ?? '').trim()
  if (envHub !== '') return envHub
  const home = process.env.USERPROFILE ?? homedir()
  return join(home, 'Documents', 'agents-hub')
}

function git(hub, args) {
  try {
    return execFileSync('git', ['-C', hub, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return null
  }
}

/** The path a `git status --porcelain` line names, stripped of its 2-char status + space prefix and any quoting. */
function porcelainPath(line) {
  return line.slice(3).trim().replace(/^"|"$/g, '')
}

function findDraftAgentIds(hub) {
  const agentsDir = join(hub, 'agents')
  const ids = []
  if (!existsSync(agentsDir)) return ids
  let names
  try {
    names = readdirSync(agentsDir)
  } catch {
    return ids
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    try {
      const manifest = JSON.parse(readFileSync(join(agentsDir, name, 'agent.json'), 'utf8'))
      if (manifest && manifest.draft === true) ids.push(name)
    } catch {
      // no agent.json, or not valid JSON -- not this script's job to flag
    }
  }
  return ids.sort()
}

function main() {
  try {
    const raw = readStdin()
    let sessionId = 'unknown'
    try {
      const input = JSON.parse(raw)
      if (input && typeof input.session_id === 'string' && input.session_id !== '') sessionId = input.session_id
    } catch {
      // stdin was empty or not JSON -- fall back to 'unknown', still throttled per-process-run
    }

    const hub = resolveHub()
    if (!existsSync(join(hub, '.git'))) process.exit(0)

    const statusOut = git(hub, ['status', '--porcelain'])
    const lines = statusOut ? statusOut.split(/\r?\n/).filter((l) => l !== '') : []

    const agentLines = lines.filter((l) => porcelainPath(l).startsWith('agents/'))
    const dirtyAgents = new Set()
    for (const line of agentLines) {
      const match = porcelainPath(line).match(/^agents\/([^/]+)\//)
      if (match) dirtyAgents.add(match[1])
    }

    // Ahead of origin/main against whatever is already known locally -- no
    // `git fetch` here on purpose, this hook must stay fast.
    let ahead = 0
    const aheadOut = git(hub, ['rev-list', '--count', 'origin/main..HEAD'])
    if (aheadOut !== null) {
      const parsed = parseInt(aheadOut.trim(), 10)
      if (!Number.isNaN(parsed)) ahead = parsed
    }

    const draftIds = findDraftAgentIds(hub)

    const parts = []
    if (dirtyAgents.size > 0) {
      parts.push(`${agentLines.length} uncommitted file(s) in ${[...dirtyAgents].sort().join(', ')}`)
    }
    if (ahead > 0) parts.push(`${ahead} commit(s) not pushed`)

    const stateParts = [...parts]
    if (draftIds.length > 0) stateParts.push(`drafts: ${draftIds.join(', ')}`)
    const state = stateParts.join('; ')

    if (state === '') process.exit(0)

    const stateFile = join(tmpdir(), `albus-hub-reminder-${sessionId}.txt`)
    let previous = ''
    try {
      previous = readFileSync(stateFile, 'utf8')
    } catch {
      previous = ''
    }

    if (previous === state) process.exit(0)

    try {
      writeFileSync(stateFile, state, 'utf8')
    } catch {
      // best-effort throttle only -- still report this time even if we cannot persist
    }

    process.stdout.write(JSON.stringify({ systemMessage: `agents-hub: ${state}` }) + '\n')
    process.exit(0)
  } catch {
    process.exit(0)
  }
}

main()
