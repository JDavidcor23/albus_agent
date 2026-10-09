import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { killTree } from '../hub/process'
import type { RunResult } from './screen'

/** `src/tui/` is its own ESM package, so the repo root comes from this file's URL, never from cwd. */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

const SYNC_TIMEOUT_MS = 10 * 60_000
const OUTPUT_TAIL = 8_000

/**
 * `scripts/agents.ps1 sync`, captured. Args array + `shell: false`: nothing
 * here is ever parsed by a shell. The child gets this process's env AS IT IS
 * NOW — `setHubDirPersistently` updates `process.env.ALBUS_AGENTS_HUB_DIR`
 * when the hub moves this session, and `setx` alone would not reach a child
 * of this already-running process. (agents.ps1 is our own script, not a
 * third-party agent, so it gets the user's env, not the agent allowlist.)
 */
export function syncAgents(): Promise<RunResult> {
  const script = join(REPO_ROOT, 'scripts', 'agents.ps1')

  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'sync'], {
      cwd: REPO_ROOT,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    })

    let output = ''
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // The whole tree: agents.ps1 runs git/gh/npm children that child.kill() would orphan.
      killTree(child)
    }, SYNC_TIMEOUT_MS)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, output: `${output}\n${error.message}`.trim() })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const suffix = timedOut ? '\n[timed out]' : ''
      resolve({ ok: code === 0 && !timedOut, output: `${output.trim()}${suffix}` })
    })
  })
}
