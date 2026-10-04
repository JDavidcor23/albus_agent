# mail-triage Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An external Albus hub agent, `mail-triage`, that reads 90 days of Gmail, has Opus propose an email taxonomy, and measures how accurately Jev (TypeSafe System One) classifies those emails against an Opus-labelled, human-corrected ground truth.

**Architecture:** Standalone Node/TypeScript repo at `~/Documents/web/my_proyects/mail-triage`, organised by feature (`gmail`, `taxonomy`, `classify`, `evaluate`, `claude`, `shared`). Pure domain functions are unit-tested with `node --test`; every adapter (Gmail HTTP, Jev SDK, Claude CLI) is injected as a function so tests never touch the network. State lives in `AGENT_RESULTS_DIR` as JSON keyed by Gmail message id; the taxonomy lives in a YAML block inside the Albus rules file (`AGENT_RULES_PATH`).

**Tech Stack:** Node 24 (native TypeScript type stripping — run `node file.ts`, no tsx, no build), TypeScript 5.9 (typecheck only), zod 4.6.5, `yaml` 2.x, `@typesafe-ai/sdk` (latest), Claude Code CLI (`claude -p`).

**Spec:** `docs/superpowers/specs/2026-10-04-mail-triage-phase1-design.md` (in the albus_agent repo). Hub contract: `albus_agent/.claude/docs/agents-hub.md`.

## Global Constraints

- Repo path: `C:\Users\PC\Documents\web\my_proyects\mail-triage` (its own `git init`). Agent id `mail-triage`, equal to the folder name.
- Node ≥ 22.18 for type stripping; machine has v24.14.1. Type-stripping rules: **no `enum`, no `namespace`, no constructor parameter properties**, every relative import ends in `.ts`, type-only imports use `import type`.
- Gmail scope: exactly `https://www.googleapis.com/auth/gmail.readonly`. Never request another scope.
- Opus is called ONLY through the Claude Code CLI with `--tools "" --setting-sources "" --strict-mcp-config --no-session-persistence` and `--model opus`. Prompt goes through stdin, never argv.
- Jev: model default of the SDK (`jev-latest`), API key from `TYPESAFE_API_KEY`. Instructions and criteria in **English**; email content sent as-is (no translation).
- Jev limit: 32k tokens for state + longest question → email body truncated to `MAX_JEV_BODY_CHARS = 12000`.
- Importance labels are frozen: `act_now`, `read_later`, `ignore`.
- Hub protocol: JSON lines on stdout `{"type":"progress"|"result"|"error",...}`; `result.path` relative to `AGENT_RESULTS_DIR`. Exit code `2` = a person must do something; `3` = network/API failure.
- The agent does NOT inherit Albus env. Its own secrets come from `<repo>/.env` (loaded with `process.loadEnvFile`) and `<repo>/.secrets/gmail-token.json`. Both gitignored.
- Default paths when run outside Albus: results `~/Documents/agents-hub/results/mail-triage`, rules `~/Documents/albus_agent/agents/mail-triage.md` (the same files Albus passes).
- Validate per row, never per batch. One bad email → recorded as failed, the run continues.
- All code, identifiers and comments in English. User-facing console messages in English.
- Commits: conventional commits, **no Co-Authored-By / AI attribution lines**.
- Never use `npx rg`.

---

## File Structure

```
mail-triage/
  package.json · tsconfig.json · .gitignore · .env.example · agent.json · README.md
  src/shared/
    config.ts            resolve paths + env; loads .env              (+ config.test.ts)
    hub-events.ts        emit JSON-line events                         (+ hub-events.test.ts)
    json-store.ts        read/write JSON files atomically              (+ json-store.test.ts)
    exit.ts              NeedsPersonError / exit-code mapping
  src/features/gmail/
    oauth.ts             token file, refresh → access token, scope check
    gmail-api.ts         list ids, get metadata, get full message (fetch injected)
    normalize.ts         Gmail payload → MailMeta / MailFull           (+ normalize.test.ts)
    sync.ts              incremental cache of 90 days metadata         (+ sync.test.ts)
  src/features/taxonomy/
    taxonomy.ts          zod schema + types for the YAML block
    rules-file.ts        read/replace the yaml block in the rules .md  (+ rules-file.test.ts)
    group-senders.ts     MailMeta[] → SenderGroup[]                    (+ group-senders.test.ts)
    discover.ts          batches → Opus → consolidate → Taxonomy       (+ discover.test.ts)
  src/features/claude/
    claude-cli.ts        runClaudeJson (copied from whatsapp-digest, translated)
  src/features/classify/
    jev.ts               build questions, classify one mail, retry 429 (+ jev.test.ts)
  src/features/evaluate/
    sample.ts            stratified, seeded sample                     (+ sample.test.ts)
    opus-labels.ts       Opus labels a batch of full mails             (+ opus-labels.test.ts)
    metrics.ts           truth resolution, buckets, verdict            (+ metrics.test.ts)
    report.ts            HTML report (escaped)                         (+ report.test.ts)
  scripts/
    auth.ts · discover.ts · evaluate.ts · review.ts · check.ts
```

Results directory layout (all JSON keyed by Gmail message id):

```
mails.json          Record<id, MailMeta>      (sync)
sample.json         { seed, ids: string[] }   (evaluate, reused across runs)
bodies.json         Record<id, MailFull>      (evaluate, sampled only)
opus-labels.json    Record<id, LabelResult>
jev-labels.json     Record<id, JevResult>
review.json         Record<id, { category?: string; importance?: Importance }>
metrics.json        Metrics
report.html         the report Albus shows
```

---

### Task 1: Scaffold the repo, config, hub events, JSON store

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `agent.json`
- Create: `src/shared/config.ts`, `src/shared/hub-events.ts`, `src/shared/json-store.ts`, `src/shared/exit.ts`
- Test: `src/shared/config.test.ts`, `src/shared/hub-events.test.ts`, `src/shared/json-store.test.ts`

**Interfaces:**
- Produces:
  - `type Config = { repoRoot: string; resultsDir: string; rulesPath: string; tokenPath: string; env: { typesafeApiKey?: string; googleClientId?: string; googleClientSecret?: string } }`
  - `resolveConfig(env: NodeJS.ProcessEnv, home: string, repoRoot: string): Config` (pure)
  - `loadConfig(): Config` (loads `<repoRoot>/.env` if present, then calls `resolveConfig(process.env, os.homedir(), repoRoot)`)
  - `type HubEvent = { type: 'progress'; message: string; percent?: number } | { type: 'result'; path: string | null; message: string } | { type: 'error'; message: string }`
  - `formatEvent(e: HubEvent): string` (pure, one line, no trailing newline) and `emit(e: HubEvent): void`
  - `readJson<T>(file: string, schema: z.ZodType<T>, fallback: T): T` and `writeJson(file: string, value: unknown): void` (atomic: write tmp then rename)
  - `class NeedsPersonError extends Error` and `runMain(main: () => Promise<void>): void` (exit 2 for NeedsPersonError, 3 otherwise, emits an `error` event first)

- [ ] **Step 1: Create the repo and manifest files**

```bash
mkdir -p /c/Users/PC/Documents/web/my_proyects/mail-triage && cd /c/Users/PC/Documents/web/my_proyects/mail-triage && git init -q
```

`package.json`:
```json
{
  "name": "mail-triage",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --test \"src/**/*.test.ts\"",
    "auth": "node scripts/auth.ts",
    "discover": "node scripts/discover.ts",
    "evaluate": "node scripts/evaluate.ts",
    "review": "node scripts/review.ts",
    "check": "node scripts/check.ts"
  },
  "engines": { "node": ">=22.18.0" }
}
```

Then install exact deps:
```bash
npm install zod@4.6.5 yaml @typesafe-ai/sdk && npm install -D typescript@5.9.3 @types/node@24.0.0
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "noUncheckedIndexedAccess": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "scripts/**/*.ts"]
}
```

`.gitignore`:
```
node_modules/
.env
.env.*
!.env.example
# Gmail refresh token: grants read access to the whole mailbox. Never commit.
.secrets/
*.tsbuildinfo
```

`.env.example`:
```
# Desktop-app OAuth client from Google Cloud (Albus's existing desktop client works).
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
# https://typesafe.ai — Jev API key
TYPESAFE_API_KEY=
```

`agent.json`:
```json
{
  "protocol": 1,
  "id": "mail-triage",
  "name": "Mail triage",
  "description": "Discovers an email taxonomy with Opus and measures how well Jev classifies your Gmail",
  "version": "0.1.0",
  "runLabel": "Evaluate Jev",
  "commands": {
    "run": "npm run evaluate",
    "check": "npm run check",
    "discover": "npm run discover"
  },
  "timeoutMinutes": 120,
  "needs": ["Gmail authorized (npm run auth)", "Claude Code logged in", "TYPESAFE_API_KEY in .env"],
  "schedule": "manual",
  "exitCodes": {
    "2": "Something needs you: run `npm run check` in the agent folder and follow what it says",
    "3": "Gmail, Jev or Claude failed (network or API). Try again; details are in the run log"
  }
}
```

- [ ] **Step 2: Write the failing tests**

`src/shared/config.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveConfig } from './config.ts'

const home = path.join('C:', 'Users', 'me')
const repo = path.join('C:', 'repo')

test('uses Albus-provided paths when present', () => {
  const c = resolveConfig({ AGENT_RESULTS_DIR: 'R', AGENT_RULES_PATH: 'P.md' }, home, repo)
  assert.equal(c.resultsDir, 'R')
  assert.equal(c.rulesPath, 'P.md')
})

test('falls back to the same files Albus would pass', () => {
  const c = resolveConfig({}, home, repo)
  assert.equal(c.resultsDir, path.join(home, 'Documents', 'agents-hub', 'results', 'mail-triage'))
  assert.equal(c.rulesPath, path.join(home, 'Documents', 'albus_agent', 'agents', 'mail-triage.md'))
  assert.equal(c.tokenPath, path.join(repo, '.secrets', 'gmail-token.json'))
})

test('blank env values count as missing', () => {
  const c = resolveConfig({ TYPESAFE_API_KEY: '  ' }, home, repo)
  assert.equal(c.env.typesafeApiKey, undefined)
})
```

`src/shared/hub-events.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatEvent } from './hub-events.ts'

test('formats one JSON line per event', () => {
  const line = formatEvent({ type: 'progress', message: 'batch 1/3', percent: 33 })
  assert.deepEqual(JSON.parse(line), { type: 'progress', message: 'batch 1/3', percent: 33 })
  assert.ok(!line.includes('\n'))
})

test('result path may be null', () => {
  assert.deepEqual(JSON.parse(formatEvent({ type: 'result', path: null, message: 'nothing new' })), {
    type: 'result', path: null, message: 'nothing new',
  })
})
```

`src/shared/json-store.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { readJson, writeJson } from './json-store.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-'))
const Schema = z.record(z.string(), z.number())

test('missing file returns the fallback', () => {
  assert.deepEqual(readJson(path.join(dir, 'nope.json'), Schema, {}), {})
})

test('round-trips and creates parent folders', () => {
  const file = path.join(dir, 'a', 'b.json')
  writeJson(file, { x: 1 })
  assert.deepEqual(readJson(file, Schema, {}), { x: 1 })
})

test('corrupt file throws with the file name', () => {
  const file = path.join(dir, 'bad.json')
  fs.writeFileSync(file, '{not json')
  assert.throws(() => readJson(file, Schema, {}), /bad\.json/)
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './config.ts'` (and the others).

- [ ] **Step 4: Implement**

`src/shared/config.ts`:
```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const AGENT_ID = 'mail-triage'

export type Config = {
  repoRoot: string
  resultsDir: string
  rulesPath: string
  tokenPath: string
  env: { typesafeApiKey?: string; googleClientId?: string; googleClientSecret?: string }
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined
}

export function resolveConfig(env: NodeJS.ProcessEnv, home: string, repoRoot: string): Config {
  return {
    repoRoot,
    // Outside Albus we point at the exact files Albus would pass, so a terminal run
    // (auth, review) and an Albus run share the same state.
    resultsDir: nonBlank(env.AGENT_RESULTS_DIR) ?? path.join(home, 'Documents', 'agents-hub', 'results', AGENT_ID),
    rulesPath: nonBlank(env.AGENT_RULES_PATH) ?? path.join(home, 'Documents', 'albus_agent', 'agents', `${AGENT_ID}.md`),
    tokenPath: path.join(repoRoot, '.secrets', 'gmail-token.json'),
    env: {
      typesafeApiKey: nonBlank(env.TYPESAFE_API_KEY),
      googleClientId: nonBlank(env.GOOGLE_CLIENT_ID),
      googleClientSecret: nonBlank(env.GOOGLE_CLIENT_SECRET),
    },
  }
}

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

export function loadConfig(): Config {
  // Albus never passes its own env to an agent: our secrets come from our .env.
  const envFile = path.join(REPO_ROOT, '.env')
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile)
  return resolveConfig(process.env, os.homedir(), REPO_ROOT)
}
```

`src/shared/hub-events.ts`:
```ts
export type HubEvent =
  | { type: 'progress'; message: string; percent?: number }
  | { type: 'result'; path: string | null; message: string }
  | { type: 'error'; message: string }

export function formatEvent(event: HubEvent): string {
  return JSON.stringify(event)
}

export function emit(event: HubEvent): void {
  process.stdout.write(`${formatEvent(event)}\n`)
}
```

`src/shared/json-store.ts`:
```ts
import fs from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'

export function readJson<T>(file: string, schema: z.ZodType<T>, fallback: T): T {
  if (!fs.existsSync(file)) return fallback
  try {
    return schema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    throw new Error(`${path.basename(file)} is corrupt: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  // Rename is atomic: a run killed mid-write never leaves a half-written store.
  fs.renameSync(tmp, file)
}
```

`src/shared/exit.ts`:
```ts
import { emit } from './hub-events.ts'

/** Something only a person can fix (missing key, expired token, draft taxonomy). Exit code 2. */
export class NeedsPersonError extends Error {}

export function runMain(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'error', message })
    console.error(message)
    process.exit(error instanceof NeedsPersonError ? 2 : 3)
  })
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold mail-triage agent with config, hub events and json store"
```

---

### Task 2: Taxonomy schema and the rules-file YAML block

**Files:**
- Create: `src/features/taxonomy/taxonomy.ts`, `src/features/taxonomy/rules-file.ts`
- Test: `src/features/taxonomy/rules-file.test.ts`

**Interfaces:**
- Consumes: `NeedsPersonError` from `src/shared/exit.ts`.
- Produces:
  - `IMPORTANCE = ['act_now', 'read_later', 'ignore'] as const`, `type Importance = typeof IMPORTANCE[number]`
  - `CriterionSchema` / `type Criterion = { what: string; not_for?: string; examples: string[] }`
  - `TaxonomySchema` / `type Taxonomy = { draft: boolean; categories: Record<string, Criterion>; importance: Record<Importance, Criterion> }` — category keys match `^[a-z][a-z0-9_]{1,39}$`, 2..40 categories.
  - `extractYamlBlock(markdown: string): string | null`
  - `parseTaxonomy(markdown: string): Taxonomy | null` — null when there is no block; throws `NeedsPersonError` when the block is invalid.
  - `replaceTaxonomy(markdown: string, taxonomy: Taxonomy): string`
  - `ANSWERS_HEADING = '## Respuestas a lo que el agente preguntó'` (frozen Albus value — do not translate)

- [ ] **Step 1: Write the failing test**

`src/features/taxonomy/rules-file.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANSWERS_HEADING, extractYamlBlock, parseTaxonomy, replaceTaxonomy } from './rules-file.ts'
import type { Taxonomy } from './taxonomy.ts'
import { NeedsPersonError } from '../../shared/exit.ts'

const taxonomy: Taxonomy = {
  draft: true,
  categories: {
    payments: { what: 'Receipts for money already paid', not_for: 'Promotions', examples: ['Your Netflix receipt'] },
    promotions: { what: 'Marketing', examples: [] },
  },
  importance: {
    act_now: { what: 'Needs action today', examples: [] },
    read_later: { what: 'Worth reading', examples: [] },
    ignore: { what: 'Noise', examples: [] },
  },
}

test('no block → null', () => {
  assert.equal(parseTaxonomy('# Rules\n\nfree text'), null)
})

test('replace appends a block and parse reads it back', () => {
  const md = replaceTaxonomy('# Rules\n\nfree text\n', taxonomy)
  assert.deepEqual(parseTaxonomy(md), taxonomy)
  assert.ok(md.startsWith('# Rules\n\nfree text'))
})

test('replace swaps an existing block and keeps everything else', () => {
  const first = replaceTaxonomy('intro\n', taxonomy)
  const second = replaceTaxonomy(first, { ...taxonomy, draft: false })
  assert.equal(parseTaxonomy(second)?.draft, false)
  assert.equal((second.match(/```yaml/g) ?? []).length, 1)
  assert.ok(second.startsWith('intro'))
})

test('a new block goes BEFORE the Albus answers section', () => {
  const md = `intro\n\n${ANSWERS_HEADING}\n\n- yes  <!-- x -->\n`
  const out = replaceTaxonomy(md, taxonomy)
  assert.ok(out.indexOf('```yaml') < out.indexOf(ANSWERS_HEADING))
  assert.ok(out.endsWith('- yes  <!-- x -->\n'))
})

test('invalid block → NeedsPersonError naming the problem', () => {
  const md = '```yaml\ndraft: false\ncategories: {}\n```\n'
  assert.throws(() => parseTaxonomy(md), (e: unknown) => e instanceof NeedsPersonError && /categories/.test(e.message))
})

test('extractYamlBlock handles CRLF files', () => {
  assert.equal(extractYamlBlock('a\r\n```yaml\r\ndraft: true\r\n```\r\n')?.trim(), 'draft: true')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test src/features/taxonomy/rules-file.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/features/taxonomy/taxonomy.ts`:
```ts
import { z } from 'zod'

export const IMPORTANCE = ['act_now', 'read_later', 'ignore'] as const
export type Importance = (typeof IMPORTANCE)[number]

export const CriterionSchema = z.object({
  what: z.string().min(1),
  not_for: z.string().min(1).optional(),
  examples: z.array(z.string()).default([]),
})
export type Criterion = z.infer<typeof CriterionSchema>

const CategoryKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'category keys are snake_case English')

export const TaxonomySchema = z.object({
  draft: z.boolean(),
  categories: z
    .record(CategoryKey, CriterionSchema)
    .refine((c) => Object.keys(c).length >= 2 && Object.keys(c).length <= 40, 'categories must have 2 to 40 entries'),
  importance: z.object({ act_now: CriterionSchema, read_later: CriterionSchema, ignore: CriterionSchema }),
})
export type Taxonomy = z.infer<typeof TaxonomySchema>
```

`src/features/taxonomy/rules-file.ts`:
```ts
import { parse, stringify } from 'yaml'
import { NeedsPersonError } from '../../shared/exit.ts'
import { TaxonomySchema, type Taxonomy } from './taxonomy.ts'

// Frozen Albus value (albus_agent/src/main/agents/questions.ts). Never translate it.
export const ANSWERS_HEADING = '## Respuestas a lo que el agente preguntó'
const SECTION_HEADING = '## Taxonomy'
const BLOCK = /```yaml\r?\n([\s\S]*?)```/

export function extractYamlBlock(markdown: string): string | null {
  return BLOCK.exec(markdown)?.[1] ?? null
}

export function parseTaxonomy(markdown: string): Taxonomy | null {
  const raw = extractYamlBlock(markdown)
  if (raw === null) return null
  let data: unknown
  try {
    data = parse(raw)
  } catch (error) {
    throw new NeedsPersonError(`The taxonomy YAML in the rules file does not parse: ${String(error)}`)
  }
  const result = TaxonomySchema.safeParse(data)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new NeedsPersonError(`The taxonomy in the rules file is invalid — ${issues}`)
  }
  return result.data
}

export function replaceTaxonomy(markdown: string, taxonomy: Taxonomy): string {
  const block = `\`\`\`yaml\n${stringify(taxonomy)}\`\`\``
  if (BLOCK.test(markdown)) return markdown.replace(BLOCK, () => block)

  const section = `${SECTION_HEADING}\n\n${block}\n`
  const answersAt = markdown.indexOf(ANSWERS_HEADING)
  if (answersAt === -1) return `${markdown.replace(/\s*$/, '')}\n\n${section}`
  return `${markdown.slice(0, answersAt)}${section}\n${markdown.slice(answersAt)}`
}
```

- [ ] **Step 4: Run tests**

Run: `node --test src/features/taxonomy/rules-file.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(taxonomy): yaml taxonomy block in the Albus rules file"
```

---

### Task 3: Gmail — OAuth, API client, normalization, `npm run auth`

**Files:**
- Create: `src/features/gmail/oauth.ts`, `src/features/gmail/gmail-api.ts`, `src/features/gmail/normalize.ts`, `scripts/auth.ts`
- Test: `src/features/gmail/normalize.test.ts`

**Interfaces:**
- Consumes: `Config`, `loadConfig`, `writeJson`, `readJson`, `NeedsPersonError`, `runMain`.
- Produces:
  - `GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly'`
  - `getAccessToken(config: Config, fetchFn?: typeof fetch): Promise<{ accessToken: string; scopes: string[] }>` — throws `NeedsPersonError` when the token file or client env is missing, when Google answers `invalid_grant`, or when `gmail.readonly` is not in the scopes.
  - `type GmailApi = { listIds(query: string): Promise<string[]>; getMeta(id: string): Promise<unknown>; getFull(id: string): Promise<unknown> }`
  - `createGmailApi(accessToken: string, fetchFn?: typeof fetch): GmailApi`
  - `type MailMeta = { id: string; threadId: string; from: string; fromAddress: string; subject: string; date: string; snippet: string; labelIds: string[] }`
  - `type MailFull = MailMeta & { body: string }`
  - `toMailMeta(raw: unknown): MailMeta | null` and `toMailFull(raw: unknown): MailFull | null` (null = unparseable row; caller records it as failed)
  - `extractAddress(from: string): string`, `htmlToText(html: string): string`

- [ ] **Step 1: Write the failing test**

`src/features/gmail/normalize.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractAddress, htmlToText, toMailFull, toMailMeta } from './normalize.ts'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

const headers = [
  { name: 'From', value: 'Netflix <info@mailer.netflix.com>' },
  { name: 'Subject', value: 'Tu recibo de octubre' },
  { name: 'Date', value: 'Sat, 3 Oct 2026 10:00:00 -0500' },
]

test('extractAddress handles display names and bare addresses', () => {
  assert.equal(extractAddress('Netflix <Info@Mailer.Netflix.com>'), 'info@mailer.netflix.com')
  assert.equal(extractAddress('jobs@linkedin.com'), 'jobs@linkedin.com')
})

test('toMailMeta reads headers and snippet', () => {
  const m = toMailMeta({ id: '1', threadId: 't', snippet: 'Gracias por tu pago', labelIds: ['INBOX'], payload: { headers } })
  assert.deepEqual(m, {
    id: '1', threadId: 't', from: 'Netflix <info@mailer.netflix.com>', fromAddress: 'info@mailer.netflix.com',
    subject: 'Tu recibo de octubre', date: 'Sat, 3 Oct 2026 10:00:00 -0500', snippet: 'Gracias por tu pago', labelIds: ['INBOX'],
  })
})

test('toMailMeta returns null for garbage', () => {
  assert.equal(toMailMeta({ nope: true }), null)
})

test('toMailFull prefers text/plain inside multipart', () => {
  const raw = {
    id: '2', threadId: 't', snippet: '', payload: {
      headers, mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/html', body: { data: b64('<p>HTML</p>') } },
        { mimeType: 'text/plain', body: { data: b64('Pagaste $10') } },
      ],
    },
  }
  assert.equal(toMailFull(raw)?.body, 'Pagaste $10')
})

test('toMailFull falls back to stripped html', () => {
  const raw = { id: '3', threadId: 't', snippet: '', payload: { headers, mimeType: 'text/html', body: { data: b64('<style>x{}</style><p>Hola&nbsp;<b>mundo</b></p>') } } }
  assert.equal(toMailFull(raw)?.body, 'Hola mundo')
})

test('htmlToText drops scripts and collapses whitespace', () => {
  assert.equal(htmlToText('<script>alert(1)</script><div>a</div>\n\n<div>b &amp; c</div>'), 'a b & c')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test src/features/gmail/normalize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement normalize**

`src/features/gmail/normalize.ts`:
```ts
import { z } from 'zod'

export type MailMeta = {
  id: string; threadId: string; from: string; fromAddress: string
  subject: string; date: string; snippet: string; labelIds: string[]
}
export type MailFull = MailMeta & { body: string }

type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] }

const PartSchema: z.ZodType<Part> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    body: z.object({ data: z.string().optional() }).optional(),
    parts: z.array(PartSchema).optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  }),
)

const MessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  snippet: z.string().default(''),
  labelIds: z.array(z.string()).default([]),
  payload: PartSchema,
})

export function extractAddress(from: string): string {
  const angle = /<([^>]+)>/.exec(from)
  return (angle?.[1] ?? from).trim().toLowerCase()
}

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
}

function header(part: Part, name: string): string {
  return part.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function decode(data: string | undefined): string {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : ''
}

function findPart(part: Part, mimeType: string): Part | null {
  if (part.mimeType === mimeType && part.body?.data) return part
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType)
    if (found) return found
  }
  return null
}

export function toMailMeta(raw: unknown): MailMeta | null {
  const parsed = MessageSchema.safeParse(raw)
  if (!parsed.success) return null
  const { id, threadId, snippet, labelIds, payload } = parsed.data
  const from = header(payload, 'From')
  return {
    id, threadId, from, fromAddress: extractAddress(from),
    subject: header(payload, 'Subject'), date: header(payload, 'Date'), snippet, labelIds,
  }
}

export function toMailFull(raw: unknown): MailFull | null {
  const meta = toMailMeta(raw)
  if (meta === null) return null
  const payload = MessageSchema.parse(raw).payload
  const plain = findPart(payload, 'text/plain')
  const html = findPart(payload, 'text/html')
  const body = plain ? decode(plain.body?.data).replace(/\s+/g, ' ').trim() : htmlToText(decode(html?.body?.data))
  return { ...meta, body }
}
```

- [ ] **Step 4: Run tests**

Run: `node --test src/features/gmail/normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement OAuth and the API client (adapters, no unit test — exercised by `check` in Task 9)**

`src/features/gmail/oauth.ts`:
```ts
import fs from 'node:fs'
import { z } from 'zod'
import type { Config } from '../../shared/config.ts'
import { NeedsPersonError } from '../../shared/exit.ts'

export const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly'

export const TokenFileSchema = z.object({ refresh_token: z.string().min(1), scope: z.string() })

export function requireClient(config: Config): { clientId: string; clientSecret: string } {
  const { googleClientId, googleClientSecret } = config.env
  if (!googleClientId || !googleClientSecret) {
    throw new NeedsPersonError('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing in the agent .env (see .env.example)')
  }
  return { clientId: googleClientId, clientSecret: googleClientSecret }
}

export async function getAccessToken(config: Config, fetchFn: typeof fetch = fetch): Promise<{ accessToken: string; scopes: string[] }> {
  const { clientId, clientSecret } = requireClient(config)
  if (!fs.existsSync(config.tokenPath)) throw new NeedsPersonError('Gmail is not authorized yet: run `npm run auth`')
  const token = TokenFileSchema.parse(JSON.parse(fs.readFileSync(config.tokenPath, 'utf8')))

  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: token.refresh_token, grant_type: 'refresh_token' }),
  })
  const json: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    // invalid_grant = revoked, or a consent screen in "Testing" mode (tokens die after 7 days).
    if (JSON.stringify(json).includes('invalid_grant')) throw new NeedsPersonError('The Gmail token expired or was revoked: run `npm run auth` again')
    throw new Error(`Google token refresh failed (${res.status}): ${JSON.stringify(json)}`)
  }
  const parsed = z.object({ access_token: z.string(), scope: z.string().optional() }).parse(json)
  const scopes = (parsed.scope ?? token.scope).split(/\s+/).filter(Boolean)
  if (!scopes.includes(GMAIL_READONLY)) throw new NeedsPersonError('The Gmail token lacks gmail.readonly: run `npm run auth`')
  return { accessToken: parsed.access_token, scopes }
}
```

`src/features/gmail/gmail-api.ts`:
```ts
import { z } from 'zod'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'

export type GmailApi = {
  listIds(query: string): Promise<string[]>
  getMeta(id: string): Promise<unknown>
  getFull(id: string): Promise<unknown>
}

const ListSchema = z.object({
  messages: z.array(z.object({ id: z.string() })).default([]),
  nextPageToken: z.string().optional(),
})

export function createGmailApi(accessToken: string, fetchFn: typeof fetch = fetch): GmailApi {
  async function get(url: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchFn(url, { headers: { Authorization: `Bearer ${accessToken}` } })
      if (res.ok) return res.json()
      // 429 and 5xx are transient: back off and retry a few times. Anything else is a real error.
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
        continue
      }
      throw new Error(`Gmail ${res.status} for ${url.replace(BASE, '')}: ${(await res.text()).slice(0, 300)}`)
    }
  }

  return {
    async listIds(query) {
      const ids: string[] = []
      let pageToken: string | undefined
      do {
        const url = new URL(BASE)
        url.searchParams.set('q', query)
        url.searchParams.set('maxResults', '500')
        if (pageToken) url.searchParams.set('pageToken', pageToken)
        const page = ListSchema.parse(await get(url.toString()))
        ids.push(...page.messages.map((m) => m.id))
        pageToken = page.nextPageToken
      } while (pageToken)
      return ids
    },
    getMeta: (id) =>
      get(`${BASE}/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`),
    getFull: (id) => get(`${BASE}/${id}?format=full`),
  }
}
```

`scripts/auth.ts` (loopback OAuth, same mechanism as `albus_agent/scripts/gmail-auth.ts`, but writes the token to the agent's own `.secrets/` instead of printing it):
```ts
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { z } from 'zod'
import { loadConfig } from '../src/shared/config.ts'
import { runMain } from '../src/shared/exit.ts'
import { writeJson } from '../src/shared/json-store.ts'
import { GMAIL_READONLY, requireClient } from '../src/features/gmail/oauth.ts'

function openBrowser(url: string): void {
  // `start` needs an empty title before the URL, otherwise it takes the URL as the title.
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true })
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true })
}

runMain(async () => {
  const config = loadConfig()
  const { clientId, clientSecret } = requireClient(config)

  const { code, redirect } = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    let redirect = ''
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const received = url.searchParams.get('code')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(received ? '<h2>Done. Go back to the terminal.</h2>' : '<h2>Authorization failed.</h2>')
      server.close()
      if (received) resolve({ code: received, redirect })
      else reject(new Error(url.searchParams.get('error') ?? 'Google returned no code'))
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') return reject(new Error('could not open a local port'))
      redirect = `http://127.0.0.1:${addr.port}`
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.searchParams.set('client_id', clientId)
      auth.searchParams.set('redirect_uri', redirect)
      auth.searchParams.set('response_type', 'code')
      auth.searchParams.set('scope', GMAIL_READONLY)
      // `consent` forces a fresh refresh_token; without it a second authorization returns none.
      auth.searchParams.set('prompt', 'consent')
      auth.searchParams.set('access_type', 'offline')
      console.log(`Waiting on ${redirect}. If the browser does not open, visit:\n${auth}`)
      openBrowser(auth.toString())
    })
  })

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }),
  })
  const json: unknown = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Google rejected the code: ${JSON.stringify(json)}`)
  const token = z.object({ refresh_token: z.string(), scope: z.string() }).parse(json)
  writeJson(config.tokenPath, token)
  console.log(`Saved to ${config.tokenPath}. Scopes: ${token.scope}`)
})
```

- [ ] **Step 6: Typecheck and test**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(gmail): readonly oauth, api client and message normalization"
```

---

### Task 4: Incremental mail cache (`sync`)

**Files:**
- Create: `src/features/gmail/sync.ts`
- Test: `src/features/gmail/sync.test.ts`

**Interfaces:**
- Consumes: `GmailApi`, `toMailMeta`, `MailMeta`.
- Produces:
  - `SYNC_QUERY = 'newer_than:90d -in:sent -in:chats -in:spam -in:trash'`
  - `type SyncResult = { mails: Record<string, MailMeta>; fetched: number; failed: string[] }`
  - `syncMeta(api: Pick<GmailApi, 'listIds' | 'getMeta'>, cached: Record<string, MailMeta>, onProgress: (done: number, total: number) => void, concurrency?: number): Promise<SyncResult>` — only fetches ids not in `cached`; one failing id is reported in `failed` and does not stop the rest.
  - `mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]>` (exported, reused by evaluate)

- [ ] **Step 1: Write the failing test**

`src/features/gmail/sync.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapPool, syncMeta } from './sync.ts'
import type { MailMeta } from './normalize.ts'

const raw = (id: string) => ({ id, threadId: 't', snippet: 's', payload: { headers: [{ name: 'From', value: `a${id}@x.com` }] } })

test('fetches only ids that are not cached', async () => {
  const asked: string[] = []
  const api = { listIds: async () => ['1', '2', '3'], getMeta: async (id: string) => (asked.push(id), raw(id)) }
  const cached = { '1': { id: '1' } as MailMeta }
  const out = await syncMeta(api, cached, () => {})
  assert.deepEqual(asked.sort(), ['2', '3'])
  assert.deepEqual(Object.keys(out.mails).sort(), ['1', '2', '3'])
  assert.equal(out.fetched, 2)
})

test('a failing id is reported and the rest continue', async () => {
  const api = {
    listIds: async () => ['1', '2'],
    getMeta: async (id: string) => { if (id === '1') throw new Error('boom'); return raw(id) },
  }
  const out = await syncMeta(api, {}, () => {})
  assert.deepEqual(out.failed, ['1'])
  assert.ok(out.mails['2'])
})

test('unparseable payload counts as failed', async () => {
  const api = { listIds: async () => ['1'], getMeta: async () => ({ garbage: true }) }
  assert.deepEqual((await syncMeta(api, {}, () => {})).failed, ['1'])
})

test('mapPool keeps order and limits concurrency', async () => {
  let running = 0, peak = 0
  const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
    running++; peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, 5))
    running--
    return n * 2
  })
  assert.deepEqual(out, [2, 4, 6, 8, 10])
  assert.ok(peak <= 2)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test src/features/gmail/sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/features/gmail/sync.ts`:
```ts
import type { GmailApi } from './gmail-api.ts'
import { toMailMeta, type MailMeta } from './normalize.ts'

export const SYNC_QUERY = 'newer_than:90d -in:sent -in:chats -in:spam -in:trash'

export type SyncResult = { mails: Record<string, MailMeta>; fetched: number; failed: string[] }

export async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return out
}

export async function syncMeta(
  api: Pick<GmailApi, 'listIds' | 'getMeta'>,
  cached: Record<string, MailMeta>,
  onProgress: (done: number, total: number) => void,
  concurrency = 8,
): Promise<SyncResult> {
  const missing = (await api.listIds(SYNC_QUERY)).filter((id) => !(id in cached))
  const mails = { ...cached }
  const failed: string[] = []
  let done = 0
  await mapPool(missing, concurrency, async (id) => {
    try {
      const meta = toMailMeta(await api.getMeta(id))
      if (meta) mails[id] = meta
      else failed.push(id)
    } catch {
      failed.push(id)
    }
    onProgress(++done, missing.length)
  })
  return { mails, fetched: missing.length - failed.length, failed: failed.sort() }
}
```

- [ ] **Step 4: Run tests**

Run: `node --test src/features/gmail/sync.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(gmail): incremental 90-day metadata cache"
```

---

### Task 5: Claude CLI adapter, sender grouping, discover, `npm run discover`

**Files:**
- Create: `src/features/claude/claude-cli.ts`, `src/features/taxonomy/group-senders.ts`, `src/features/taxonomy/discover.ts`, `scripts/discover.ts`
- Test: `src/features/taxonomy/group-senders.test.ts`, `src/features/taxonomy/discover.test.ts`

**Interfaces:**
- Consumes: `MailMeta`, `Taxonomy`, `TaxonomySchema`, `CriterionSchema`, `parseTaxonomy`, `replaceTaxonomy`, `syncMeta`, `createGmailApi`, `getAccessToken`, `loadConfig`, `emit`, `readJson`, `writeJson`, `runMain`, `NeedsPersonError`.
- Produces:
  - `runClaudeJson<T>(opts: { system: string; prompt: string; schema: z.ZodType<T>; model?: string; timeoutMs?: number }): Promise<T>`
  - `type AskClaude = <T>(opts: { system: string; prompt: string; schema: z.ZodType<T> }) => Promise<T>` (in `discover.ts`; scripts pass `(o) => runClaudeJson({ ...o, model: 'opus' })`)
  - `type SenderGroup = { address: string; displayName: string; count: number; subjects: string[]; snippets: string[] }`
  - `groupSenders(mails: MailMeta[]): SenderGroup[]` — sorted by count desc then address; up to 5 distinct subjects and 2 snippets (each ≤ 300 chars).
  - `chunk<T>(items: T[], size: number): T[][]`
  - `discoverTaxonomy(groups: SenderGroup[], ask: AskClaude, onProgress: (message: string, percent: number) => void): Promise<Taxonomy>` — batches of 40 groups, one consolidation call, always returns `draft: true`.

- [ ] **Step 1: Copy the Claude CLI adapter**

Copy `C:\Users\PC\Documents\agents-hub\agents\whatsapp-digest\src\features\claude-handoff\claude-cli.ts` to `src/features/claude/claude-cli.ts` **verbatim in behaviour**, translating the Spanish comments and error messages to English. Keep: the `claude.exe` resolution under `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin`, the `CLAUDE_BIN` override, `--tools '' --setting-sources '' --strict-mcp-config --no-session-persistence`, the `$schema` stripping, prompt via stdin, the 10-minute timeout. Also export `resolveClaudeBinary`.

- [ ] **Step 2: Write the failing tests**

`src/features/taxonomy/group-senders.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunk, groupSenders } from './group-senders.ts'
import type { MailMeta } from '../gmail/normalize.ts'

const mail = (id: string, from: string, subject: string): MailMeta => ({
  id, threadId: id, from, fromAddress: from.toLowerCase(), subject, date: '', snippet: 'x'.repeat(400), labelIds: [],
})

test('groups by address, sorted by volume, with capped samples', () => {
  const mails = [
    mail('1', 'jobs@linkedin.com', 'A'), mail('2', 'jobs@linkedin.com', 'A'), mail('3', 'jobs@linkedin.com', 'B'),
    mail('4', 'info@netflix.com', 'Receipt'),
  ]
  const groups = groupSenders(mails)
  assert.equal(groups[0]?.address, 'jobs@linkedin.com')
  assert.equal(groups[0]?.count, 3)
  assert.deepEqual(groups[0]?.subjects, ['A', 'B'])
  assert.equal(groups[0]?.snippets.length, 2)
  assert.equal(groups[0]?.snippets[0]?.length, 300)
})

test('chunk splits evenly', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})
```

`src/features/taxonomy/discover.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverTaxonomy, type AskClaude } from './discover.ts'
import type { SenderGroup } from './group-senders.ts'

const groups: SenderGroup[] = Array.from({ length: 85 }, (_, i) => ({
  address: `s${i}@x.com`, displayName: `S${i}`, count: 1, subjects: ['hi'], snippets: ['hello'],
}))

const final = {
  categories: {
    payments: { what: 'Receipts', examples: [] },
    promotions: { what: 'Marketing', examples: [] },
  },
  importance: {
    act_now: { what: 'Act', examples: [] }, read_later: { what: 'Later', examples: [] }, ignore: { what: 'Noise', examples: [] },
  },
}

test('3 batches + 1 consolidation, result is always a draft', async () => {
  const prompts: string[] = []
  const ask: AskClaude = async ({ prompt, schema }) => {
    prompts.push(prompt)
    const isConsolidation = prompt.includes('CANDIDATE CATEGORIES')
    return schema.parse(isConsolidation ? final : { categories: [{ key: 'payments', what: 'Receipts', examples: [] }] })
  }
  const taxonomy = await discoverTaxonomy(groups, ask, () => {})
  assert.equal(prompts.length, 4)
  assert.equal(taxonomy.draft, true)
  assert.deepEqual(Object.keys(taxonomy.categories), ['payments', 'promotions'])
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test src/features/taxonomy/group-senders.test.ts src/features/taxonomy/discover.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`src/features/taxonomy/group-senders.ts`:
```ts
import type { MailMeta } from '../gmail/normalize.ts'

export type SenderGroup = { address: string; displayName: string; count: number; subjects: string[]; snippets: string[] }

const MAX_SUBJECTS = 5
const MAX_SNIPPETS = 2
const SNIPPET_CHARS = 300

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function groupSenders(mails: MailMeta[]): SenderGroup[] {
  const byAddress = new Map<string, SenderGroup>()
  for (const m of mails) {
    const g = byAddress.get(m.fromAddress) ?? {
      address: m.fromAddress, displayName: m.from.replace(/<[^>]*>/, '').trim() || m.fromAddress, count: 0, subjects: [], snippets: [],
    }
    g.count++
    if (g.subjects.length < MAX_SUBJECTS && !g.subjects.includes(m.subject)) g.subjects.push(m.subject)
    if (g.snippets.length < MAX_SNIPPETS && m.snippet) g.snippets.push(m.snippet.slice(0, SNIPPET_CHARS))
    byAddress.set(m.fromAddress, g)
  }
  return [...byAddress.values()].sort((a, b) => b.count - a.count || a.address.localeCompare(b.address))
}
```

`src/features/taxonomy/discover.ts`:
```ts
import { z } from 'zod'
import { chunk, type SenderGroup } from './group-senders.ts'
import { CriterionSchema, type Taxonomy } from './taxonomy.ts'

export type AskClaude = <T>(opts: { system: string; prompt: string; schema: z.ZodType<T> }) => Promise<T>

const BATCH_SIZE = 40

const BatchProposalSchema = z.object({
  categories: z.array(CriterionSchema.extend({ key: z.string() })),
})

const FinalSchema = z.object({
  categories: z.record(z.string(), CriterionSchema),
  importance: z.object({ act_now: CriterionSchema, read_later: CriterionSchema, ignore: CriterionSchema }),
})

const SYSTEM = `You design an email taxonomy for ONE person's inbox. The emails are mostly in Spanish.
Write every key, "what", "not_for" in ENGLISH (a small English-first classifier will read them).
Keys are snake_case English. "examples" may quote real subjects verbatim in their original language.
Categories describe WHAT an email is about (payments, subscriptions, job_alerts, ...), never how important it is.`

function renderGroups(groups: SenderGroup[]): string {
  return groups
    .map((g) => `- ${g.displayName} <${g.address}> ×${g.count}\n  subjects: ${g.subjects.join(' | ')}\n  snippets: ${g.snippets.join(' | ')}`)
    .join('\n')
}

export async function discoverTaxonomy(
  groups: SenderGroup[],
  ask: AskClaude,
  onProgress: (message: string, percent: number) => void,
): Promise<Taxonomy> {
  const batches = chunk(groups, BATCH_SIZE)
  const candidates: z.infer<typeof BatchProposalSchema>['categories'] = []

  for (const [i, batch] of batches.entries()) {
    onProgress(`Opus reading senders batch ${i + 1}/${batches.length}`, Math.round((i / (batches.length + 1)) * 100))
    const proposal = await ask({
      system: SYSTEM,
      prompt: `Propose the categories that cover these senders. Each: key, what, not_for (what it must NOT be confused with), examples (2-4 real subjects).\n\nSENDERS:\n${renderGroups(batch)}`,
      schema: BatchProposalSchema,
    })
    candidates.push(...proposal.categories)
  }

  onProgress('Opus consolidating the taxonomy', Math.round((batches.length / (batches.length + 1)) * 100))
  const final = await ask({
    system: SYSTEM,
    prompt: `Merge these CANDIDATE CATEGORIES into one final taxonomy of 6 to 15 categories with no overlaps, plus an "other" category.
Sharpen "not_for" so neighbouring categories cannot be confused.
Also draft importance criteria for this person: act_now (needs action or attention today: charges, due dates, interviews, security alerts), read_later, ignore.
They are a software developer looking for jobs; they will edit these criteria themselves.

CANDIDATE CATEGORIES:
${JSON.stringify(candidates, null, 1)}`,
    schema: FinalSchema,
  })

  return { draft: true, categories: final.categories, importance: final.importance }
}
```

`scripts/discover.ts`:
```ts
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { loadConfig } from '../src/shared/config.ts'
import { emit } from '../src/shared/hub-events.ts'
import { NeedsPersonError, runMain } from '../src/shared/exit.ts'
import { readJson, writeJson } from '../src/shared/json-store.ts'
import { getAccessToken } from '../src/features/gmail/oauth.ts'
import { createGmailApi } from '../src/features/gmail/gmail-api.ts'
import type { MailMeta } from '../src/features/gmail/normalize.ts'
import { syncMeta } from '../src/features/gmail/sync.ts'
import { groupSenders } from '../src/features/taxonomy/group-senders.ts'
import { discoverTaxonomy } from '../src/features/taxonomy/discover.ts'
import { parseTaxonomy, replaceTaxonomy } from '../src/features/taxonomy/rules-file.ts'
import { runClaudeJson } from '../src/features/claude/claude-cli.ts'
import { TaxonomySchema } from '../src/features/taxonomy/taxonomy.ts'

runMain(async () => {
  const config = loadConfig()
  const force = process.argv.includes('--force')
  const rules = fs.existsSync(config.rulesPath) ? fs.readFileSync(config.rulesPath, 'utf8') : `# Mail triage\n`
  const current = parseTaxonomy(rules)
  if (current && !current.draft && !force) {
    throw new NeedsPersonError('An approved taxonomy (draft: false) already exists. Run `npm run discover -- --force` to replace it.')
  }

  const mailsFile = path.join(config.resultsDir, 'mails.json')
  const MailsSchema = z.record(z.string(), z.custom<MailMeta>((v) => typeof v === 'object' && v !== null))
  const cached = readJson(mailsFile, MailsSchema, {})

  const { accessToken } = await getAccessToken(config)
  const api = createGmailApi(accessToken)
  emit({ type: 'progress', message: 'Listing the last 90 days of Gmail', percent: 0 })
  const sync = await syncMeta(api, cached, (done, total) => {
    if (done % 100 === 0 || done === total) emit({ type: 'progress', message: `Gmail metadata ${done}/${total}`, percent: Math.round((done / Math.max(total, 1)) * 30) })
  })
  writeJson(mailsFile, sync.mails)
  if (sync.failed.length) emit({ type: 'progress', message: `${sync.failed.length} emails could not be read and were skipped` })

  const groups = groupSenders(Object.values(sync.mails))
  const taxonomy = await discoverTaxonomy(groups, (o) => runClaudeJson({ ...o, model: 'opus' }), (message, percent) =>
    emit({ type: 'progress', message, percent: 30 + Math.round(percent * 0.7) }),
  )
  TaxonomySchema.parse(taxonomy)

  fs.mkdirSync(path.dirname(config.rulesPath), { recursive: true })
  fs.writeFileSync(config.rulesPath, replaceTaxonomy(rules, taxonomy))
  emit({
    type: 'result', path: null,
    message: `Draft taxonomy with ${Object.keys(taxonomy.categories).length} categories written to the agent rules. Review it in Albus and set draft: false.`,
  })
})
```

- [ ] **Step 5: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(taxonomy): opus discovers a draft taxonomy from 90 days of senders"
```

---

### Task 6: Jev classifier

**Files:**
- Create: `src/features/classify/jev.ts`
- Test: `src/features/classify/jev.test.ts`

**Interfaces:**
- Consumes: `Taxonomy`, `Criterion`, `Importance`, `MailFull`.
- Produces:
  - `MAX_JEV_BODY_CHARS = 12000`
  - `type JevResult = { status: 'ok'; category: string; categoryConfidence: number; importance: Importance; importanceConfidence: number } | { status: 'failed'; error: string }`
  - `type SystemOneCall = (request: { state: unknown; questions: Record<string, unknown> }) => Promise<{ answers: Record<string, { choice: string; confidence: number }> }>`
  - `buildState(mail: MailFull): { from: string; subject: string; date: string; body: string }`
  - `buildQuestions(taxonomy: Taxonomy): { category: unknown; importance: unknown }`
  - `classifyWithJev(mail: MailFull, taxonomy: Taxonomy, call: SystemOneCall, sleep?: (ms: number) => Promise<void>): Promise<JevResult>` — retries up to 4 times only when the error is a rate limit (status 429) or connection error, never on other errors; never throws.
  - `createSystemOneCall(apiKey: string): SystemOneCall` — the real SDK adapter.

- [ ] **Step 1: Verify the SDK criteria shape**

Run: `rg -n "not_for|examples|ChoiceCriteria" node_modules/@typesafe-ai/sdk --glob "*.d.ts" | head -30`
Expected: `ChoiceCriteria` values accept `null | string | { what?, not_for?, examples? }` (or similar). If the object field names differ, adapt `toChoiceCriterion` below to the real names and note it in the commit message. Also note the exported names of the rate-limit and connection error classes (`RateLimitError`, `APIConnectionError` per docs).

- [ ] **Step 2: Write the failing test**

`src/features/classify/jev.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_JEV_BODY_CHARS, buildQuestions, buildState, classifyWithJev, type SystemOneCall } from './jev.ts'
import type { Taxonomy } from '../taxonomy/taxonomy.ts'
import type { MailFull } from '../gmail/normalize.ts'

const taxonomy: Taxonomy = {
  draft: false,
  categories: { payments: { what: 'Receipts', not_for: 'Promos', examples: ['Netflix receipt'] }, other: { what: 'Anything else', examples: [] } },
  importance: { act_now: { what: 'Act', examples: [] }, read_later: { what: 'Later', examples: [] }, ignore: { what: 'Noise', examples: [] } },
}
const mail: MailFull = {
  id: '1', threadId: 't', from: 'N <n@x.com>', fromAddress: 'n@x.com', subject: 'Recibo', date: 'd', snippet: '', labelIds: [],
  body: 'x'.repeat(MAX_JEV_BODY_CHARS + 500),
}
const ok: Awaited<ReturnType<SystemOneCall>> = {
  answers: { category: { choice: 'payments', confidence: 0.93 }, importance: { choice: 'act_now', confidence: 0.71 } },
}
const noSleep = async () => {}

test('state truncates the body', () => {
  assert.equal(buildState(mail).body.length, MAX_JEV_BODY_CHARS)
})

test('questions carry every category key and the three importance keys', () => {
  const q = buildQuestions(taxonomy) as { category: { criteria: object }; importance: { criteria: object } }
  assert.deepEqual(Object.keys(q.category.criteria), ['payments', 'other'])
  assert.deepEqual(Object.keys(q.importance.criteria), ['act_now', 'read_later', 'ignore'])
})

test('maps answers to a result', async () => {
  const r = await classifyWithJev(mail, taxonomy, async () => ok, noSleep)
  assert.deepEqual(r, { status: 'ok', category: 'payments', categoryConfidence: 0.93, importance: 'act_now', importanceConfidence: 0.71 })
})

test('retries a 429 then succeeds', async () => {
  let calls = 0
  const call: SystemOneCall = async () => {
    if (++calls < 3) throw Object.assign(new Error('rate'), { status: 429 })
    return ok
  }
  assert.equal((await classifyWithJev(mail, taxonomy, call, noSleep)).status, 'ok')
  assert.equal(calls, 3)
})

test('a 400 fails immediately without retry and never throws', async () => {
  let calls = 0
  const call: SystemOneCall = async () => { calls++; throw Object.assign(new Error('bad'), { status: 400 }) }
  const r = await classifyWithJev(mail, taxonomy, call, noSleep)
  assert.equal(r.status, 'failed')
  assert.equal(calls, 1)
})

test('an unknown label from the model is a failed row', async () => {
  const call: SystemOneCall = async () => ({ answers: { ...ok.answers, category: { choice: 'nope', confidence: 1 } } })
  assert.equal((await classifyWithJev(mail, taxonomy, call, noSleep)).status, 'failed')
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test src/features/classify/jev.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`src/features/classify/jev.ts`:
```ts
import { TypeSafeClient, choice } from '@typesafe-ai/sdk'
import type { MailFull } from '../gmail/normalize.ts'
import { IMPORTANCE, type Criterion, type Importance, type Taxonomy } from '../taxonomy/taxonomy.ts'

// Jev accepts 32k tokens for state + the longest question. ~12k chars of body leaves ample room.
export const MAX_JEV_BODY_CHARS = 12000
const MAX_ATTEMPTS = 5

export type JevResult =
  | { status: 'ok'; category: string; categoryConfidence: number; importance: Importance; importanceConfidence: number }
  | { status: 'failed'; error: string }

export type SystemOneCall = (request: { state: unknown; questions: Record<string, unknown> }) => Promise<{
  answers: Record<string, { choice: string; confidence: number }>
}>

export function buildState(mail: MailFull): { from: string; subject: string; date: string; body: string } {
  return { from: mail.from, subject: mail.subject, date: mail.date, body: mail.body.slice(0, MAX_JEV_BODY_CHARS) }
}

function toChoiceCriterion(c: Criterion): { what: string; not_for?: string; examples?: string[] } {
  return { what: c.what, ...(c.not_for ? { not_for: c.not_for } : {}), ...(c.examples.length ? { examples: c.examples } : {}) }
}

export function buildQuestions(taxonomy: Taxonomy): { category: unknown; importance: unknown } {
  const categories = Object.fromEntries(Object.entries(taxonomy.categories).map(([k, c]) => [k, toChoiceCriterion(c)]))
  const importance = Object.fromEntries(IMPORTANCE.map((k) => [k, toChoiceCriterion(taxonomy.importance[k])]))
  return {
    category: choice('What is this email about?', categories),
    importance: choice('How much does the mailbox owner need to see this email?', importance),
  }
}

function isTransient(error: unknown): boolean {
  const status = (error as { status?: unknown }).status
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true
  const name = (error as { name?: unknown }).name
  return name === 'APIConnectionError' || name === 'APITimeoutError' || name === 'RateLimitError'
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function classifyWithJev(
  mail: MailFull,
  taxonomy: Taxonomy,
  call: SystemOneCall,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<JevResult> {
  const questions = buildQuestions(taxonomy) as Record<string, unknown>
  for (let attempt = 1; ; attempt++) {
    try {
      const { answers } = await call({ state: buildState(mail), questions })
      const category = answers.category
      const importance = answers.importance
      if (!category || !(category.choice in taxonomy.categories)) return { status: 'failed', error: `unknown category ${category?.choice}` }
      if (!importance || !(IMPORTANCE as readonly string[]).includes(importance.choice)) return { status: 'failed', error: `unknown importance ${importance?.choice}` }
      return {
        status: 'ok',
        category: category.choice, categoryConfidence: category.confidence,
        importance: importance.choice as Importance, importanceConfidence: importance.confidence,
      }
    } catch (error) {
      if (attempt < MAX_ATTEMPTS && isTransient(error)) {
        await sleep(1000 * 2 ** attempt)
        continue
      }
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }
}

export function createSystemOneCall(apiKey: string): SystemOneCall {
  const client = new TypeSafeClient({ apiKey })
  // The SDK's answer types are inferred per question; this adapter narrows them to what we read.
  return async (request) => (await client.systemOne(request as never)) as unknown as Awaited<ReturnType<SystemOneCall>>
}
```

If Step 1 showed the SDK config key is not `apiKey`, use the real one (the env var `TYPESAFE_API_KEY` is also read by default; passing it explicitly keeps config in one place).

- [ ] **Step 5: Run tests**

Run: `node --test src/features/classify/jev.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(classify): jev classifies category and importance in one call"
```

---

### Task 7: Evaluation domain — sample, Opus labels, metrics, report

**Files:**
- Create: `src/features/evaluate/sample.ts`, `src/features/evaluate/opus-labels.ts`, `src/features/evaluate/metrics.ts`, `src/features/evaluate/report.ts`
- Test: `src/features/evaluate/sample.test.ts`, `src/features/evaluate/opus-labels.test.ts`, `src/features/evaluate/metrics.test.ts`, `src/features/evaluate/report.test.ts`

**Interfaces:**
- Consumes: `MailMeta`, `MailFull`, `Taxonomy`, `Importance`, `IMPORTANCE`, `JevResult`, `AskClaude`, `chunk`.
- Produces:
  - `SAMPLE_SIZE = 150`, `PER_SENDER_CAP = 5`
  - `stratifiedSample(mails: MailMeta[], size: number, cap: number, seed: number): string[]` — deterministic for a seed; round-robin over senders sorted by volume, at most `cap` per sender.
  - `type LabelResult = { status: 'ok'; category: string; importance: Importance } | { status: 'failed'; error: string }`
  - `OPUS_BATCH_SIZE = 10`, `OPUS_BODY_CHARS = 3000`
  - `labelWithOpus(mails: MailFull[], taxonomy: Taxonomy, ownerNotes: string, ask: AskClaude): Promise<Record<string, LabelResult>>` — validates each label row separately: unknown category/importance or missing id → that id `failed`.
  - `type Review = Record<string, { category?: string; importance?: Importance }>`
  - `type Axis = 'category' | 'importance'`
  - `type Disagreement = { id: string; axis: Axis; opus: string; jev: string; confidence: number }`
  - `findDisagreements(ids: string[], opus: Record<string, LabelResult>, jev: Record<string, JevResult>): Disagreement[]`
  - `type Bucket = { label: '>=0.9' | '0.7-0.9' | '<0.7'; total: number; correct: number }`
  - `type AxisMetrics = { evaluated: number; pending: number; buckets: Bucket[] }`
  - `type Verdict = 'jev_ready' | 'category_only' | 'enrich_and_retry' | 'inconclusive'`
  - `type Metrics = { generatedAt: string; sampleSize: number; failed: number; category: AxisMetrics; importance: AxisMetrics; verdict: Verdict; verdictReason: string }`
  - `computeMetrics(ids: string[], opus: Record<string, LabelResult>, jev: Record<string, JevResult>, review: Review, now: string): Metrics`
  - `renderReport(metrics: Metrics, disagreements: Disagreement[], mails: Record<string, MailMeta>, review: Review): string` — every interpolated email string is HTML-escaped.
  - `escapeHtml(s: string): string`

**Truth rule (from the spec):** for each id and axis — if `review[id][axis]` exists, it is the truth; else if Opus and Jev agree, Opus is the truth; else the item is **pending** (excluded from accuracy, counted in `pending`). Failed Opus or Jev rows count in `failed`, not in accuracy.

**Verdict rule (from the spec):** compute over `category` axis: `high = bucket '>=0.9'`, `coverage = high.total / evaluated`, `accuracy = high.correct / high.total`.
- `pending > 0` on either axis → `inconclusive` ("review N disagreements with `npm run review`").
- category accuracy ≥ 0.9 and coverage ≥ 0.5, and importance (same formula) accuracy ≥ 0.9 and coverage ≥ 0.5 → `jev_ready`.
- category passes, importance does not → `category_only`.
- category high-bucket accuracy < 0.8 → `enrich_and_retry`.
- anything else → `enrich_and_retry` with the numbers in `verdictReason`.

- [ ] **Step 1: Write the failing tests**

`src/features/evaluate/sample.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stratifiedSample } from './sample.ts'
import type { MailMeta } from '../gmail/normalize.ts'

const mails: MailMeta[] = [
  ...Array.from({ length: 50 }, (_, i) => ({ id: `li${i}`, fromAddress: 'jobs@linkedin.com' })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `nf${i}`, fromAddress: 'info@netflix.com' })),
  { id: 'bank0', fromAddress: 'alerts@bank.com' },
].map((m) => ({ threadId: '', from: '', subject: '', date: '', snippet: '', labelIds: [], ...m }))

test('caps each sender and covers every sender', () => {
  const ids = stratifiedSample(mails, 150, 5, 42)
  assert.equal(ids.filter((id) => id.startsWith('li')).length, 5)
  assert.equal(ids.filter((id) => id.startsWith('nf')).length, 3)
  assert.ok(ids.includes('bank0'))
  assert.equal(ids.length, 9)
})

test('respects size and is deterministic per seed', () => {
  assert.equal(stratifiedSample(mails, 4, 5, 1).length, 4)
  assert.deepEqual(stratifiedSample(mails, 6, 5, 7), stratifiedSample(mails, 6, 5, 7))
})
```

`src/features/evaluate/opus-labels.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { labelWithOpus } from './opus-labels.ts'
import type { AskClaude } from '../taxonomy/discover.ts'
import type { Taxonomy } from '../taxonomy/taxonomy.ts'
import type { MailFull } from '../gmail/normalize.ts'

const taxonomy: Taxonomy = {
  draft: false,
  categories: { payments: { what: 'Receipts', examples: [] }, other: { what: 'Else', examples: [] } },
  importance: { act_now: { what: 'a', examples: [] }, read_later: { what: 'b', examples: [] }, ignore: { what: 'c', examples: [] } },
}
const mail = (id: string): MailFull => ({ id, threadId: '', from: 'f', fromAddress: 'f', subject: 's', date: '', snippet: '', labelIds: [], body: 'b' })

test('per-row validation: one bad label does not sink the batch', async () => {
  const ask: AskClaude = async ({ schema }) => schema.parse({
    labels: [
      { id: '1', category: 'payments', importance: 'act_now' },
      { id: '2', category: 'invented', importance: 'ignore' },
    ],
  })
  const out = await labelWithOpus([mail('1'), mail('2'), mail('3')], taxonomy, '', ask)
  assert.deepEqual(out['1'], { status: 'ok', category: 'payments', importance: 'act_now' })
  assert.equal(out['2']?.status, 'failed')
  assert.equal(out['3']?.status, 'failed')
})
```

`src/features/evaluate/metrics.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeMetrics, findDisagreements } from './metrics.ts'
import type { LabelResult } from './opus-labels.ts'
import type { JevResult } from '../classify/jev.ts'

const opus = (category: string, importance: 'act_now' | 'read_later' | 'ignore'): LabelResult => ({ status: 'ok', category, importance })
const jev = (category: string, cc: number, importance: 'act_now' | 'read_later' | 'ignore', ic: number): JevResult => ({
  status: 'ok', category, categoryConfidence: cc, importance, importanceConfidence: ic,
})

test('agreement counts as correct; disagreement without review is pending', () => {
  const ids = ['1', '2']
  const o = { '1': opus('payments', 'act_now'), '2': opus('payments', 'ignore') }
  const j = { '1': jev('payments', 0.95, 'act_now', 0.95), '2': jev('promotions', 0.95, 'ignore', 0.95) }
  const m = computeMetrics(ids, o, j, {}, 'now')
  assert.equal(m.category.pending, 1)
  assert.equal(m.category.evaluated, 1)
  assert.equal(m.verdict, 'inconclusive')
  assert.deepEqual(findDisagreements(ids, o, j).map((d) => [d.id, d.axis]), [['2', 'category']])
})

test('review overrides Opus: Jev can be right when Opus was wrong', () => {
  const m = computeMetrics(['1'], { '1': opus('payments', 'act_now') }, { '1': jev('promotions', 0.95, 'act_now', 0.95) }, { '1': { category: 'promotions' } }, 'now')
  const high = m.category.buckets.find((b) => b.label === '>=0.9')
  assert.deepEqual(high, { label: '>=0.9', total: 1, correct: 1 })
})

test('jev_ready when both axes pass the gate', () => {
  const ids = Array.from({ length: 10 }, (_, i) => String(i))
  const o = Object.fromEntries(ids.map((id) => [id, opus('payments', 'act_now')]))
  const j = Object.fromEntries(ids.map((id) => [id, jev('payments', 0.95, 'act_now', 0.92)]))
  assert.equal(computeMetrics(ids, o, j, {}, 'now').verdict, 'jev_ready')
})

test('category_only when importance is confidently wrong', () => {
  const ids = Array.from({ length: 10 }, (_, i) => String(i))
  const o = Object.fromEntries(ids.map((id) => [id, opus('payments', 'act_now')]))
  const j = Object.fromEntries(ids.map((id) => [id, jev('payments', 0.95, 'ignore', 0.95)]))
  const review = Object.fromEntries(ids.map((id) => [id, { importance: 'act_now' as const }]))
  assert.equal(computeMetrics(ids, o, j, review, 'now').verdict, 'category_only')
})

test('failed rows are counted, not scored', () => {
  const m = computeMetrics(['1'], { '1': { status: 'failed', error: 'x' } }, { '1': jev('a', 1, 'ignore', 1) }, {}, 'now')
  assert.equal(m.failed, 1)
  assert.equal(m.category.evaluated, 0)
})
```

`src/features/evaluate/report.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, renderReport } from './report.ts'
import type { Metrics } from './metrics.ts'

const metrics: Metrics = {
  generatedAt: '2026-10-04T10:00:00Z', sampleSize: 1, failed: 0, verdict: 'inconclusive', verdictReason: 'review 1',
  category: { evaluated: 0, pending: 1, buckets: [{ label: '>=0.9', total: 0, correct: 0 }, { label: '0.7-0.9', total: 0, correct: 0 }, { label: '<0.7', total: 0, correct: 0 }] },
  importance: { evaluated: 1, pending: 0, buckets: [{ label: '>=0.9', total: 1, correct: 1 }, { label: '0.7-0.9', total: 0, correct: 0 }, { label: '<0.7', total: 0, correct: 0 }] },
}

test('escapes email content', () => {
  assert.equal(escapeHtml(`<img src=x onerror="a">&'`), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;')
  const html = renderReport(metrics, [{ id: '1', axis: 'category', opus: 'payments', jev: 'promotions', confidence: 0.95 }],
    { '1': { id: '1', threadId: '', from: '<script>x</script>', fromAddress: '', subject: 'S', date: '', snippet: '', labelIds: [] } }, {})
  assert.ok(!html.includes('<script>x'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.startsWith('<!doctype html>'))
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test "src/features/evaluate/*.test.ts"`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/features/evaluate/sample.ts`:
```ts
import type { MailMeta } from '../gmail/normalize.ts'

export const SAMPLE_SIZE = 150
export const PER_SENDER_CAP = 5

// mulberry32: tiny seeded PRNG so the sample is reproducible across runs.
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function stratifiedSample(mails: MailMeta[], size: number, cap: number, seed: number): string[] {
  const random = prng(seed)
  const bySender = new Map<string, string[]>()
  for (const m of mails) bySender.set(m.fromAddress, [...(bySender.get(m.fromAddress) ?? []), m.id])

  const queues = [...bySender.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([, ids]) => {
      const shuffled = [...ids].sort((x, y) => x.localeCompare(y))
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1))
        ;[shuffled[i], shuffled[j]] = [shuffled[j] as string, shuffled[i] as string]
      }
      return shuffled.slice(0, cap)
    })

  const picked: string[] = []
  for (let round = 0; round < cap && picked.length < size; round++) {
    for (const queue of queues) {
      const id = queue[round]
      if (id !== undefined && picked.length < size) picked.push(id)
    }
  }
  return picked
}
```

`src/features/evaluate/opus-labels.ts`:
```ts
import { z } from 'zod'
import type { MailFull } from '../gmail/normalize.ts'
import type { AskClaude } from '../taxonomy/discover.ts'
import { IMPORTANCE, type Importance, type Taxonomy } from '../taxonomy/taxonomy.ts'
import { chunk } from '../taxonomy/group-senders.ts'

export const OPUS_BATCH_SIZE = 10
export const OPUS_BODY_CHARS = 3000

export type LabelResult = { status: 'ok'; category: string; importance: Importance } | { status: 'failed'; error: string }

// Loose on purpose: each row is validated separately below, so one bad label never sinks the batch.
const BatchSchema = z.object({ labels: z.array(z.object({ id: z.string(), category: z.string(), importance: z.string() })) })

export async function labelWithOpus(
  mails: MailFull[],
  taxonomy: Taxonomy,
  ownerNotes: string,
  ask: AskClaude,
): Promise<Record<string, LabelResult>> {
  const out: Record<string, LabelResult> = {}
  const system = `You label emails for ONE person using a fixed taxonomy. Use only the given keys.
TAXONOMY (YAML-equivalent JSON):
${JSON.stringify({ categories: taxonomy.categories, importance: taxonomy.importance }, null, 1)}
OWNER NOTES (their own rules; they override your judgement):
${ownerNotes || '(none)'}`

  for (const batch of chunk(mails, OPUS_BATCH_SIZE)) {
    const prompt = batch
      .map((m) => `### id: ${m.id}\nFrom: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.body.slice(0, OPUS_BODY_CHARS)}`)
      .join('\n\n')
    try {
      const { labels } = await ask({ system, prompt: `Label every email below (one entry per id).\n\n${prompt}`, schema: BatchSchema })
      for (const l of labels) {
        if (!batch.some((m) => m.id === l.id)) continue
        if (!(l.category in taxonomy.categories)) out[l.id] = { status: 'failed', error: `unknown category ${l.category}` }
        else if (!(IMPORTANCE as readonly string[]).includes(l.importance)) out[l.id] = { status: 'failed', error: `unknown importance ${l.importance}` }
        else out[l.id] = { status: 'ok', category: l.category, importance: l.importance as Importance }
      }
    } catch (error) {
      for (const m of batch) out[m.id] = { status: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
    for (const m of batch) out[m.id] ??= { status: 'failed', error: 'Opus returned no label for this id' }
  }
  return out
}
```

`src/features/evaluate/metrics.ts`:
```ts
import type { JevResult } from '../classify/jev.ts'
import type { Importance } from '../taxonomy/taxonomy.ts'
import type { LabelResult } from './opus-labels.ts'

export type Review = Record<string, { category?: string; importance?: Importance }>
export type Axis = 'category' | 'importance'
export type Disagreement = { id: string; axis: Axis; opus: string; jev: string; confidence: number }
export type Bucket = { label: '>=0.9' | '0.7-0.9' | '<0.7'; total: number; correct: number }
export type AxisMetrics = { evaluated: number; pending: number; buckets: Bucket[] }
export type Verdict = 'jev_ready' | 'category_only' | 'enrich_and_retry' | 'inconclusive'
export type Metrics = {
  generatedAt: string; sampleSize: number; failed: number
  category: AxisMetrics; importance: AxisMetrics; verdict: Verdict; verdictReason: string
}

const AXES: Axis[] = ['category', 'importance']

function pick(jev: Extract<JevResult, { status: 'ok' }>, axis: Axis): { value: string; confidence: number } {
  return axis === 'category'
    ? { value: jev.category, confidence: jev.categoryConfidence }
    : { value: jev.importance, confidence: jev.importanceConfidence }
}

function bucketOf(confidence: number): Bucket['label'] {
  return confidence >= 0.9 ? '>=0.9' : confidence >= 0.7 ? '0.7-0.9' : '<0.7'
}

export function findDisagreements(ids: string[], opus: Record<string, LabelResult>, jev: Record<string, JevResult>): Disagreement[] {
  const out: Disagreement[] = []
  for (const id of ids) {
    const o = opus[id], j = jev[id]
    if (o?.status !== 'ok' || j?.status !== 'ok') continue
    for (const axis of AXES) {
      const answer = pick(j, axis)
      if (o[axis] !== answer.value) out.push({ id, axis, opus: o[axis], jev: answer.value, confidence: answer.confidence })
    }
  }
  return out
}

function gate(m: AxisMetrics): { accuracy: number; coverage: number } {
  const high = m.buckets[0] as Bucket
  return { accuracy: high.total ? high.correct / high.total : 0, coverage: m.evaluated ? high.total / m.evaluated : 0 }
}

export function computeMetrics(
  ids: string[], opus: Record<string, LabelResult>, jev: Record<string, JevResult>, review: Review, now: string,
): Metrics {
  const axes = Object.fromEntries(AXES.map((axis) => [axis, {
    evaluated: 0, pending: 0,
    buckets: [{ label: '>=0.9', total: 0, correct: 0 }, { label: '0.7-0.9', total: 0, correct: 0 }, { label: '<0.7', total: 0, correct: 0 }] as Bucket[],
  }])) as Record<Axis, AxisMetrics>
  let failed = 0

  for (const id of ids) {
    const o = opus[id], j = jev[id]
    if (o?.status !== 'ok' || j?.status !== 'ok') { failed++; continue }
    for (const axis of AXES) {
      const answer = pick(j, axis)
      const truth = review[id]?.[axis] ?? (o[axis] === answer.value ? o[axis] : undefined)
      if (truth === undefined) { axes[axis].pending++; continue }
      axes[axis].evaluated++
      const bucket = axes[axis].buckets.find((b) => b.label === bucketOf(answer.confidence)) as Bucket
      bucket.total++
      if (truth === answer.value) bucket.correct++
    }
  }

  const c = gate(axes.category), i = gate(axes.importance)
  const pct = (n: number) => `${Math.round(n * 100)}%`
  const numbers = `category ${pct(c.accuracy)} accurate on ${pct(c.coverage)} of emails at confidence ≥ 0.9; importance ${pct(i.accuracy)} on ${pct(i.coverage)}`
  const passes = (g: { accuracy: number; coverage: number }) => g.accuracy >= 0.9 && g.coverage >= 0.5
  const pending = axes.category.pending + axes.importance.pending

  let verdict: Verdict
  let verdictReason: string
  if (pending > 0) { verdict = 'inconclusive'; verdictReason = `Review ${pending} disagreements with \`npm run review\`, then run evaluate again.` }
  else if (passes(c) && passes(i)) { verdict = 'jev_ready'; verdictReason = `Jev passes the gate: ${numbers}.` }
  else if (passes(c)) { verdict = 'category_only'; verdictReason = `Jev handles categories but not importance: ${numbers}.` }
  else { verdict = 'enrich_and_retry'; verdictReason = `Enrich examples/not_for in the taxonomy and measure once more: ${numbers}.` }

  return { generatedAt: now, sampleSize: ids.length, failed, category: axes.category, importance: axes.importance, verdict, verdictReason }
}
```

`src/features/evaluate/report.ts`:
```ts
import type { MailMeta } from '../gmail/normalize.ts'
import type { AxisMetrics, Disagreement, Metrics, Review } from './metrics.ts'

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function axisTable(name: string, m: AxisMetrics): string {
  const rows = m.buckets
    .map((b) => `<tr><td>${b.label}</td><td>${b.total}</td><td>${b.total ? Math.round((b.correct / b.total) * 100) : 0}%</td><td>${m.evaluated ? Math.round((b.total / m.evaluated) * 100) : 0}%</td></tr>`)
    .join('')
  return `<h2>${name}</h2><p>${m.evaluated} evaluated · ${m.pending} pending review</p>
<table><thead><tr><th>Confidence</th><th>Emails</th><th>Accuracy</th><th>Share</th></tr></thead><tbody>${rows}</tbody></table>`
}

export function renderReport(metrics: Metrics, disagreements: Disagreement[], mails: Record<string, MailMeta>, review: Review): string {
  const rows = disagreements
    .map((d) => {
      const m = mails[d.id]
      const resolved = review[d.id]?.[d.axis]
      return `<tr><td>${escapeHtml(m?.from ?? d.id)}</td><td>${escapeHtml(m?.subject ?? '')}</td><td>${d.axis}</td>
<td>${escapeHtml(d.opus)}</td><td>${escapeHtml(d.jev)} (${d.confidence.toFixed(2)})</td><td>${resolved ? escapeHtml(resolved) : '—'}</td></tr>`
    })
    .join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mail triage — Jev evaluation</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#ddd;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#999;--line:#333;--accent:#60a5fa}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:1000px}
table{border-collapse:collapse;width:100%;margin:8px 0 24px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.verdict{border-left:4px solid var(--accent);padding:8px 12px}.muted{color:var(--muted)}
</style></head><body>
<h1>Jev evaluation</h1>
<p class="muted">${escapeHtml(metrics.generatedAt)} · sample ${metrics.sampleSize} · failed ${metrics.failed}</p>
<div class="verdict"><strong>${metrics.verdict}</strong> — ${escapeHtml(metrics.verdictReason)}</div>
${axisTable('Category', metrics.category)}
${axisTable('Importance', metrics.importance)}
<h2>Disagreements (${disagreements.length})</h2>
<p class="muted">Resolve them in a terminal: <code>npm run review</code> in the agent folder.</p>
<table><thead><tr><th>From</th><th>Subject</th><th>Axis</th><th>Opus</th><th>Jev</th><th>Your call</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`
}
```

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(evaluate): stratified sample, opus labels, metrics gate and html report"
```

---

### Task 8: `npm run evaluate` and `npm run review`

**Files:**
- Create: `scripts/evaluate.ts`, `scripts/review.ts`, `src/features/evaluate/stores.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces:
  - `stores.ts`: `type Stores = ReturnType<typeof openStores>`; `openStores(resultsDir: string)` returning `{ mails, sample, bodies, opus, jev, review, metrics }` each with `.path` and typed `read()` / `write(value)` using `readJson`/`writeJson` and zod schemas (`MailMeta`/`MailFull`/`LabelResult`/`JevResult` validated with `z.custom` object checks; `sample` = `{ seed: number; ids: string[] }`; `review` = record of `{ category?: string; importance?: enum }`).
  - `loadApprovedTaxonomy(rulesPath: string): { taxonomy: Taxonomy; ownerNotes: string }` (in `stores.ts`) — throws `NeedsPersonError` when the file or block is missing, or when `draft: true`. `ownerNotes` = the rules markdown with the yaml block removed.

- [ ] **Step 1: Implement `src/features/evaluate/stores.ts`**

```ts
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { readJson, writeJson } from '../../shared/json-store.ts'
import { NeedsPersonError } from '../../shared/exit.ts'
import type { MailFull, MailMeta } from '../gmail/normalize.ts'
import type { JevResult } from '../classify/jev.ts'
import type { LabelResult } from './opus-labels.ts'
import type { Metrics, Review } from './metrics.ts'
import { IMPORTANCE, type Taxonomy } from '../taxonomy/taxonomy.ts'
import { parseTaxonomy } from '../taxonomy/rules-file.ts'

const obj = <T>() => z.custom<T>((v) => typeof v === 'object' && v !== null)

function store<T>(file: string, schema: z.ZodType<T>, fallback: T) {
  return { path: file, read: () => readJson(file, schema, fallback), write: (value: T) => writeJson(file, value) }
}

export function openStores(resultsDir: string) {
  const f = (name: string) => path.join(resultsDir, name)
  return {
    mails: store(f('mails.json'), z.record(z.string(), obj<MailMeta>()), {}),
    sample: store<{ seed: number; ids: string[] } | null>(f('sample.json'), z.object({ seed: z.number(), ids: z.array(z.string()) }).nullable(), null),
    bodies: store(f('bodies.json'), z.record(z.string(), obj<MailFull>()), {}),
    opus: store(f('opus-labels.json'), z.record(z.string(), obj<LabelResult>()), {}),
    jev: store(f('jev-labels.json'), z.record(z.string(), obj<JevResult>()), {}),
    review: store<Review>(f('review.json'), z.record(z.string(), z.object({ category: z.string().optional(), importance: z.enum(IMPORTANCE).optional() })), {}),
    metrics: store<Metrics | null>(f('metrics.json'), obj<Metrics>().nullable(), null),
  }
}

export function loadApprovedTaxonomy(rulesPath: string): { taxonomy: Taxonomy; ownerNotes: string } {
  if (!fs.existsSync(rulesPath)) throw new NeedsPersonError('No rules file yet: run `npm run discover` first')
  const markdown = fs.readFileSync(rulesPath, 'utf8')
  const taxonomy = parseTaxonomy(markdown)
  if (!taxonomy) throw new NeedsPersonError('No taxonomy in the rules file: run `npm run discover` first')
  if (taxonomy.draft) throw new NeedsPersonError('The taxonomy is still a draft: review it in Albus (agent rules) and set `draft: false`')
  return { taxonomy, ownerNotes: markdown.replace(/```yaml[\s\S]*?```/, '').trim() }
}
```

- [ ] **Step 2: Implement `scripts/evaluate.ts`**

Flow (each step persists before the next so a killed run resumes without re-paying):
```ts
import { loadConfig } from '../src/shared/config.ts'
import { emit } from '../src/shared/hub-events.ts'
import { NeedsPersonError, runMain } from '../src/shared/exit.ts'
import { writeJson } from '../src/shared/json-store.ts'
import path from 'node:path'
import { getAccessToken } from '../src/features/gmail/oauth.ts'
import { createGmailApi } from '../src/features/gmail/gmail-api.ts'
import { toMailFull, type MailFull } from '../src/features/gmail/normalize.ts'
import { mapPool } from '../src/features/gmail/sync.ts'
import { runClaudeJson } from '../src/features/claude/claude-cli.ts'
import { classifyWithJev, createSystemOneCall } from '../src/features/classify/jev.ts'
import { chunk } from '../src/features/taxonomy/group-senders.ts'
import { OPUS_BATCH_SIZE, labelWithOpus } from '../src/features/evaluate/opus-labels.ts'
import { PER_SENDER_CAP, SAMPLE_SIZE, stratifiedSample } from '../src/features/evaluate/sample.ts'
import { computeMetrics, findDisagreements } from '../src/features/evaluate/metrics.ts'
import { renderReport } from '../src/features/evaluate/report.ts'
import { loadApprovedTaxonomy, openStores } from '../src/features/evaluate/stores.ts'

runMain(async () => {
  const config = loadConfig()
  const { taxonomy, ownerNotes } = loadApprovedTaxonomy(config.rulesPath)
  if (!config.env.typesafeApiKey) throw new NeedsPersonError('TYPESAFE_API_KEY missing in the agent .env')
  const s = openStores(config.resultsDir)

  const mails = s.mails.read()
  if (Object.keys(mails).length === 0) throw new NeedsPersonError('No cached emails: run `npm run discover` first')

  // 1. Sample — persisted, so every run measures the same emails.
  let sample = s.sample.read()
  if (!sample) {
    const seed = Date.now() % 2147483647
    sample = { seed, ids: stratifiedSample(Object.values(mails), SAMPLE_SIZE, PER_SENDER_CAP, seed) }
    s.sample.write(sample)
  }
  const ids = sample.ids

  // 2. Full bodies, only for the sample.
  const bodies = s.bodies.read()
  const missingBodies = ids.filter((id) => !bodies[id])
  if (missingBodies.length) {
    const api = createGmailApi((await getAccessToken(config)).accessToken)
    let done = 0
    await mapPool(missingBodies, 6, async (id) => {
      try {
        const full = toMailFull(await api.getFull(id))
        if (full) bodies[id] = full
      } catch { /* row stays missing; counted as failed below */ }
      if (++done % 25 === 0) emit({ type: 'progress', message: `Email bodies ${done}/${missingBodies.length}`, percent: Math.round((done / missingBodies.length) * 20) })
    })
    s.bodies.write(bodies)
  }
  const sampled: MailFull[] = ids.flatMap((id) => (bodies[id] ? [bodies[id]] : []))

  // 3. Opus labels (batches of 10), saved after every batch.
  const opus = s.opus.read()
  const toLabel = sampled.filter((m) => opus[m.id]?.status !== 'ok')
  const batches = chunk(toLabel, OPUS_BATCH_SIZE)
  for (const [i, batch] of batches.entries()) {
    emit({ type: 'progress', message: `Opus labelling batch ${i + 1}/${batches.length}`, percent: 20 + Math.round((i / Math.max(batches.length, 1)) * 40) })
    Object.assign(opus, await labelWithOpus(batch, taxonomy, ownerNotes, (o) => runClaudeJson({ ...o, model: 'opus' })))
    s.opus.write(opus)
  }

  // 4. Jev labels, saved every 10.
  const jev = s.jev.read()
  const call = createSystemOneCall(config.env.typesafeApiKey)
  const toClassify = sampled.filter((m) => jev[m.id]?.status !== 'ok')
  let classified = 0
  await mapPool(toClassify, 4, async (m) => {
    jev[m.id] = await classifyWithJev(m, taxonomy, call)
    if (++classified % 10 === 0) {
      s.jev.write(jev)
      emit({ type: 'progress', message: `Jev ${classified}/${toClassify.length}`, percent: 60 + Math.round((classified / toClassify.length) * 35) })
    }
  })
  s.jev.write(jev)

  // 5. Metrics + report.
  const review = s.review.read()
  const metrics = computeMetrics(ids, opus, jev, review, new Date().toISOString())
  s.metrics.write(metrics)
  const disagreements = findDisagreements(ids, opus, jev)
  writeJson(path.join(config.resultsDir, 'disagreements.json'), disagreements)
  const reportPath = path.join(config.resultsDir, 'report.html')
  ;(await import('node:fs')).writeFileSync(reportPath, renderReport(metrics, disagreements, mails, review))
  emit({ type: 'result', path: 'report.html', message: `${metrics.verdict}: ${metrics.verdictReason}` })
})
```

Clean-up while implementing: replace the inline `await import('node:fs')` with a top-level `import fs from 'node:fs'`.

- [ ] **Step 3: Implement `scripts/review.ts`**

```ts
import path from 'node:path'
import readline from 'node:readline/promises'
import { z } from 'zod'
import { loadConfig } from '../src/shared/config.ts'
import { NeedsPersonError, runMain } from '../src/shared/exit.ts'
import { readJson } from '../src/shared/json-store.ts'
import { IMPORTANCE, type Importance } from '../src/features/taxonomy/taxonomy.ts'
import type { Disagreement } from '../src/features/evaluate/metrics.ts'
import { loadApprovedTaxonomy, openStores } from '../src/features/evaluate/stores.ts'

runMain(async () => {
  const config = loadConfig()
  const { taxonomy } = loadApprovedTaxonomy(config.rulesPath)
  const s = openStores(config.resultsDir)
  const disagreements = readJson(path.join(config.resultsDir, 'disagreements.json'), z.array(z.custom<Disagreement>()), [])
  if (!disagreements.length) throw new NeedsPersonError('Nothing to review: run `npm run evaluate` first')
  const bodies = s.bodies.read()
  const review = s.review.read()
  const pending = disagreements.filter((d) => review[d.id]?.[d.axis] === undefined)

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log(`${pending.length} disagreements to review. Answers: o = Opus, j = Jev, number = other, s = skip, q = save and quit.\n`)
  for (const [i, d] of pending.entries()) {
    const m = bodies[d.id]
    const options = d.axis === 'category' ? Object.keys(taxonomy.categories) : [...IMPORTANCE]
    console.log(`\n[${i + 1}/${pending.length}] ${d.axis.toUpperCase()}`)
    console.log(`From:    ${m?.from}\nSubject: ${m?.subject}\n${(m?.body ?? '').slice(0, 500)}\n`)
    console.log(`  o) Opus: ${d.opus}\n  j) Jev:  ${d.jev} (${d.confidence.toFixed(2)})`)
    options.forEach((o, n) => console.log(`  ${n + 1}) ${o}`))
    const answer = (await rl.question('> ')).trim().toLowerCase()
    if (answer === 'q') break
    if (answer === 's' || answer === '') continue
    const value = answer === 'o' ? d.opus : answer === 'j' ? d.jev : options[Number(answer) - 1]
    if (!value) { console.log('Not an option, skipped.'); continue }
    review[d.id] = { ...review[d.id], [d.axis]: d.axis === 'importance' ? (value as Importance) : value }
    s.review.write(review) // saved after every answer: quitting never loses work
  }
  rl.close()
  console.log('\nSaved. Run `npm run evaluate` (or "Evaluate Jev" in Albus) to recompute the metrics.')
})
```

- [ ] **Step 4: Typecheck and run all tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(evaluate): resumable evaluate run and terminal review of disagreements"
```

---

### Task 9: `npm run check`, README, install into the hub

**Files:**
- Create: `scripts/check.ts`, `README.md`
- Modify: none in albus_agent (installation uses the existing hub CLI)

**Interfaces:**
- Consumes: `loadConfig`, `getAccessToken`, `resolveClaudeBinary`, `parseTaxonomy`, `NeedsPersonError`.

- [ ] **Step 1: Implement `scripts/check.ts`** — prints one line per check (`✔`/`✘` + the fix), spends no model quota, exits 2 when any blocking check fails.

```ts
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { loadConfig } from '../src/shared/config.ts'
import { getAccessToken } from '../src/features/gmail/oauth.ts'
import { resolveClaudeBinary } from '../src/features/claude/claude-cli.ts'
import { parseTaxonomy } from '../src/features/taxonomy/rules-file.ts'

const config = loadConfig()
let blocking = 0
const ok = (msg: string) => console.log(`✔ ${msg}`)
const bad = (msg: string) => { blocking++; console.log(`✘ ${msg}`) }

if (config.env.typesafeApiKey) ok('TYPESAFE_API_KEY set')
else bad('TYPESAFE_API_KEY missing in .env')

try {
  const { scopes } = await getAccessToken(config)
  ok(`Gmail token valid (${scopes.length} scopes, gmail.readonly present)`)
} catch (error) {
  bad(error instanceof Error ? error.message : String(error))
}

const claude = spawnSync(resolveClaudeBinary(), ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
if (claude.status === 0) ok(`Claude Code ${claude.stdout.trim()}`)
else bad('Claude Code CLI not found or not working: install it and log in')

if (!fs.existsSync(config.rulesPath)) console.log(`· No rules file yet (${config.rulesPath}): run \`npm run discover\``)
else {
  try {
    const t = parseTaxonomy(fs.readFileSync(config.rulesPath, 'utf8'))
    if (!t) console.log('· No taxonomy yet: run `npm run discover`')
    else ok(`Taxonomy: ${Object.keys(t.categories).length} categories${t.draft ? ' (DRAFT — set draft: false to evaluate)' : ''}`)
  } catch (error) {
    bad(error instanceof Error ? error.message : String(error))
  }
}

process.exit(blocking ? 2 : 0)
```

- [ ] **Step 2: Write `README.md`** — setup in order: copy `.env.example` → `.env` and fill it (Albus's desktop OAuth client can be reused; note that a consent screen in "Testing" mode makes refresh tokens expire after 7 days and needs the Gmail account added as a test user), `npm run auth`, `npm run check`, `npm run discover`, edit the taxonomy in Albus and set `draft: false`, `npm run evaluate`, `npm run review`, `npm run evaluate` again, how to read the verdict (the spec's gate table), and a "Files" section listing the results files from this plan.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test && npm run check`
Expected: typecheck and tests PASS. `check` exits 2 listing the missing `.env` values / token (expected until the user configures them) — it must NOT crash with a stack trace.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: setup check and readme for mail-triage"
```

- [ ] **Step 5: Install into the hub (linked)**

From the albus_agent repo:
```bash
cd /c/Users/PC/Documents/web/albus_agent && npm run hub -- install /c/Users/PC/Documents/web/my_proyects/mail-triage --link
```
Expected: installs as `mail-triage`; the check step reports exit 2 (missing secrets), so it is listed **disabled with the reason** — that is the correct state until the user runs `npm run auth` and fills `.env`. Then `npm run hub -- list` shows `mail-triage`.

---

## Self-review notes

- Spec coverage: gmail.readonly OAuth (T3), 90-day grouped discovery with sender+subject+snippet (T4–T5), YAML in rules with draft gate and exit 2 (T2, T8), Opus via isolated CLI (T5), Jev two choice() axes with English criteria and 32k truncation (T6), stratified 150 with per-sender cap (T7), Opus labels + human review of disagreements only (T7–T8), per-row validation, 429-only retries, per-id persistence (T4, T6–T8), report HTML (T7), check without quota (T9), unit tests for every pure module (T1–T7), success gate (T7 `computeMetrics`). Out of scope respected: no daily run, no Orca, no Notion, no Gmail labels, no Albus code changes.
- Gmail's own `snippet` (~200 chars) is used for discovery instead of slicing the body to 300 chars: it avoids fetching 2,700 full bodies. Bodies are fetched only for the 150 sampled emails.
