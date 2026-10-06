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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { AgentJsonSchema, parseAgentJson } from '../src/main/core/hub/manifest'
import { parseCommand } from '../src/main/core/hub/command'
import { buildAgentEnv, buildSystemEnv } from '../src/main/core/hub/env'
import { resolveServices, type ManifestEntry } from '../src/main/core/hub/services'
// `resolveHubDir`, not `agentsHubDir()` from `src/main/paths.ts`: that file
// imports `electron`, which this script never does (it runs under plain
// `tsx`), AND its test-mode branch would return a throwaway folder under
// `cacheDir()` instead of the REAL installed hub this WARN section needs to
// scan.
import { resolveHubDir } from '../src/main/core/hub/hub-location'
import { parseEventLine, resolveResultPath, type AgentEvent } from '../src/main/core/hub/protocol'
import { listExternalAgents } from '../src/main/hub/discover'
import { installAgent } from '../src/main/hub/install'
import { activeRuns, cancelRun, runAgent } from '../src/main/hub/runner'
import { findHardcodedHubPaths } from '../src/main/hub/setup-io'

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

check(
  'hidden no declarado (manifiesto viejo) por defecto queda false',
  AgentJsonSchema.parse(WHATSAPP_EXAMPLE).hidden === false
)
const withHidden = AgentJsonSchema.safeParse({ ...WHATSAPP_EXAMPLE, hidden: true })
check('hidden: true se parsea tal cual', withHidden.success && withHidden.data.hidden === true)

check(
  'provides/grants/uses no declarados (manifiesto viejo) quedan en sus defaults vacíos',
  (() => {
    const m = AgentJsonSchema.parse(WHATSAPP_EXAMPLE)
    return m.provides.length === 0 && Object.keys(m.grants).length === 0 && m.uses.length === 0
  })()
)

const withServices = AgentJsonSchema.safeParse({
  ...WHATSAPP_EXAMPLE,
  provides: ['fetch', 'drive.upload'],
  grants: { 'mail-triage': ['gmail-read'], outreach: ['*'] },
  uses: ['google:gmail-read', 'notion:fetch']
})
check('provides/grants/uses del doc parsean tal cual', withServices.success)
check(
  'grants acepta el wildcard "*"',
  withServices.success && withServices.data.grants.outreach?.includes('*') === true
)

check('provides rechaza un nombre con mayúsculas', !AgentJsonSchema.safeParse({ ...WHATSAPP_EXAMPLE, provides: ['Fetch'] }).success)
check(
  'grants rechaza una clave de caller que no es un id de agente válido',
  !AgentJsonSchema.safeParse({ ...WHATSAPP_EXAMPLE, grants: { 'not an id': ['fetch'] } }).success
)
check(
  'uses rechaza una entrada sin "proveedor:servicio"',
  !AgentJsonSchema.safeParse({ ...WHATSAPP_EXAMPLE, uses: ['google'] }).success
)
check(
  'uses acepta un grupo con punto en el servicio (proveedor:grupo.de.scopes)',
  AgentJsonSchema.safeParse({ ...WHATSAPP_EXAMPLE, uses: ['google:workspace.drive'] }).success
)

section('services: resolveServices (puro, sin disco)')

function entry(id: string, overrides: Partial<AgentManifestLike> = {}): ManifestEntry {
  return {
    id,
    manifest: AgentJsonSchema.parse({
      protocol: 1,
      id,
      name: id,
      commands: { run: 'npm run x' },
      ...overrides
    })
  }
}

// `AgentManifestLike` only exists to give `entry()`'s `overrides` a loose
// shape (provides/grants/uses) without importing the full `AgentManifest`
// type — every call goes straight back through `AgentJsonSchema.parse`,
// which is the real validation.
type AgentManifestLike = { provides?: string[]; grants?: Record<string, string[]>; uses?: string[] }

{
  const google = entry('google', { provides: ['fetch'], grants: { 'mail-triage': ['gmail-read'], outreach: ['gmail-send'] } })
  const notion = entry('notion', { provides: ['fetch'], grants: { 'mail-triage': ['*'] } })
  const mailTriage = entry('mail-triage', { uses: ['google:gmail-read', 'notion:fetch'] })
  const outreach = entry('outreach', { uses: ['google:gmail-read'] }) // asks for a scope it was NOT granted
  const orphan = entry('orphan-agent', { uses: ['ghost-provider:fetch'] }) // provider does not exist
  const plain = entry('plain-agent', {}) // declares nothing, must not show up at all

  const resolved = resolveServices([google, notion, mailTriage, outreach, orphan, plain])
  const byId = new Map(resolved.map((r) => [r.consumerId, r.findings]))

  check('un agente sin "uses" no aparece en el resultado', !byId.has('plain-agent'))
  check(
    'mail-triage: ambos "uses" resuelven ok (grant directo + wildcard)',
    byId.get('mail-triage')?.every((f) => f.status === 'ok') === true
  )
  check(
    'outreach: pide un scope que no tiene → not-granted',
    byId.get('outreach')?.[0]?.status === 'not-granted'
  )
  check(
    'orphan-agent: el proveedor no existe → provider-not-installed',
    byId.get('orphan-agent')?.[0]?.status === 'provider-not-installed'
  )

  const brokenProvider: ManifestEntry = { id: 'broken', manifest: null }
  const usesBroken = entry('uses-broken', { uses: ['broken:fetch'] })
  const resolvedBroken = resolveServices([brokenProvider, usesBroken])
  check(
    'un proveedor con manifiesto roto (null) cuenta como no instalado',
    resolvedBroken.find((r) => r.consumerId === 'uses-broken')?.findings[0]?.status === 'provider-not-installed'
  )
}

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

section('hub real: rutas de hub harcodeadas (WARN, nunca FALLA)')

/*
 * Esto mira el hub REAL instalado en esta máquina, no un fixture temporal:
 * un agente externo (fuera de este repo) que hardcodea
 * "Documents\agents-hub" en vez de leer `ALBUS_AGENTS_HUB_DIR` es un bug DE
 * ESE agente, no de Albus — así que nunca debe tumbar el gate de Albus. Por
 * eso cada hit se imprime como WARN y `failed` nunca se toca acá.
 */
const realHubDir = resolveHubDir(process.env, process.env.USERPROFILE ?? homedir())
if (!existsSync(join(realHubDir, 'agents'))) {
  console.log(`  (sin hub instalado en ${realHubDir}; se omite esta sección)`)
} else {
  const hits = findHardcodedHubPaths(realHubDir)
  if (hits.length === 0) {
    console.log(`  ok    ningun agente instalado en ${realHubDir} hardcodea la ruta del hub`)
  } else {
    for (const hit of hits) {
      console.log(`  WARN  ${hit.file}:${hit.line} hardcodea "Documents\\agents-hub" en vez de leer ALBUS_AGENTS_HUB_DIR`)
    }
  }
}

/* ── 2. Integración: instalar y correr el fixture de verdad ────────────────── */

// `tsx` compila a CJS y ahí no hay top-level await — de ahí el envoltorio
// `main()` para todo lo que necesita `await`, incluida la sección de abajo.
async function main(): Promise<void> {
  section('hub real: contrato de servicios (uses → provides/grants), WARN nunca FALLA')

  /*
   * Mismo hub real que la sección de rutas harcodeadas de arriba, y misma
   * regla: un `uses` que apunta a un proveedor sin instalar o que no otorga
   * el grant es un problema DEL AGENTE que lo declaró, no de Albus — nunca
   * toca `failed`. Ver `.claude/docs/agent-services.md`.
   */
  if (!existsSync(join(realHubDir, 'agents'))) {
    console.log(`  (sin hub instalado en ${realHubDir}; se omite esta sección)`)
  } else {
    const realEntries = await listExternalAgents(realHubDir)
    const manifestEntries: ManifestEntry[] = realEntries.map((e) => ({ id: e.id, manifest: e.manifest }))
    const resolved = resolveServices(manifestEntries)

    let anyUnsatisfied = false
    for (const consumer of resolved) {
      for (const finding of consumer.findings) {
        if (finding.status === 'ok') continue
        anyUnsatisfied = true
        const reason =
          finding.status === 'provider-not-installed'
            ? `el proveedor "${finding.providerId}" no está instalado`
            : `"${finding.providerId}" no le otorga el grant "${finding.service}" a "${consumer.consumerId}"`
        console.log(`  WARN  ${consumer.consumerId} usa "${finding.use}" pero ${reason}`)
      }
    }
    if (!anyUnsatisfied) {
      console.log(`  ok    todo "uses" declarado en ${realHubDir} está instalado y otorgado`)
    }
  }

  section('discover: hidden no se filtra en listExternalAgents')

  {
    const hiddenHubRoot = mkdtempSync(join(tmpdir(), 'albus-hub-hidden-'))
    const hiddenAgentDir = join(hiddenHubRoot, 'agents', 'hidden-agent')
    mkdirSync(hiddenAgentDir, { recursive: true })
    writeFileSync(
      join(hiddenAgentDir, 'agent.json'),
      JSON.stringify({
        protocol: 1,
        id: 'hidden-agent',
        name: 'Hidden agent',
        commands: { run: 'npm run start' },
        hidden: true
      })
    )

    try {
      const entries = await listExternalAgents(hiddenHubRoot)
      const hidden = entries.find((e) => e.id === 'hidden-agent')
      // listExternalAgents is the shared source both the CLI and the runner use
      // to resolve an agent by id — it must never drop a `hidden: true` entry.
      // The renderer-facing filter lives in `hub/agent-info.ts`, not here.
      check('listExternalAgents sigue devolviendo el agente oculto', hidden !== undefined)
      check('el manifiesto oculto trae hidden: true', hidden?.manifest?.hidden === true)
      check('un agente oculto válido no tiene problem', hidden?.problem === '')
    } finally {
      rmSync(hiddenHubRoot, { recursive: true, force: true })
    }
  }

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
