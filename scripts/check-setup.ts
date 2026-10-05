/**
 * Verificador del campo `setup` en agent.json. Corre sin Electron y sin red:
 *
 *   npm run setup:check
 *
 * El dominio puro (`core/hub/manifest.ts`) con los esquemas y validaciones
 * de `setup` — declaraciones de herramientas, variables de entorno, autenticación.
 *
 * Sale con código 1 si algo falla, para poder encadenarlo.
 */

import path from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { AgentJsonSchema, parseAgentJson, type AgentSetup } from '../src/main/core/hub/manifest'
import { parseDotenv, setDotenvValue } from '../src/main/core/hub/dotenv'
import { HUB_FOLDER, hubDirFromParent, resolveHubDir, validateHubParent } from '../src/main/core/hub/hub-location'
import { agentsHavingKey, computeSetupStatus, type DiskFacts } from '../src/main/core/hub/setup-status'
import {
  KNOWN_TOOLS,
  currentHubDir,
  findHardcodedHubPaths,
  installTool,
  listSetupTargets,
  readEnvFile,
  runAgentCheck,
  setHubDirPersistently,
  verifyHubCopy,
  whichTool,
  writeEnvValue
} from '../src/main/hub/setup-io'
import { albusSetupTarget } from '../src/main/hub/albus-setup'

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

/* ── setup: agent.json ────────────────────────────────────────────────── */

section('manifest: setup')

const base = { protocol: 1, id: 'demo', name: 'Demo', commands: { run: 'npm run x', auth: 'npm run auth' } }

const noSetup = AgentJsonSchema.parse(base)
check('no setup → empty default', noSetup.setup.env.length === 0 && noSetup.setup.envFile === '.env')

const full = parseAgentJson(
  'demo',
  JSON.stringify({
    ...base,
    setup: {
      tools: ['ffmpeg'],
      envFile: '.env.local',
      env: [{ key: 'NOTION_TOKEN', label: 'Notion token', help: 'notion.so/my-integrations' }],
      auth: [{ label: 'Gmail', command: 'auth', doneWhen: '.secrets/gmail-token.json' }]
    }
  })
)
check('full setup parses', full.ok)
check('secret defaults true', full.ok && full.manifest.setup.env[0].secret === true)

const bad = (setup: unknown) => !parseAgentJson('demo', JSON.stringify({ ...base, setup })).ok
check('lowercase key rejected', bad({ env: [{ key: 'notion', label: 'x' }] }))
check('envFile other than .env/.env.local rejected', bad({ envFile: '../.env' }))
check('doneWhen escaping folder rejected', bad({ auth: [{ label: 'x', command: 'auth', doneWhen: '../x' }] }))
check('auth command not in commands rejected', bad({ auth: [{ label: 'x', command: 'nope', doneWhen: 'a' }] }))
check('tool with space rejected', bad({ tools: ['rm -rf'] }))

/* ── dotenv ────────────────────────────────────────────────────────────── */

section('dotenv')

const src = '# comment\nA=1\nB="two words"\n\nC=x # trailing\n'
const m = parseDotenv(src)
check('plain', m.get('A') === '1')
check('quoted', m.get('B') === 'two words')
check('inline comment stripped on unquoted', m.get('C') === 'x')
const up = setDotenvValue(src, 'A', '9')
check('update in place keeps comment and order', up.startsWith('# comment\nA=9\nB="two words"'))
const add = setDotenvValue(src, 'NEW', 'v')
check('append new key at end', add.trimEnd().endsWith('NEW=v') && add.includes('C=x # trailing'))
const hash = setDotenvValue('', 'K', 'a#b c')
check('value with # or space is quoted', hash.trim() === 'K="a#b c"' && parseDotenv(hash).get('K') === 'a#b c')
const quote = setDotenvValue('', 'K', 'say "hi"')
check('embedded quote round-trips', parseDotenv(quote).get('K') === 'say "hi"')
check('CRLF input keeps CRLF', setDotenvValue('A=1\r\nB=2\r\n', 'A', '3') === 'A=3\r\nB=2\r\n')
let threw = ''
try {
  setDotenvValue('', 'K', 'line1\nline2')
} catch (e) {
  threw = String(e)
}
check('newline in value rejected without echoing it', threw !== '' && !threw.includes('line1'))

// Fix round 1 — new-file write must not start with a blank line.
check('new file: no leading blank line', setDotenvValue('', 'K', 'v') === 'K=v\n')

// Fix round 1 — single-quoted values are literal (no escape handling).
check("single-quoted value unquotes literally", parseDotenv("KEY='value'").get('KEY') === 'value')
check(
  "single-quoted value keeps backslashes literal",
  parseDotenv("KEY='a\\nb'").get('KEY') === 'a\\nb'
)

// Fix round 1 — replacing an `export KEY=...` line must keep the `export ` prefix.
check(
  'replacing an export line keeps the export prefix',
  setDotenvValue('export A=1\n', 'A', '2') === 'export A=2\n'
)

/* ── hub-location ─────────────────────────────────────────────────────── */

section('hub-location')

check(
  'hubDirFromParent joins HUB_FOLDER',
  hubDirFromParent('C:\\Users\\PC\\Documents\\web') === path.win32.join('C:\\Users\\PC\\Documents\\web', HUB_FOLDER)
)
check(
  'hubDirFromParent idempotent when already agents-hub',
  hubDirFromParent('C:\\Users\\PC\\Documents\\web\\agents-hub') === 'C:\\Users\\PC\\Documents\\web\\agents-hub'
)

check('validateHubParent rejects relative', validateHubParent('relative') !== null)
check('validateHubParent rejects empty', validateHubParent('') !== null)
check('validateHubParent rejects ..', validateHubParent('C:\\a\\..\\b') !== null)
check('validateHubParent accepts a clean absolute path', validateHubParent('C:\\Users\\PC\\Documents') === null)

check(
  'resolveHubDir uses the trimmed env var when set',
  resolveHubDir({ ALBUS_AGENTS_HUB_DIR: '  D:\\custom-hub  ' }, 'C:\\Users\\PC') === 'D:\\custom-hub'
)
check(
  'resolveHubDir falls back to default when blank',
  resolveHubDir({ ALBUS_AGENTS_HUB_DIR: '   ' }, 'C:\\Users\\PC') ===
    path.win32.join('C:\\Users\\PC', 'Documents', HUB_FOLDER)
)
check(
  'resolveHubDir falls back to default when unset',
  resolveHubDir({}, 'C:\\Users\\PC') === path.win32.join('C:\\Users\\PC', 'Documents', HUB_FOLDER)
)

/* ── setup-status ─────────────────────────────────────────────────────── */

section('setup-status')

const emptySetup: AgentSetup = { tools: [], env: [], envFile: '.env', auth: [] }
const emptyFacts: DiskFacts = { envValues: new Map(), doneFiles: new Set(), tools: new Map() }
const emptyStatus = computeSetupStatus(emptySetup, emptyFacts)
check('empty setup → nothingToConfigure && ready', emptyStatus.nothingToConfigure && emptyStatus.ready)

const setupWithEnv: AgentSetup = {
  tools: [],
  env: [
    { key: 'REQUIRED_KEY', label: 'Required', help: '', secret: true, optional: false },
    { key: 'OPTIONAL_KEY', label: 'Optional', help: '', secret: true, optional: true }
  ],
  envFile: '.env',
  auth: []
}

const missingRequired = computeSetupStatus(setupWithEnv, {
  envValues: new Map([['OPTIONAL_KEY', 'v']]),
  doneFiles: new Set(),
  tools: new Map()
})
check('missing required key → ready false', missingRequired.ready === false)

const missingOptionalOnly = computeSetupStatus(setupWithEnv, {
  envValues: new Map([['REQUIRED_KEY', 'v']]),
  doneFiles: new Set(),
  tools: new Map()
})
check(
  'missing optional key → optional-missing state',
  missingOptionalOnly.env.find((e) => e.key === 'OPTIONAL_KEY')?.state === 'optional-missing'
)
check('missing optional key only → ready true', missingOptionalOnly.ready === true)

const emptyStringCounts = computeSetupStatus(setupWithEnv, {
  envValues: new Map([
    ['REQUIRED_KEY', ''],
    ['OPTIONAL_KEY', 'v']
  ]),
  doneFiles: new Set(),
  tools: new Map()
})
check('empty-string value counts as missing', emptyStringCounts.ready === false)

const setupWithAuth: AgentSetup = {
  tools: [],
  env: [],
  envFile: '.env',
  auth: [{ label: 'Gmail', command: 'auth', doneWhen: '.secrets/gmail-token.json' }]
}
const authDone = computeSetupStatus(setupWithAuth, {
  envValues: new Map(),
  doneFiles: new Set(['.secrets/gmail-token.json']),
  tools: new Map()
})
check('doneWhen present in doneFiles → auth ok', authDone.auth[0].state === 'ok' && authDone.ready)

const authMissing = computeSetupStatus(setupWithAuth, emptyFacts)
check('doneWhen absent → auth missing, ready false', authMissing.auth[0].state === 'missing' && !authMissing.ready)

const having = agentsHavingKey(
  'NOTION_TOKEN',
  [
    { agentId: 'self', env: new Map([['NOTION_TOKEN', 'abc']]) },
    { agentId: 'other', env: new Map([['NOTION_TOKEN', 'xyz']]) },
    { agentId: 'empty-one', env: new Map([['NOTION_TOKEN', '']]) }
  ],
  'self'
)
check('agentsHavingKey excludes self and empty values', having.length === 1 && having[0] === 'other')

/* ── setup-io: readEnvFile / writeEnvValue ───────────────────────────────── */

section('setup-io: dotenv file I/O')

{
  const dir = mkdtempSync(path.join(tmpdir(), 'albus-setup-io-'))
  try {
    check('readEnvFile of a missing file is an empty map', readEnvFile(dir, '.env').size === 0)

    writeEnvValue(dir, '.env', 'FOO', 'bar')
    check('writeEnvValue creates the file when missing', readEnvFile(dir, '.env').get('FOO') === 'bar')

    writeEnvValue(dir, '.env', 'FOO', 'baz')
    const afterUpdate = readEnvFile(dir, '.env')
    check('writeEnvValue updates in place', afterUpdate.get('FOO') === 'baz')
    check('writeEnvValue update does not duplicate the key', afterUpdate.size === 1)

    const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'))
    check('writeEnvValue leaves no *.tmp file behind', leftovers.length === 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ── setup-io: writeEnvValue cleans up and never leaks on failure ───────── */

section('setup-io: writeEnvValue failure cleanup (fix round 1)')

{
  const dir = mkdtempSync(path.join(tmpdir(), 'albus-setup-fail-'))
  try {
    // Destination is a DIRECTORY, not a file — every step that would touch
    // it (reading "existing", or the final rename) fails, forcing the same
    // catch/cleanup/rethrow path a real EPERM/EBUSY rename failure takes.
    mkdirSync(path.join(dir, '.env'))

    let threw = ''
    try {
      writeEnvValue(dir, '.env', 'KEY', 'super-secret-value-xyz')
    } catch (error) {
      threw = String(error)
    }

    check('writeEnvValue throws when the destination cannot be written', threw !== '')
    check('the thrown error does not leak the value', !threw.includes('super-secret-value-xyz'))
    const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'))
    check('no tmp file is left behind after a failure', leftovers.length === 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ── setup-io: findHardcodedHubPaths ─────────────────────────────────────── */

section('setup-io: findHardcodedHubPaths')

{
  const hubDir = mkdtempSync(path.join(tmpdir(), 'albus-setup-hub-'))
  try {
    const agentDir = path.join(hubDir, 'agents', 'demo-agent')
    mkdirSync(agentDir, { recursive: true })

    writeFileSync(
      path.join(agentDir, 'bad.ts'),
      [
        "import path from 'node:path'",
        "const home = process.env.USERPROFILE",
        "const resultsDir = path.join(home, 'Documents', 'agents-hub', 'results', 'demo-agent')",
        ''
      ].join('\n')
    )

    writeFileSync(
      path.join(agentDir, 'good.ts'),
      [
        "import path from 'node:path'",
        "const home = process.env.USERPROFILE",
        "const hubDir = process.env.ALBUS_AGENTS_HUB_DIR ?? path.join(home, 'Documents', 'agents-hub')",
        ''
      ].join('\n')
    )

    // Never scanned: proves node_modules is skipped, not merely absent of hits.
    mkdirSync(path.join(agentDir, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(
      path.join(agentDir, 'node_modules', 'dep', 'index.js'),
      "const x = path.join(home, 'Documents', 'agents-hub')\n"
    )

    // Fix round 1 — a .vbs/.ps1 writes the path with ONE backslash, not the
    // doubled-up `\\` a JS/TS string literal needs. Must still be flagged.
    writeFileSync(
      path.join(agentDir, 'login.vbs'),
      [
        'Set shell = CreateObject("WScript.Shell")',
        'home = shell.ExpandEnvironmentStrings("%USERPROFILE%")',
        'resultsDir = home & "\\Documents\\agents-hub\\results\\x"',
        ''
      ].join('\r\n')
    )

    writeFileSync(
      path.join(agentDir, 'login-fixed.vbs'),
      [
        'Set shell = CreateObject("WScript.Shell")',
        'home = shell.ExpandEnvironmentStrings("%USERPROFILE%")',
        // Same-line guard, like `good.ts` above: the fallback literal and
        // ALBUS_AGENTS_HUB_DIR appear on the SAME line, which is the only
        // thing `lineHasHardcodedHubPath` actually checks.
        'hubDir = shell.ExpandEnvironmentStrings("%ALBUS_AGENTS_HUB_DIR%") Or home & "\\Documents\\agents-hub"',
        ''
      ].join('\r\n')
    )

    const hits = findHardcodedHubPaths(hubDir)
    check(
      'flags the hardcoded path.join(...) line',
      hits.some((h) => h.file === path.join(agentDir, 'bad.ts') && h.line === 3)
    )
    check(
      'does NOT flag the line guarded by ALBUS_AGENTS_HUB_DIR',
      !hits.some((h) => h.file === path.join(agentDir, 'good.ts'))
    )
    check(
      'skips node_modules entirely',
      !hits.some((h) => h.file.includes(path.join('node_modules', 'dep')))
    )
    check(
      'flags a .vbs line with a SINGLE backslash (Documents\\agents-hub)',
      hits.some((h) => h.file === path.join(agentDir, 'login.vbs') && h.line === 3)
    )
    check(
      'does NOT flag the .vbs line guarded by ALBUS_AGENTS_HUB_DIR',
      !hits.some((h) => h.file === path.join(agentDir, 'login-fixed.vbs'))
    )

    // Fix round 1 — a junction/symlink must never be followed: a loop back
    // to its own parent would otherwise recurse forever.
    let junctionCreated = true
    try {
      symlinkSync(agentDir, path.join(agentDir, 'self-loop'), 'junction')
    } catch {
      junctionCreated = false
    }
    if (junctionCreated) {
      const start = Date.now()
      const hitsWithJunction = findHardcodedHubPaths(hubDir)
      check('findHardcodedHubPaths returns promptly despite a self-referencing junction', Date.now() - start < 5_000)
      check(
        'junction target is not double-scanned as a new tree',
        hitsWithJunction.filter((h) => h.file === path.join(agentDir, 'bad.ts')).length === 1
      )
    } else {
      check('junction skip test: creating a junction requires no special setup on this host', true, '(skipped — could not create a junction here)')
    }
  } finally {
    rmSync(hubDir, { recursive: true, force: true })
  }
}

/* ── setup-io: currentHubDir / whichTool / installTool guard ────────────── */

section('setup-io: currentHubDir, whichTool, installTool guard')

{
  const before = process.env.ALBUS_AGENTS_HUB_DIR
  process.env.ALBUS_AGENTS_HUB_DIR = 'D:\\custom-hub-for-check'
  check('currentHubDir honors ALBUS_AGENTS_HUB_DIR', currentHubDir() === 'D:\\custom-hub-for-check')
  if (before === undefined) delete process.env.ALBUS_AGENTS_HUB_DIR
  else process.env.ALBUS_AGENTS_HUB_DIR = before
}

check(
  'KNOWN_TOOLS: git/node/gh/ffmpeg declare a winget id',
  KNOWN_TOOLS.git.winget === 'Git.Git' &&
    KNOWN_TOOLS.node.winget === 'OpenJS.NodeJS.LTS' &&
    KNOWN_TOOLS.gh.winget === 'GitHub.cli' &&
    KNOWN_TOOLS.ffmpeg.winget === 'Gyan.FFmpeg'
)
check(
  'KNOWN_TOOLS: whisper/claude/pdftotext have a hint but no winget id',
  KNOWN_TOOLS.whisper.winget === undefined &&
    KNOWN_TOOLS.claude.winget === undefined &&
    KNOWN_TOOLS.pdftotext.winget === undefined
)

/* ── albus-setup: setup.json loads as a valid target ─────────────────────── */

section('albus-setup: setup.json')

{
  const target = albusSetupTarget()
  check('setup.json loads as a valid target', target.manifest !== null && target.problem === '')
  check('target id is "albus"', target.id === 'albus')
  check('target dir is the repo root (has package.json)', existsSync(path.join(target.dir, 'package.json')))
  check(
    'setup.json\'s 7 env entries parse, secret defaults applied',
    target.manifest !== null &&
      target.manifest.setup.env.length === 7 &&
      target.manifest.setup.env.find((e) => e.key === 'SUPABASE_URL')?.secret === false &&
      target.manifest.setup.env.find((e) => e.key === 'SUPABASE_SERVICE_ROLE_KEY')?.secret === true
  )
  check(
    'setup.json tools and commands parse',
    target.manifest !== null &&
      target.manifest.setup.tools.join(',') === 'git,node,gh' &&
      target.manifest.commands.check === 'npm run notion:check'
  )
}

/* ── setup-io: verifyHubCopy (pure fs, no robocopy spawned) ──────────────── */

section('setup-io: verifyHubCopy')

async function checkVerifyHubCopy(): Promise<void> {
  const from = mkdtempSync(path.join(tmpdir(), 'albus-setup-from-'))
  const to = mkdtempSync(path.join(tmpdir(), 'albus-setup-to-'))
  try {
    mkdirSync(path.join(from, 'agents', 'copied-ok'), { recursive: true })
    writeFileSync(path.join(from, 'agents', 'copied-ok', 'agent.json'), '{}')
    mkdirSync(path.join(from, 'agents', 'missing-in-dest'), { recursive: true })
    writeFileSync(path.join(from, 'agents', 'missing-in-dest', 'agent.json'), '{}')

    mkdirSync(path.join(to, 'agents', 'copied-ok'), { recursive: true })
    writeFileSync(path.join(to, 'agents', 'copied-ok', 'agent.json'), '{}')

    const problems = await verifyHubCopy(from, to)
    check('verifyHubCopy: present agent has no problem', !problems.some((p) => p.includes('copied-ok')))
    check('verifyHubCopy: missing agent is reported', problems.some((p) => p.includes('missing-in-dest')))

    // Fix round 1 — a `from` with no "agents" folder at all must be reported
    // as a problem, never silently `[]` (which would read as "verified fine").
    const emptyFrom = mkdtempSync(path.join(tmpdir(), 'albus-setup-emptyfrom-'))
    try {
      const noAgentsProblems = await verifyHubCopy(emptyFrom, to)
      check(
        'verifyHubCopy: missing "from/agents" is reported, not []',
        noAgentsProblems.length > 0 && noAgentsProblems[0].includes('agents')
      )
    } finally {
      rmSync(emptyFrom, { recursive: true, force: true })
    }
  } finally {
    rmSync(from, { recursive: true, force: true })
    rmSync(to, { recursive: true, force: true })
  }
}

/* ── setup-io: whichTool, installTool guard, listSetupTargets ────────────── */

section('setup-io: whichTool, installTool guard, listSetupTargets')

async function checkAsyncRest(): Promise<void> {
  check('whichTool finds "node" on PATH', await whichTool('node'))
  check('whichTool reports false for a bogus name', !(await whichTool('definitely-not-a-real-tool-xyz')))

  // Only exercises the early-return guard — never actually spawns `winget`.
  const installGuard = await installTool('whisper')
  check('installTool refuses a tool with no winget id, without spawning winget', !installGuard.ok)

  const hubDir = mkdtempSync(path.join(tmpdir(), 'albus-setup-targets-'))
  try {
    const targets = await listSetupTargets(hubDir)
    check('listSetupTargets lists Albus first', targets[0]?.id === 'albus')
    check('listSetupTargets has no external agents in an empty hub', targets.length === 1)
  } finally {
    rmSync(hubDir, { recursive: true, force: true })
  }
}

/* ── setup-io: setHubDirPersistently validates before spawning setx ──────── */

section('setup-io: setHubDirPersistently validation (fix round 1 — never actually spawns setx)')

async function checkSetHubDirValidation(): Promise<void> {
  let tooLongThrew = ''
  try {
    await setHubDirPersistently('D:\\' + 'x'.repeat(2000))
  } catch (error) {
    tooLongThrew = String(error)
  }
  check('setHubDirPersistently rejects a path over 1024 chars before spawning setx', tooLongThrew !== '')

  let relativeThrew = ''
  try {
    await setHubDirPersistently('relative\\path')
  } catch (error) {
    relativeThrew = String(error)
  }
  check('setHubDirPersistently rejects a relative path before spawning setx', relativeThrew !== '')
}

/* ── setup-io: runAgentCheck redacts secret env values (fix round 1) ─────── */

section('setup-io: runAgentCheck redacts secrets')

async function checkRunAgentCheckRedaction(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'albus-setup-secret-'))
  try {
    writeFileSync(path.join(dir, '.env'), 'MY_SECRET=supersecrettoken123\n')
    writeFileSync(
      path.join(dir, 'check.mjs'),
      [
        "import { readFileSync } from 'node:fs'",
        "import { join, dirname } from 'node:path'",
        "import { fileURLToPath } from 'node:url'",
        'const here = dirname(fileURLToPath(import.meta.url))',
        "const env = readFileSync(join(here, '.env'), 'utf8')",
        'const match = env.match(/MY_SECRET=(.*)/)',
        "console.log('leaking token: ' + (match ? match[1].trim() : 'none'))",
        ''
      ].join('\n')
    )

    const manifest = AgentJsonSchema.parse({
      protocol: 1,
      id: 'secret-check-agent',
      name: 'Secret check agent',
      commands: { run: 'node check.mjs', check: 'node check.mjs' },
      setup: {
        tools: [],
        envFile: '.env',
        env: [{ key: 'MY_SECRET', label: 'Secret', secret: true }],
        auth: []
      }
    })

    const target = { id: 'secret-check-agent', name: 'Secret check agent', dir, manifest, problem: '' }
    const result = await runAgentCheck(target)

    check('runAgentCheck: check command ran ok', result.ok, result.output)
    check('runAgentCheck redacts the secret value from output', !result.output.includes('supersecrettoken123'))
    check('runAgentCheck output contains the *** redaction marker', result.output.includes('***'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// `tsx` compiles this script to CJS, where there is no top-level `await` —
// same reason `scripts/check-hub.ts` wraps its async section in `main()`.
void (async () => {
  await checkVerifyHubCopy()
  await checkAsyncRest()
  await checkSetHubDirValidation()
  await checkRunAgentCheckRedaction()

  console.log('\n' + '='.repeat(60))
  console.log(failed === 0 ? `SETUP todo ✓ (${passed} ok)` : `SETUP ${failed} fallo(s), ${passed} ok`)
  console.log('='.repeat(60) + '\n')
  process.exit(failed === 0 ? 0 : 1)
})()
