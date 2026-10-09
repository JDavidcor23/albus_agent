import { execFile, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveBinary } from '../providers/cli-common'

/**
 * Resolving `npm`/`node` the way a hub command must run: `shell: false`,
 * always.
 *
 * `node` is a real `.exe` and `where node` finds it directly. `npm` on
 * Windows is a `.cmd` shim, and `execFile`/`spawn` with `shell: false` cannot
 * launch a `.cmd` on Node >= 20 (it throws `EINVAL`). The fix every other CLI
 * wrapper in this project would reach for — `shell: true` — is exactly what
 * the hub's command allowlist exists to avoid. So `npm run x` becomes
 * `node <npm-cli.js> run x`: `npm-cli.js` is a plain JS file, and running it
 * with the resolved `node.exe` keeps `shell: false` true for every hub
 * command without exception.
 */

const nodeCache: { value: string | null | undefined } = { value: undefined }
const npmCmdCache: { value: string | null | undefined } = { value: undefined }
let npmCliPath: string | null = null

async function resolveNpmCliJs(): Promise<string> {
  if (npmCliPath !== null) return npmCliPath

  const nodeBin = await resolveBinary('node', nodeCache)
  if (nodeBin !== null) {
    const nextToNode = join(dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(nextToNode)) {
      npmCliPath = nextToNode
      return npmCliPath
    }
  }

  // Fallback: some installs (nvm, portable Node) keep npm's package next to
  // npm.cmd instead of next to node.exe.
  const npmCmd = await resolveBinary('npm.cmd', npmCmdCache)
  if (npmCmd !== null) {
    const nextToNpmCmd = join(dirname(npmCmd), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(nextToNpmCmd)) {
      npmCliPath = nextToNpmCmd
      return npmCliPath
    }
  }

  throw new Error('could not find npm-cli.js next to node.exe or next to npm.cmd')
}

export interface ResolvedProgram {
  file: string
  args: string[]
}

/** `args` is everything AFTER `npm`/`node` in the already-validated command. */
export async function resolveProgram(program: 'npm' | 'node', args: string[]): Promise<ResolvedProgram> {
  const nodeBin = await resolveBinary('node', nodeCache)
  if (nodeBin === null) throw new Error('node is not resolvable on PATH ("where node" found nothing)')

  if (program === 'node') return { file: nodeBin, args }

  const npmCli = await resolveNpmCliJs()
  return { file: nodeBin, args: [npmCli, ...args] }
}

/**
 * Kills the whole process tree, not just the one PID. Killing only `npm`
 * leaves its `node` child alive — npm is a thin wrapper that spawns the real
 * work and exits, so the thing actually doing the work survives a plain
 * `child.kill()`.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return

  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {
      // Best-effort: the process may already be gone.
    })
    return
  }

  try {
    child.kill('SIGKILL')
  } catch {
    // Best-effort, same as above.
  }
}

/**
 * Splits a stream's chunks into complete lines. A chunk boundary can land in
 * the middle of a line, and a JSON-lines protocol that reads a half line as a
 * whole one will never parse — so the tail of every chunk is held back until
 * the newline that completes it arrives.
 */
export function createLineSplitter(onLine: (line: string) => void): {
  push: (chunk: string) => void
  flush: () => void
} {
  let pending = ''

  return {
    push(chunk: string): void {
      pending += chunk
      const lines = pending.split(/\r\n|\r|\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) onLine(line)
    },
    flush(): void {
      if (pending !== '') {
        onLine(pending)
        pending = ''
      }
    }
  }
}
