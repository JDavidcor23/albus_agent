/**
 * Verificador del campo `setup` en agent.json. Corre sin red:
 *
 *   npm run setup:check
 *
 * El dominio puro (`core/hub/manifest.ts`) con los esquemas y validaciones
 * de `setup` — declaraciones de herramientas, variables de entorno, autenticación.
 *
 * Sale con código 1 si algo falla, para poder encadenarlo.
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'

import { AgentJsonSchema, parseAgentJson, type AgentSetup } from '../src/core/hub/manifest'
import { parseDotenv, setDotenvValue } from '../src/core/hub/dotenv'
import { HUB_FOLDER, hubDirFromParent, resolveHubDir, validateHubParent } from '../src/core/hub/hub-location'
import { agentsHavingKey, computeSetupStatus, type DiskFacts } from '../src/core/hub/setup-status'
import {
  KNOWN_TOOLS,
  copyHub,
  currentHubDir,
  findHardcodedHubPaths,
  findScheduledTasksUsing,
  installTool,
  listSetupTargets,
  readEnvFile,
  runAgentCheck,
  setHubDirPersistently,
  verifyHubCopy,
  whichTool,
  writeEnvValue,
  type CommandRunner,
  type RunnerResult
} from '../src/hub/setup-io'
import { albusSetupTarget } from '../src/hub/albus-setup'

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

/**
 * RULE: every call to a setup-io function that changes the machine
 * (setHubDirPersistently → setx, copyHub → robocopy, installTool → winget)
 * goes through one of these fakes, and the check asserts how many times it
 * was called. A check must never be able to touch the machine, not even
 * when the validation in front of the spawn regresses — that is exactly how
 * a check run once left the user's real ALBUS_AGENTS_HUB_DIR set to
 * `relative\path`.
 */
function fakeRunner(result: Partial<RunnerResult> = {}): {
  runner: CommandRunner
  calls: { file: string; args: string[] }[]
} {
  const calls: { file: string; args: string[] }[] = []
  const runner: CommandRunner = async (file, args) => {
    calls.push({ file, args })
    return { code: 0, output: '', timedOut: false, error: '', ...result }
  }
  return { runner, calls }
}

/**
 * Loads `file` with the EXACT reader every agent uses — `process.loadEnvFile`
 * — and reads back `keys`. Run in a throwaway child process (never this
 * process's own `process.env`): `loadEnvFile` has no return value, it writes
 * straight into the env of whatever process calls it, and this check must
 * never let a temp-file secret leak into its own `process.env`.
 */
function loadEnvFileViaChildProcess(file: string, keys: string[]): Record<string, string | undefined> {
  const script = [
    'process.loadEnvFile(process.argv[1]);',
    'const keys = JSON.parse(process.argv[2]);',
    'const out = {};',
    'for (const k of keys) out[k] = process.env[k];',
    'process.stdout.write(JSON.stringify(out));'
  ].join('\n')
  const output = execFileSync(process.execPath, ['-e', script, file, JSON.stringify(keys)], { encoding: 'utf8' })
  return JSON.parse(output) as Record<string, string | undefined>
}

/* ── setup: agent.json ────────────────────────────────────────────────── */

section('manifest: setup')

const base = { protocol: 1, id: 'demo', name: 'Demo', commands: { run: 'npm run x', auth: 'npm run auth' } }

const noSetup = AgentJsonSchema.parse(base)
check('no setup → empty default', noSetup.setup.env.length === 0 && noSetup.setup.envFile === '.env')
check('no draft declared → defaults to false (published)', noSetup.draft === false)

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
check(
  'value with # or space is quoted with single quotes (preferred: literal in both real readers)',
  hash.trim() === "K='a#b c'" && parseDotenv(hash).get('K') === 'a#b c'
)
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

/*
 * Fix round 2 (finding 4) — quoting must pick a style that round-trips
 * through the TWO real readers of these files (`dotenv` package,
 * `process.loadEnvFile`), not just our own `parseDotenv`. Preference order:
 * single quotes (literal in both) > double quotes (safe only with no `'`
 * inside — wait, no `\` and no `"` inside) > backticks (no special handling
 * in either reader) > throw, naming only the key.
 */
check('backtick-quoted value unquotes literally (parseDotenv reads back what we write)', parseDotenv('KEY=`a\\nb`').get('KEY') === 'a\\nb')

const apostropheOnly = setDotenvValue('', 'K', "it's")
check(
  'value with an apostrophe but no backslash/quote uses double quotes',
  apostropheOnly.trim() === 'K="it\'s"' && parseDotenv(apostropheOnly).get('K') === "it's"
)

const apostropheAndBackslash = setDotenvValue('', 'K', "it's a\\path")
check(
  'value with an apostrophe AND a backslash falls back to backticks',
  apostropheAndBackslash.trim() === 'K=`it\'s a\\path`' &&
    parseDotenv(apostropheAndBackslash).get('K') === "it's a\\path"
)

const unquotableValue = "it's a\\path with a `backtick`"
let unquotableThrew = ''
try {
  setDotenvValue('', 'UNQUOTABLE_KEY', unquotableValue)
} catch (e) {
  unquotableThrew = String(e)
}
check(
  'a value needing every quoting style throws, naming only the key, never the value',
  unquotableThrew !== '' && unquotableThrew.includes('UNQUOTABLE_KEY') && !unquotableThrew.includes(unquotableValue)
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

    // Fix round 2 (finding 1) — a dotfolder is a TOOL's own working state
    // (seen in practice: a Kilo Code worktree copy under
    // `mail-triage/.kilo/worktrees/<name>/`, duplicating the agent's own
    // source) — never the agent's real tree. Any dot-prefixed folder must be
    // skipped entirely, not just `.git`.
    const dotDir = path.join(agentDir, '.kilo', 'worktrees', 'some-worktree')
    mkdirSync(dotDir, { recursive: true })
    writeFileSync(
      path.join(dotDir, 'copy.ts'),
      "const resultsDir = path.join(home, 'Documents', 'agents-hub', 'results', 'demo-agent')\n"
    )

    // Fix round 2 (finding 1) — a `*.test.*`/`*.spec.*` file asserting the
    // DEFAULT path is correct (a test fixture, not a bug) must not be flagged.
    writeFileSync(
      path.join(agentDir, 'config.test.ts'),
      "const expected = path.join(home, 'Documents', 'agents-hub')\n"
    )
    writeFileSync(
      path.join(agentDir, 'config.spec.js'),
      "const expected = path.join(home, 'Documents', 'agents-hub')\n"
    )

    const hitsAfterSkips = findHardcodedHubPaths(hubDir)
    check(
      'skips any dot-prefixed folder entirely (e.g. a tool\'s own worktree copy)',
      !hitsAfterSkips.some((h) => h.file.includes(path.join('.kilo', 'worktrees')))
    )
    check(
      'skips a *.test.* file asserting the default path',
      !hitsAfterSkips.some((h) => h.file === path.join(agentDir, 'config.test.ts'))
    )
    check(
      'skips a *.spec.* file asserting the default path',
      !hitsAfterSkips.some((h) => h.file === path.join(agentDir, 'config.spec.js'))
    )
    check(
      'a real (non-dot, non-test) file next to them is still flagged',
      hitsAfterSkips.some((h) => h.file === path.join(agentDir, 'bad.ts'))
    )
  } finally {
    rmSync(hubDir, { recursive: true, force: true })
  }
}

/* ── setup-io: findScheduledTasksUsing (fix round 2 — finding 2) ─────────── */

section('setup-io: findScheduledTasksUsing (fake runner — never spawns schtasks for real)')

/** One CSV field, RFC4180-ish — mirrors exactly what `parseCsvLine` in setup-io.ts expects back. */
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

async function checkFindScheduledTasksUsing(): Promise<void> {
  const oldHub = 'C:\\Users\\PC\\Documents\\agents-hub'

  const header = [
    'HostName', 'TaskName', 'Next Run Time', 'Status', 'Logon Mode', 'Last Run Time', 'Last Result', 'Author',
    'Task To Run', 'Start In', 'Comment', 'Scheduled Task State'
  ]
  const taskToRunValue = `wscript.exe "${oldHub}\\agents\\utel-study\\run-hidden.vbs"`
  const matchingRow = [
    'DESKTOP', '\\utel-study-reminder', 'N/A', 'Ready', 'Interactive/Background', 'N/A', '0', 'PC',
    taskToRunValue, 'N/A', '', 'Enabled'
  ]
  const unrelatedRow = [
    'DESKTOP', '\\unrelated-task', 'N/A', 'Ready', 'Interactive/Background', 'N/A', '0', 'PC',
    'notepad.exe', 'N/A', '', 'Enabled'
  ]
  const csv = [header, matchingRow, unrelatedRow].map((fields) => fields.map(csvField).join(',')).join('\r\n')

  const fake = fakeRunner({ code: 0, output: csv })
  const hits = await findScheduledTasksUsing(oldHub, fake.runner)

  check('findScheduledTasksUsing: runs schtasks /query /fo csv /v (read-only, via fake runner)', fake.calls.length === 1)
  check(
    'findScheduledTasksUsing: never passes /create, /change or any write verb',
    fake.calls[0]?.args.join(' ') === '/query /fo csv /v'
  )
  check('findScheduledTasksUsing: finds the task pointing at the old hub', hits.some((h) => h.taskName === '\\utel-study-reminder'))
  check('findScheduledTasksUsing: ignores an unrelated task', !hits.some((h) => h.taskName === '\\unrelated-task'))
  check('findScheduledTasksUsing: exactly one hit for the fixture', hits.length === 1)

  const differentCase = fakeRunner({ code: 0, output: csv })
  const caseHits = await findScheduledTasksUsing(oldHub.toUpperCase(), differentCase.runner)
  check(
    'findScheduledTasksUsing: match is case-insensitive',
    caseHits.some((h) => h.taskName === '\\utel-study-reminder')
  )

  const noMatch = fakeRunner({ code: 0, output: csv })
  const noHits = await findScheduledTasksUsing('D:\\somewhere-else\\agents-hub', noMatch.runner)
  check('findScheduledTasksUsing: no match → empty, never throws', noHits.length === 0)

  const failing = fakeRunner({ code: 1, output: 'access denied' })
  const failHits = await findScheduledTasksUsing(oldHub, failing.runner)
  check('findScheduledTasksUsing: non-zero exit → empty, never throws', failHits.length === 0)

  const malformed = fakeRunner({ code: 0, output: 'not,a,csv,header\nrow,row,row,row' })
  const malformedHits = await findScheduledTasksUsing(oldHub, malformed.runner)
  check('findScheduledTasksUsing: unrecognized header → empty, never throws', malformedHits.length === 0)
}

/* ── dotenv: round trip through the REAL readers (fix round 2 — finding 4) ── */

section('dotenv: round trip through process.loadEnvFile')

/**
 * `writeEnvValue`/`setDotenvValue` is only safe if what it writes reads back
 * identically through what actually reads these files in production: Node's
 * own `process.loadEnvFile` (every agent, per the hub contract). Our own
 * `parseDotenv` agreeing with itself proves nothing here — this check writes
 * a real file and reads it back with the real reader.
 */
async function checkDotenvRealReaderRoundTrip(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'albus-dotenv-roundtrip-'))
  try {
    const cases: Record<string, string> = {
      HASH_AND_SPACE: 'a#b c',
      EMBEDDED_DOUBLE_QUOTE: 'say "hi"',
      APOSTROPHE: "it's",
      WINDOWS_PATH: 'C:\\path\\to',
      LITERAL_BACKSLASH_N: 'x\\ny' // literal backslash followed by "n" — NOT a real newline
    }

    let text = ''
    for (const [key, value] of Object.entries(cases)) {
      text = setDotenvValue(text, key, value)
    }
    const file = path.join(dir, '.env')
    writeFileSync(file, text, 'utf8')

    const viaLoadEnvFile = loadEnvFileViaChildProcess(file, Object.keys(cases))

    for (const [key, expected] of Object.entries(cases)) {
      check(
        `"${key}" round-trips through process.loadEnvFile`,
        viaLoadEnvFile[key] === expected,
        `got ${JSON.stringify(viaLoadEnvFile[key])}, expected ${JSON.stringify(expected)}`
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
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
    'setup.json asks for no keys: the hub holds none, the provider agents do',
    target.manifest !== null && target.manifest.setup.env.length === 0
  )
  check(
    'setup.json tools and commands parse',
    target.manifest !== null &&
      target.manifest.setup.tools.join(',') === 'git,node,gh' &&
      target.manifest.commands.check === 'npm run hub:check'
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

  const noWinget = fakeRunner()
  const installGuard = await installTool('whisper', noWinget.runner)
  check('installTool refuses a tool with no winget id', !installGuard.ok)
  check('installTool: no winget id → runner called 0 times', noWinget.calls.length === 0)

  const wingetOk = fakeRunner({ code: 0, output: 'Successfully installed' })
  const installed = await installTool('git', wingetOk.runner)
  check('installTool: winget id → runner called exactly once', wingetOk.calls.length === 1)
  check(
    'installTool: runs winget install --id Git.Git -e (args array)',
    wingetOk.calls[0]?.file === 'winget' && wingetOk.calls[0]?.args.slice(0, 4).join(' ') === 'install --id Git.Git -e'
  )
  check('installTool: exit 0 → ok', installed.ok)

  const wingetFail = fakeRunner({ code: 1, output: 'No package found' })
  const notInstalled = await installTool('git', wingetFail.runner)
  check('installTool: non-zero exit → not ok, output kept', !notInstalled.ok && notInstalled.output.includes('No package'))

  const robocopyOk = fakeRunner({ code: 1 })
  const copied = await copyHub('C:\\from-hub', 'D:\\to-hub', robocopyOk.runner)
  check('copyHub: runner called exactly once', robocopyOk.calls.length === 1)
  check(
    'copyHub: robocopy <from> <to> /E /XD node_modules',
    robocopyOk.calls[0]?.file === 'robocopy' &&
      robocopyOk.calls[0]?.args.slice(0, 5).join('|') === 'C:\\from-hub|D:\\to-hub|/E|/XD|node_modules'
  )
  check('copyHub: robocopy exit 1 (files copied) → ok', copied.ok)

  const robocopyFail = fakeRunner({ code: 8, output: 'ERROR 5 Access is denied' })
  check('copyHub: robocopy exit 8 → not ok', !(await copyHub('C:\\a', 'D:\\b', robocopyFail.runner)).ok)

  const robocopyKilled = fakeRunner({ code: null, timedOut: true, error: 'killed' })
  check('copyHub: no exit code (timeout/maxBuffer) → not ok', !(await copyHub('C:\\a', 'D:\\b', robocopyKilled.runner)).ok)

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

section('setup-io: setHubDirPersistently (fake runner — never spawns setx)')

async function checkSetHubDirValidation(): Promise<void> {
  const before = process.env.ALBUS_AGENTS_HUB_DIR
  const restoreEnv = (): void => {
    if (before === undefined) delete process.env.ALBUS_AGENTS_HUB_DIR
    else process.env.ALBUS_AGENTS_HUB_DIR = before
  }

  try {
    const tooLong = fakeRunner()
    let tooLongThrew = ''
    try {
      await setHubDirPersistently('D:\\' + 'x'.repeat(2000), tooLong.runner)
    } catch (error) {
      tooLongThrew = String(error)
    }
    check('setHubDirPersistently rejects a path over 1024 chars', tooLongThrew !== '')
    check('setHubDirPersistently: too long → runner called 0 times', tooLong.calls.length === 0)

    const relative = fakeRunner()
    let relativeThrew = ''
    try {
      await setHubDirPersistently('relative\\path', relative.runner)
    } catch (error) {
      relativeThrew = String(error)
    }
    check('setHubDirPersistently rejects a relative path', relativeThrew !== '')
    check('setHubDirPersistently: relative → runner called 0 times', relative.calls.length === 0)

    const valid = fakeRunner({ code: 0 })
    await setHubDirPersistently('D:\\hub-for-check\\agents-hub', valid.runner)
    check('setHubDirPersistently: valid path → runner called exactly once', valid.calls.length === 1)
    check(
      'setHubDirPersistently: runs setx ALBUS_AGENTS_HUB_DIR <path>',
      valid.calls[0]?.file === 'setx' && valid.calls[0]?.args.join('|') === 'ALBUS_AGENTS_HUB_DIR|D:\\hub-for-check\\agents-hub'
    )
    check('setHubDirPersistently: updates this process env', process.env.ALBUS_AGENTS_HUB_DIR === 'D:\\hub-for-check\\agents-hub')
    restoreEnv()

    const failing = fakeRunner({ code: 1 })
    let failThrew = ''
    try {
      await setHubDirPersistently('D:\\hub-for-check\\agents-hub', failing.runner)
    } catch (error) {
      failThrew = String(error)
    }
    check('setHubDirPersistently: setx exit 1 → throws', failThrew.includes('exited with code 1'))
    check('setHubDirPersistently: setx exit 1 → runner called once', failing.calls.length === 1)
    check('setHubDirPersistently: a failed setx leaves this process env untouched', process.env.ALBUS_AGENTS_HUB_DIR === before)
  } finally {
    restoreEnv()
  }
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
  await checkFindScheduledTasksUsing()
  await checkDotenvRealReaderRoundTrip()

  console.log('\n' + '='.repeat(60))
  console.log(failed === 0 ? `SETUP todo ✓ (${passed} ok)` : `SETUP ${failed} fallo(s), ${passed} ok`)
  console.log('='.repeat(60) + '\n')
  process.exit(failed === 0 ? 0 : 1)
})()
