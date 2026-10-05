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

import { AgentJsonSchema, parseAgentJson } from '../src/main/core/hub/manifest'
import { parseDotenv, setDotenvValue } from '../src/main/core/hub/dotenv'

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

console.log('\n' + '='.repeat(60))
console.log(failed === 0 ? `SETUP todo ✓ (${passed} ok)` : `SETUP ${failed} fallo(s), ${passed} ok`)
console.log('='.repeat(60) + '\n')
process.exit(failed === 0 ? 0 : 1)
