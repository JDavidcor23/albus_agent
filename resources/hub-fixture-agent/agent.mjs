// A plain Node agent, no dependencies, no package.json. It exists to give
// `scripts/check-hub.ts` a real process to spawn through every layer of the
// hub: discovery, the command allowlist, the env allowlist, and the JSON
// lines protocol — instead of asserting against mocks that could drift from
// what a real agent actually prints.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const mode = process.argv[2] ?? '0'

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

// A plain log line: npm banners and console.log calls from a real agent look
// like this, and the protocol parser has to treat it as `log`, not crash.
console.log('fixture: plain stdout line, not an event')

emit({ type: 'progress', message: 'starting', percent: 0 })

// Albus must NOT hand its own process.env to the agent — see core/hub/env.ts.
// This checks that from the inside: if the key leaked, the agent would see it.
const leaked = Object.keys(process.env).some((key) => /SUPABASE|NOTION/i.test(key))
emit({ type: 'progress', message: `leak:${leaked ? 'yes' : 'no'}`, percent: 40 })

emit({ type: 'question', question: 'Keep going with the fixture run?', context: 'fixture', options: ['yes', 'no'] })

if (mode === 'sleep') {
  emit({ type: 'progress', message: 'sleeping until killed', percent: 10 })
  setInterval(() => {}, 60_000)
  // Never exits on its own — the test cancels it and expects `killTree` to end it.
} else {
  const resultsDir = process.env.AGENT_RESULTS_DIR ?? '.'
  mkdirSync(join(resultsDir, 'out'), { recursive: true })
  writeFileSync(join(resultsDir, 'out', 'result.txt'), 'fixture output\n', 'utf8')

  emit({ type: 'result', path: 'out/result.txt', message: 'wrote fixture output' })
  // Must be rejected: it resolves outside AGENT_RESULTS_DIR.
  emit({ type: 'result', path: '../../escape.txt', message: 'this result must be rejected' })

  emit({ type: 'progress', message: 'done', percent: 100 })

  const code = Number(mode)
  process.exit(Number.isFinite(code) ? code : 0)
}
