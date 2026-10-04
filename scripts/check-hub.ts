/**
 * Verificador del hub de agentes externos. Corre sin Electron y sin red:
 *
 *   npx tsx scripts/check-hub.ts
 *
 * Primero el dominio puro (`core/hub/`), después una instalación y dos
 * corridas de verdad contra `resources/hub-fixture-agent` en un `hubDir`
 * temporal — nunca contra la carpeta real del usuario (ver la nota de
 * aislamiento por PARÁMETRO en `.claude/docs/frozen-contracts.md` §5).
 *
 * Sale con código 1 si algo falla, para poder encadenarlo.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { AgentJsonSchema, parseAgentJson } from '../src/main/core/hub/manifest'
import { parseCommand } from '../src/main/core/hub/command'
import { buildAgentEnv, buildSystemEnv } from '../src/main/core/hub/env'
import { parseEventLine, resolveResultPath, type AgentEvent } from '../src/main/core/hub/protocol'
import { installAgent } from '../src/main/hub/install'
import { activeRuns, cancelRun, runAgent } from '../src/main/hub/runner'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    console.log(`  FALLA ${name}${detail === '' ? '' : `  ${detail}`}`)
  }
}

function section(title: string): void {
  console.log(`\n── ${title}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/* ── 1. El dominio puro, sin tocar disco ni binarios ───────────────────────── */

section('manifest: agent.json')

const WHATSAPP_EXAMPLE = {
  protocol: 1,
  id: 'whatsapp-digest',
  name: 'WhatsApp digest',
  description: 'Resume los grupos de WhatsApp y dice qué requiere atención',
  version: '0.1.0',
  commands: { run: 'npm run digest', check: 'npm run check' },
  timeoutMinutes: 30,
  needs: ['sesión de WhatsApp vinculada'],
  schedule: 'daily 08:00',
  exitCodes: { '2': 'La sesión de WhatsApp venció: vincúlala de nuevo con npm run dev' }
}

check('el ejemplo del doc pasa el schema', AgentJsonSchema.safeParse(WHATSAPP_EXAMPLE).success)

const okParsed = parseAgentJson('whatsapp-digest', JSON.stringify(WHATSAPP_EXAMPLE))
check('parseAgentJson acepta id === carpeta', okParsed.ok)

const mismatched = parseAgentJson('otra-carpeta', JSON.stringify(WHATSAPP_EXAMPLE))
check('parseAgentJson rechaza id !== carpeta', !mismatched.ok)

const noRun = parseAgentJson('x', JSON.stringify({ ...WHATSAPP_EXAMPLE, id: 'x', commands: { check: 'npm run check' } }))
check('rechaza un manifiesto sin commands.run', !noRun.ok)

const badExitCodeKey = parseAgentJson(
  'x',
  JSON.stringify({ ...WHATSAPP_EXAMPLE, id: 'x', exitCodes: { dos: 'mal' } })
)
check('rechaza una clave de exitCodes que no es un entero', !badExitCodeKey.ok)

check('runLabel no declarado por defecto queda ""', AgentJsonSchema.parse(WHATSAPP_EXAMPLE).runLabel === '')
const withRunLabel = AgentJsonSchema.safeParse({ ...WHATSAPP_EXAMPLE, runLabel: 'Generate digest' })
check(
  'runLabel declarado se parsea tal cual',
  withRunLabel.success && withRunLabel.data.runLabel === 'Generate digest'
)

section('command: el allowlist de línea')

const accepted = [
  'npm run digest',
  'npm run digest -- --flag=1',
  'npm test',
  'npm start',
  'node agent.mjs 0'
]
for (const line of accepted) {
  check(`acepta "${line}"`, parseCommand(line).ok, JSON.stringify(parseCommand(line)))
}

const rejected = ['npm install x', 'node ../x.js', 'npm run a&b', 'node "agent.js"', 'cmd /c dir', 'npm run a; rm -rf']
for (const line of rejected) {
  const result = parseCommand(line)
  check(`rechaza "${line}"`, !result.ok, JSON.stringify(result))
}

section('protocol: líneas de stdout')

check(
  'progress se parsea',
  parseEventLine('{"type":"progress","message":"leyendo","percent":40}').type === 'progress'
)
check(
  'result se parsea, path null incluido',
  (() => {
    const e = parseEventLine('{"type":"result","path":null,"message":"nada nuevo"}')
    return e.type === 'result' && e.path === null
  })()
)
check(
  'question se parsea con defaults',
  (() => {
    const e = parseEventLine('{"type":"question","question":"¿Y esto?"}')
    return e.type === 'question' && e.context === '' && e.options.length === 0
  })()
)
check('error se parsea', parseEventLine('{"type":"error","message":"no se pudo conectar"}').type === 'error')
check('una línea que no es JSON es log', parseEventLine('npm WARN deprecated algo').type === 'log')
check('un type desconocido es log', parseEventLine('{"type":"future","message":"x"}').type === 'log')
check('un objeto sin type es log', parseEventLine('{"message":"x"}').type === 'log')
check('un array JSON es log, no un evento', parseEventLine('[1,2,3]').type === 'log')

section('protocol: resolveResultPath')

check('una ruta adentro se resuelve', resolveResultPath('/tmp/results', 'out/a.txt') !== null)
check('null se queda null', resolveResultPath('/tmp/results', null) === null)
check('un escape por ../.. se rechaza', resolveResultPath('/tmp/results', '../../escape.txt') === null)
check('un escape por ruta absoluta se rechaza', resolveResultPath('/tmp/results', '/etc/passwd') === null)

section('env: el allowlist, nunca herencia')

const builtEnv = buildAgentEnv(
  {
    PATH: 'C:\\Windows',
    SUPABASE_SERVICE_ROLE_KEY: 'secret-key',
    NOTION_TOKEN: 'notion-secret',
    SOME_RANDOM_VAR: 'should not pass'
  },
  { agentId: 'x', runId: 'r1', resultsDir: '/x/results', rulesPath: '/x/rules.md' }
)
check('PATH sobrevive', builtEnv.PATH === 'C:\\Windows')
check('SUPABASE_SERVICE_ROLE_KEY NO sobrevive', builtEnv.SUPABASE_SERVICE_ROLE_KEY === undefined)
check('NOTION_TOKEN NO sobrevive', builtEnv.NOTION_TOKEN === undefined)
check('una var random NO sobrevive', builtEnv.SOME_RANDOM_VAR === undefined)
check('AGENT_ID se agrega', builtEnv.AGENT_ID === 'x')
check('AGENT_PROTOCOL es "1"', builtEnv.AGENT_PROTOCOL === '1')

/*
 * `buildSystemEnv` is what `install.ts` must pass to `git clone` and
 * `npm ci`/`npm install` — without it, `execFile` defaults to inheriting the
 * full `process.env`, handing those child processes the same service_role
 * key the agent's own run is never allowed to see.
 */
const systemEnv = buildSystemEnv({
  PATH: 'C:\\Windows',
  SUPABASE_SERVICE_ROLE_KEY: 'secret-key',
  NOTION_TOKEN: 'notion-secret'
})
check('buildSystemEnv: PATH sobrevive', systemEnv.PATH === 'C:\\Windows')
check('buildSystemEnv: SUPABASE_SERVICE_ROLE_KEY NO sobrevive', systemEnv.SUPABASE_SERVICE_ROLE_KEY === undefined)
check('buildSystemEnv: NOTION_TOKEN NO sobrevive', systemEnv.NOTION_TOKEN === undefined)
check('buildSystemEnv: no agrega campos de contrato', Object.keys(systemEnv).includes('AGENT_ID') === false)

/* ── 2. Integración: instalar y correr el fixture de verdad ────────────────── */

async function main(): Promise<void> {
  section('integración: instalar y correr el fixture')

  const tmpRoot = mkdtempSync(join(tmpdir(), 'albus-hub-check-'))
  const hubDir = join(tmpRoot, 'agents-hub')
  const fixtureSource = resolve(__dirname, '..', 'resources', 'hub-fixture-agent')

  try {
    const installSteps: string[] = []
    // The fixture's automatic `check` run also raises its one question —
    // collected here instead of the default, which would otherwise write to
    // the user's REAL question queue under their real `agentsDir()`.
    const report = await installAgent({
      source: fixtureSource,
      hubDir,
      onStep: (s) => installSteps.push(`${s.step}:${s.ok ? 'ok' : 'FAIL'}`),
      onQuestion: () => {}
    })

    check('install termina ok', report.ok, installSteps.join(', '))
    check('install devuelve el id del fixture', report.id === 'hub-fixture-agent')
    check(
      'install corrió "check" porque el manifiesto lo declara',
      report.steps.some((s) => s.step === 'check' && s.ok),
      JSON.stringify(report.steps)
    )

    const agentDir = report.dir
    check('el agente quedó en agents/<id>', agentDir !== null && existsSync(join(agentDir, 'agent.json')))

    // El SUPABASE_SERVICE_ROLE_KEY de Albus NO puede llegarle al agente.
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-for-check-hub'

    const questions: { question: string; context: string | undefined }[] = []
    const runEvents: AgentEvent[] = []

    const runSummary = await runAgent({
      agentId: 'hub-fixture-agent',
      command: 'run',
      hubDir,
      onEvent: (e) => runEvents.push(e),
      onQuestion: (_id, question, opts) => questions.push({ question, context: opts.context })
    })

    check('run termina ok', runSummary.status === 'ok', runSummary.message)
    check('exitCode es 0', runSummary.exitCode === 0)

    const resultFile = join(hubDir, 'results', 'hub-fixture-agent', 'out', 'result.txt')
    check('el archivo de resultado existe en disco', existsSync(resultFile))
    check(
      'el resultado válido está en el summary',
      runSummary.results.some((r) => r.path !== null && r.path.endsWith(join('out', 'result.txt')))
    )
    check(
      'el resultado que escapaba NO está en el summary',
      !runSummary.results.some((r) => r.message.includes('must be rejected'))
    )
    check(
      'el escape quedó logueado, no silencioso',
      runEvents.some((e) => e.type === 'log' && e.text.includes('rejected result path'))
    )
    check(
      'el agente NO vio la service_role key de Albus',
      runEvents.some((e) => e.type === 'progress' && e.message === 'leak:no')
    )
    check('la pregunta del fixture se encoló (al collector, no al disco real)', questions.length === 1)
    check('la pregunta trae su contexto', questions[0]?.context === 'fixture')
    check(
      'una línea de consola sin JSON quedó como log',
      runEvents.some((e) => e.type === 'log' && e.text.includes('plain stdout line'))
    )

    const failSummary = await runAgent({
      agentId: 'hub-fixture-agent',
      command: 'fail',
      hubDir,
      onQuestion: () => {}
    })
    check('fail termina failed', failSummary.status === 'failed')
    check(
      'el mensaje de exitCodes se usa',
      failSummary.message === 'fixture says: needs setup',
      failSummary.message
    )

    // Cancelación: se arranca "sleep" (nunca termina solo) y se cancela desde afuera.
    const sleepPromise = runAgent({
      agentId: 'hub-fixture-agent',
      command: 'sleep',
      hubDir,
      onQuestion: () => {}
    })
    await delay(500)
    check('activeRuns ve la corrida en vuelo', activeRuns().includes('hub-fixture-agent'))
    const wasCancelled = cancelRun('hub-fixture-agent')
    check('cancelRun encontró la corrida', wasCancelled)
    const sleepSummary = await sleepPromise
    check('la corrida cancelada termina como "cancelled"', sleepSummary.status === 'cancelled')
    check('activeRuns queda vacío después', !activeRuns().includes('hub-fixture-agent'))

    // Solo una corrida concurrente por agente. Usa "sleep" para la primera:
    // "run" termina en milisegundos y la segunda llamada podría arrancar
    // después de que la primera ya liberó su lugar en `activeRunsMap`.
    const firstRun = runAgent({ agentId: 'hub-fixture-agent', command: 'sleep', hubDir, onQuestion: () => {} })
    await delay(200)
    const secondRun = await runAgent({
      agentId: 'hub-fixture-agent',
      command: 'run',
      hubDir,
      onQuestion: () => {}
    })
    check('una segunda corrida mientras la primera sigue viva falla rápido', secondRun.status === 'failed')
    cancelRun('hub-fixture-agent')
    await firstRun
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

void main().then(() => {
  console.log('\n' + '='.repeat(60))
  console.log(failed === 0 ? `HUB  todo ✓ (${passed} ok)` : `HUB  ${failed} fallo(s), ${passed} ok`)
  console.log('='.repeat(60) + '\n')
  process.exit(failed === 0 ? 0 : 1)
})
