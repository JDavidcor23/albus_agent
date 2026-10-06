/**
 * CLI headless del hub de agentes externos. Corre contra las rutas REALES —
 * nunca contra un `hubDir` de prueba: el aislamiento por parámetro es trabajo
 * de `scripts/check-hub.ts`, no de esto. Ver `.claude/docs/agents-hub.md`.
 *
 *   npx tsx scripts/hub.ts list
 *   npx tsx scripts/hub.ts run <id> [command]
 *   npx tsx scripts/hub.ts install <source> [--link]
 */
import type { AgentEvent } from '../src/main/core/hub/protocol'
import { listExternalAgents } from '../src/main/hub/discover'
import { installAgent } from '../src/main/hub/install'
import { runAgent } from '../src/main/hub/runner'

function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'progress':
      console.log(`[progress] ${event.message}${event.percent !== undefined ? ` (${event.percent}%)` : ''}`)
      break
    case 'result':
      console.log(`[result]   ${event.path ?? '(no file)'} — ${event.message}`)
      break
    case 'question':
      console.log(`[question] ${event.question}${event.context !== '' ? ` (${event.context})` : ''}`)
      break
    case 'error':
      console.log(`[error]    ${event.message}`)
      break
    case 'log':
      console.log(`[log]      ${event.text}`)
      break
  }
}

async function cmdList(): Promise<void> {
  const agents = await listExternalAgents()
  if (agents.length === 0) {
    console.log('(no external agents installed)')
    return
  }
  for (const a of agents) {
    const status = a.manifest !== null && a.problem === '' ? 'ok' : `problem: ${a.problem}`
    // The CLI prints every agent, hidden or draft ones included — both flags
    // only opt an agent out of the renderer's list, never out of `hub -- list`.
    const hiddenTag = a.manifest?.hidden === true ? '  (hidden)' : ''
    const draftTag = a.manifest?.draft === true ? '  (draft)' : ''
    console.log(`${a.id}  [${status}]${hiddenTag}${draftTag}  ${a.dir}`)
  }
}

async function cmdRun(id: string | undefined, command: string | undefined): Promise<void> {
  if (id === undefined) {
    console.error('usage: hub run <id> [command]')
    process.exitCode = 1
    return
  }

  const summary = await runAgent({ agentId: id, command: command ?? 'run', onEvent: printEvent })
  console.log(`\n${summary.status.toUpperCase()}  exit=${summary.exitCode ?? '-'}  ${summary.message}`)
  if (summary.status !== 'ok') process.exitCode = 1
}

async function cmdInstall(source: string | undefined, link: boolean): Promise<void> {
  if (source === undefined) {
    console.error('usage: hub install <source> [--link]')
    process.exitCode = 1
    return
  }

  const report = await installAgent({
    source,
    link,
    onStep: (s) => console.log(`${s.ok ? 'ok  ' : 'FAIL'}  ${s.step}  ${s.detail}`)
  })

  console.log(`\n${report.ok ? 'OK' : 'FAILED'}  id=${report.id ?? '-'}  dir=${report.dir ?? '-'}`)
  if (!report.ok) process.exitCode = 1
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)

  if (cmd === 'list') {
    await cmdList()
  } else if (cmd === 'run') {
    await cmdRun(rest[0], rest[1])
  } else if (cmd === 'install') {
    const link = rest.includes('--link')
    const source = rest.find((a) => a !== '--link')
    await cmdInstall(source, link)
  } else {
    console.log('usage: hub list | hub run <id> [command] | hub install <source> [--link]')
    process.exitCode = 1
  }
}

void main()
