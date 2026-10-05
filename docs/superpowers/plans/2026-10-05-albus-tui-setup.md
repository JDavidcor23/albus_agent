# Albus TUI Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run setup` opens an Ink TUI that configures a machine for Albus: where the hub lives, missing tools, every agent's keys (written into the agent's own `.env`), Google permissions (via the agent's own auth command) and a final `check` per agent.

**Architecture:** The contract grows one optional field, `setup`, in `src/main/core/hub/manifest.ts` (the ONLY validator of `agent.json`). Pure logic (`.env` parse/update, "what is missing", hub-location rules) lives in `src/main/core/hub/` and is checked by a tsx script. Side effects (`where`, file writes, `setx`, `robocopy`, spawning auth/check, `winget`) live in `src/main/hub/setup-io.ts`. The TUI in `src/tui/` only renders and calls those two layers. The Electron app is NOT touched.

**Tech Stack:** TypeScript, React 19, Ink (+ `ink-text-input`), zod 4, tsx. Windows PowerShell 5.1 for `scripts/agents.ps1`.

**Spec:** `docs/superpowers/specs/2026-10-05-albus-tui-setup-design.md`

## Global Constraints

- All code, identifiers, comments and TUI copy in **English** (project rule since 2026-08-12). Values listed as frozen in `CLAUDE.md` stay as they are.
- `src/tui/**` must NOT import `electron`, `src/renderer/**`, `src/preload/**`, or `src/main/supabase/**`. It may import `src/main/core/**`, `src/main/hub/**`, `src/main/paths.ts`.
- `src/main/core/**` stays pure: no `node:fs`, no `child_process`, no `electron`.
- A secret value is NEVER printed: not in TUI output, not in logs, not in error messages, not in check output.
- Every spawn: `shell: false`, binaries resolved with `where`, args as arrays, hard timeout. Agent commands only through `parseCommand` (`core/hub/command.ts`) + `resolveProgram` (`hub/process.ts`).
- Hub folder names are frozen: `agents-hub`, `agents`, `results`, `agent.json`.
- Hub location env var: `ALBUS_AGENTS_HUB_DIR` = the hub folder itself (`<parent>\agents-hub`), user-level (`setx`).
- Changing hub location = COPY (robocopy /E), never move; old folder left intact.
- Gate: `npm run typecheck` + `npm run setup:check` + `npm run hub:check`. No linter, no test runner. NEVER run `npm run build` (user rule).
- Commits: conventional commits, NO `Co-Authored-By`/AI attribution (user rule). Commit directly on `main`. Push with `export GH_TOKEN=$(gh auth token -u JDavidcor23); git push`.
- Never `npx rg` in this repo.

---

## File map

| File | Responsibility |
|---|---|
| `src/tui/package.json` | `{"type":"module"}` so Ink (ESM-only, top-level await in yoga) loads |
| `src/tui/index.tsx` | entry: `render(<App/>)` |
| `src/tui/app.tsx` | screen router + shared state |
| `src/tui/screens/home.tsx` | hub location, tools row, one row per agent |
| `src/tui/screens/agent-detail.tsx` | keys, auth, check for one agent |
| `src/tui/screens/hub-location.tsx` | choose/change hub folder |
| `src/tui/screens/run-output.tsx` | shows output of sync/check/winget |
| `src/tui/components/select-list.tsx` | arrow-key list (no extra dep) |
| `tsconfig.tui.json` | jsx + include `src/tui/**`, `src/main/core/**`, `src/main/hub/**`, `src/main/paths.ts` |
| `src/main/core/hub/manifest.ts` | + `SetupSchema`, `setup` field |
| `src/main/core/hub/dotenv.ts` | pure `.env` parse / set preserving everything else |
| `src/main/core/hub/setup-status.ts` | pure: manifest + disk facts → what is missing |
| `src/main/core/hub/hub-location.ts` | pure: parent dir → hub dir, validation |
| `src/main/hub/setup-io.ts` | adapter: disk, `where`, setx, robocopy, spawn auth/check, winget |
| `src/main/hub/albus-setup.ts` | loads `setup.json` (Albus itself as a pseudo-agent) |
| `setup.json` | Albus's own keys and commands |
| `scripts/check-setup.ts` | tsx checks for everything pure + env-file IO in a temp dir |
| `scripts/agents.ps1` | reads `ALBUS_AGENTS_HUB_DIR` |

---

### Task 1: Toolchain spike — Ink runs under tsx

**Files:**
- Create: `src/tui/package.json`, `src/tui/index.tsx`, `tsconfig.tui.json`
- Modify: `package.json` (scripts + deps)

**Interfaces:** Produces `npm run setup` and `npm run typecheck:tui`.

- [ ] **Step 1: Install deps.** `npm ls react` first. Install `ink` and `ink-text-input` (`npm install ink ink-text-input`). If npm reports a React peer conflict (Ink 8 wants `react >=19.3`), bump `react`, `react-dom`, `@types/react`, `@types/react-dom` to the latest `19.x` in the same install. Do NOT use `--force`/`--legacy-peer-deps`.
- [ ] **Step 2: Create `src/tui/package.json`:**
```json
{ "type": "module" }
```
- [ ] **Step 3: Create `src/tui/index.tsx`:**
```tsx
import React from 'react'
import { render, Text } from 'ink'

render(<Text color="green">Albus setup</Text>)
```
- [ ] **Step 4: Create `tsconfig.tui.json`:**
```json
{
  "extends": "@electron-toolkit/tsconfig/tsconfig.node.json",
  "include": ["src/tui/**/*", "src/main/core/**/*", "src/main/hub/**/*", "src/main/paths.ts"],
  "compilerOptions": {
    "composite": false,
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["node"]
  }
}
```
If `src/main/hub/**` pulls a file that imports `electron` or `../agents/**` and breaks this config, narrow `include` to the exact files the TUI imports (`discover.ts`, `process.ts`, `setup-io.ts`, `albus-setup.ts`) and note it in a comment.
- [ ] **Step 5: Scripts in `package.json`:** add `"typecheck:tui": "tsc --noEmit -p tsconfig.tui.json"`, append `&& npm run typecheck:tui` to `typecheck`, add `"setup": "tsx src/tui/index.tsx"`, `"setup:check": "tsx scripts/check-setup.ts"`.
- [ ] **Step 6: Verify.** `npm run setup` prints `Albus setup` and exits; `npm run typecheck` passes. If Ink fails to load (ERR_REQUIRE_ASYNC_MODULE or similar), the `src/tui/package.json` type:module is the fix — confirm it is picked up. Record the exact failure and fix in a comment at the top of `index.tsx`.
- [ ] **Step 7: Commit** `feat(tui): scaffold the Ink setup TUI`.

---

### Task 2: `setup` field in the agent contract

**Files:**
- Modify: `src/main/core/hub/manifest.ts`
- Create: `scripts/check-setup.ts`

**Interfaces:** Produces `SetupSchema`, `type AgentSetup = z.infer<typeof SetupSchema>`, `AgentManifest['setup']` (always present, default `{ tools: [], env: [], envFile: '.env', auth: [] }`), and `setupProblems(manifest: AgentManifest): string[]` (cross-field rules).

- [ ] **Step 1: Write failing checks** in `scripts/check-setup.ts` (copy the `check`/`section` helpers style of `scripts/check-hub.ts`; exit 1 on any failure):
```ts
import { AgentJsonSchema, parseAgentJson } from '../src/main/core/hub/manifest'

const base = { protocol: 1, id: 'demo', name: 'Demo', commands: { run: 'npm run x', auth: 'npm run auth' } }
section('manifest: setup')
const noSetup = AgentJsonSchema.parse(base)
check('no setup → empty default', noSetup.setup.env.length === 0 && noSetup.setup.envFile === '.env')
const full = parseAgentJson('demo', JSON.stringify({ ...base, setup: {
  tools: ['ffmpeg'], envFile: '.env.local',
  env: [{ key: 'NOTION_TOKEN', label: 'Notion token', help: 'notion.so/my-integrations' }],
  auth: [{ label: 'Gmail', command: 'auth', doneWhen: '.secrets/gmail-token.json' }] } }))
check('full setup parses', full.ok)
check('secret defaults true', full.ok && full.manifest.setup.env[0].secret === true)
const bad = (setup: unknown) => !parseAgentJson('demo', JSON.stringify({ ...base, setup })).ok
check('lowercase key rejected', bad({ env: [{ key: 'notion', label: 'x' }] }))
check('envFile other than .env/.env.local rejected', bad({ envFile: '../.env' }))
check('doneWhen escaping folder rejected', bad({ auth: [{ label: 'x', command: 'auth', doneWhen: '../x' }] }))
check('auth command not in commands rejected', bad({ auth: [{ label: 'x', command: 'nope', doneWhen: 'a' }] }))
check('tool with space rejected', bad({ tools: ['rm -rf'] }))
```
- [ ] **Step 2: Run** `npm run setup:check` → FAIL (`setup` undefined).
- [ ] **Step 3: Implement** in `manifest.ts`:
```ts
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/
const TOOL_PATTERN = /^[a-z0-9._-]+$/
/** A path relative to the agent folder that can never climb out of it. */
const InsidePath = z.string().min(1).refine(
  (p) => !p.split(/[\\/]/).includes('..') && !/^([a-zA-Z]:|[\\/])/.test(p),
  { message: 'path must stay inside the agent folder' })

export const SetupSchema = z.object({
  tools: z.array(z.string().regex(TOOL_PATTERN)).default([]),
  env: z.array(z.object({
    key: z.string().regex(ENV_KEY_PATTERN),
    label: z.string().min(1),
    help: z.string().default(''),
    secret: z.boolean().default(true),
    optional: z.boolean().default(false)
  })).default([]),
  envFile: z.enum(['.env', '.env.local']).default('.env'),
  auth: z.array(z.object({
    label: z.string().min(1),
    /** The NAME of an entry in `commands` — never a command line: it must go through the allowlist. */
    command: z.string().min(1),
    doneWhen: InsidePath
  })).default([])
}).default({ tools: [], env: [], envFile: '.env', auth: [] })
export type AgentSetup = z.infer<typeof SetupSchema>
```
Add `setup: SetupSchema` to `AgentJsonSchema`, and a `.superRefine` (or a check inside `parseAgentJson` after `safeParse`) that rejects an `auth[].command` not present in `commands`, with message `setup.auth command "<name>" is not declared in commands`. Comment why (allowlist).
- [ ] **Step 4: Run** `npm run setup:check` and `npm run hub:check` → both PASS (old manifests still valid).
- [ ] **Step 5: Commit** `feat(hub): optional setup field in agent.json`.

---

### Task 3: Pure `.env` editing

**Files:** Create `src/main/core/hub/dotenv.ts`; extend `scripts/check-setup.ts`.

**Interfaces:** Produces
```ts
export function parseDotenv(text: string): Map<string, string>
export function setDotenvValue(text: string, key: string, value: string): string
```

- [ ] **Step 1: Failing checks:**
```ts
import { parseDotenv, setDotenvValue } from '../src/main/core/hub/dotenv'
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
try { setDotenvValue('', 'K', 'line1\nline2') } catch (e) { threw = String(e) }
check('newline in value rejected without echoing it', threw !== '' && !threw.includes('line1'))
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `dotenv.ts`: line-based; a line `KEY=VALUE` with optional `export ` prefix; unquoted value ends at ` #`; double-quoted supports `\"` and `\\`; detect `\r\n` from input and reuse it; `setDotenvValue` replaces the first line for `key` (drops later duplicates), otherwise appends (adding a newline first if the text does not end in one); quote when value matches `/[\s#"'\\]/` or is empty; throw `new Error(\`value for ${key} contains a newline\`)` (never the value) on `\r`/`\n`.
- [ ] **Step 4: Run** `npm run setup:check` → PASS.
- [ ] **Step 5: Commit** `feat(hub): pure .env editing that preserves the rest of the file`.

---

### Task 4: Hub location + setup status (pure)

**Files:** Create `src/main/core/hub/hub-location.ts`, `src/main/core/hub/setup-status.ts`; extend `scripts/check-setup.ts`.

**Interfaces:** Produces
```ts
// hub-location.ts
export const HUB_FOLDER = 'agents-hub'
export function hubDirFromParent(parent: string): string   // 'C:\\x' → 'C:\\x\\agents-hub'; already ending in agents-hub → unchanged
export function validateHubParent(parent: string): string | null // null = ok; reason otherwise (empty, relative, contains '..')

// setup-status.ts
export interface DiskFacts { envValues: Map<string, string>; doneFiles: Set<string>; tools: Map<string, boolean> }
export type ItemState = 'ok' | 'missing' | 'optional-missing'
export interface SetupStatus {
  env: { key: string; label: string; help: string; secret: boolean; state: ItemState }[]
  auth: { label: string; command: string; doneWhen: string; state: ItemState }[]
  tools: { name: string; state: ItemState }[]
  ready: boolean            // nothing required missing
  nothingToConfigure: boolean // setup is empty
}
export function computeSetupStatus(setup: AgentSetup, facts: DiskFacts): SetupStatus
/** For key reuse: which OTHER agents already have a non-empty value for `key`. */
export function agentsHavingKey(key: string, values: { agentId: string; env: Map<string, string> }[], exceptId: string): string[]
```
- [ ] **Step 1: Failing checks** covering: `hubDirFromParent('C:\\Users\\PC\\Documents\\web')` → `...\\web\\agents-hub` (use `path.win32.join`); idempotent when already `agents-hub`; `validateHubParent('relative')`, `''`, `'C:\\a\\..\\b'` return reasons; status with empty setup → `nothingToConfigure && ready`; missing required key → `ready false`; missing optional key → `optional-missing` and still `ready`; empty-string value counts as missing; `doneWhen` present in `doneFiles` → auth ok; `agentsHavingKey` excludes self and empty values.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (pure; use `node:path` `win32` only for string joining — no fs). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(hub): pure setup status and hub location rules`.

---

### Task 5: Setup IO adapter + Albus's own `setup.json`

**Files:** Create `src/main/hub/setup-io.ts`, `src/main/hub/albus-setup.ts`, `setup.json`; extend `scripts/check-setup.ts`.

**Interfaces:** Produces
```ts
// setup-io.ts
export interface SetupTarget { id: string; name: string; dir: string; manifest: AgentManifest | null; problem: string }
export async function listSetupTargets(hubDir: string): Promise<SetupTarget[]> // Albus first (from setup.json), then listExternalAgents(join(hubDir,'agents')) — broken agent.json kept with its problem
export function readEnvFile(dir: string, envFile: string): Map<string, string> // missing file → empty map
export function writeEnvValue(dir: string, envFile: string, key: string, value: string): void // atomic: write tmp in same dir, renameSync
export async function gatherFacts(target: SetupTarget): Promise<DiskFacts>
export async function whichTool(name: string): Promise<boolean> // `where <name>`, 5s timeout
export const KNOWN_TOOLS: Record<string, { winget?: string; hint: string }> // git→Git.Git, node→OpenJS.NodeJS.LTS, gh→GitHub.cli, ffmpeg→Gyan.FFmpeg, whisper→hint 'pip install -U openai-whisper', claude→hint 'npm install -g @anthropic-ai/claude-code', pdftotext→hint 'winget install oschwartz10612.Poppler'
export async function installTool(name: string): Promise<{ ok: boolean; output: string }> // only KNOWN_TOOLS with winget id; spawn 'winget' args array
export async function runAgentCommandInteractive(target: SetupTarget, commandName: string): Promise<number> // parseCommand + resolveProgram, stdio:'inherit', cwd target.dir, env = process.env (the agent's own auth script needs the user's normal env; it runs in the user's own terminal), 15 min timeout
export async function runAgentCheck(target: SetupTarget): Promise<{ ok: boolean; output: string }> // commands.check if declared, piped, 5 min timeout, env = buildSystemEnv(process.env) + NO_COLOR; output trimmed to last 4000 chars
export function currentHubDir(): string // = agentsHubDir() from paths.ts
export async function setHubDirPersistently(hubDir: string): Promise<void> // spawn 'setx' ['ALBUS_AGENTS_HUB_DIR', hubDir]; also sets process.env for this run
export async function copyHub(from: string, to: string): Promise<{ ok: boolean; output: string }> // robocopy from to /E /XD node_modules /R:1 /W:1 — robocopy exit codes 0-7 are success, >=8 failure
export async function verifyHubCopy(from: string, to: string): Promise<string[]> // every agents/<id> in `from` exists in `to` with agent.json (or .git); returns problems
export function findHardcodedHubPaths(hubDir: string): { file: string; line: number }[] // scans agents/*/ (skip node_modules, .git) *.ts *.js *.mjs *.vbs *.ps1 for the literal 'Documents\\agents-hub' or 'Documents/agents-hub' or path.join(…'Documents', 'agents-hub' …) not preceded on the same line by ALBUS_AGENTS_HUB_DIR
```
`setup.json` (repo root):
```json
{
  "name": "Albus (the app)",
  "commands": { "gmail-auth": "npm run gmail:auth", "check": "npm run notion:check" },
  "setup": {
    "tools": ["git", "node", "gh"],
    "envFile": ".env",
    "env": [
      { "key": "SUPABASE_URL", "label": "Supabase URL", "help": "Supabase → Project Settings → API → Project URL", "secret": false },
      { "key": "SUPABASE_SERVICE_ROLE_KEY", "label": "Supabase service_role key", "help": "Supabase → Project Settings → API → service_role. Bypasses RLS: this machine only" },
      { "key": "GOOGLE_CLIENT_ID", "label": "Google OAuth client id (Desktop app)", "help": "Google Cloud console → Credentials", "secret": false },
      { "key": "GOOGLE_CLIENT_SECRET", "label": "Google OAuth client secret", "help": "Same Desktop OAuth client" },
      { "key": "GOOGLE_REFRESH_TOKEN", "label": "Google refresh token", "help": "Run the Google permission below; it prints the token to paste here" },
      { "key": "NOTION_TOKEN", "label": "Notion integration token (personal workspace)", "help": "notion.so/my-integrations → Secret" },
      { "key": "NOTION_JOBS_DATABASE_ID", "label": "Notion jobs database id", "help": "The job tracker database URL, the 32-char id", "secret": false, "optional": true }
    ],
    "auth": []
  }
}
```
`albus-setup.ts` validates it with `SetupSchema` + `CommandsSchema` (export `CommandsSchema` from `manifest.ts` if needed) and returns a `SetupTarget` with `id: 'albus'`, `dir` = repo root (resolve from this file: `resolve(__dirname, '../../..')` — or `process.cwd()` when run via `npm run setup`; pick one and comment why). An invalid `setup.json` yields a target with `manifest: null` and the problem, never a crash.

Note: Albus's `gmail:auth` prints the refresh token instead of saving it, so Albus has NO `auth` entry with `doneWhen`; instead the `GOOGLE_REFRESH_TOKEN` key's help points to running `npm run gmail:auth` — the TUI's agent-detail screen offers "run a command" for any declared command (see Task 6).

- [ ] **Step 1: Failing checks** (temp dir via `mkdtempSync`): `writeEnvValue` creates the file when missing; updates in place; leaves no `*.tmp` behind; `readEnvFile` of a missing file is an empty map; `findHardcodedHubPaths` flags a fixture file containing `path.join(home, 'Documents', 'agents-hub', 'results', id)` and does NOT flag one where the line reads `process.env.ALBUS_AGENTS_HUB_DIR ?? path.join(home, 'Documents', 'agents-hub')`; `setup.json` loads as a valid target.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm run setup:check`, `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(hub): setup IO adapter and Albus's own setup.json`.

---

### Task 6: The TUI screens

**Files:** Create `src/tui/app.tsx`, `src/tui/screens/{home,agent-detail,hub-location,run-output}.tsx`, `src/tui/components/select-list.tsx`; modify `src/tui/index.tsx`.

**Interfaces:** Consumes everything from Tasks 2–5.

Behaviour (English copy):
- **Startup:** if `process.env.ALBUS_AGENTS_HUB_DIR` is unset AND `<Documents>\agents-hub` does not exist → open **HubLocation** first. Otherwise **Home**.
- **HubLocation:** text input for the parent folder, default `<USERPROFILE>\Documents`. Shows the resulting hub path live (`hubDirFromParent`). Enter → `validateHubParent`; if the current hub exists and differs: confirm "Copy N agents from X to Y? The old folder stays untouched." → `copyHub` → `verifyHubCopy` (abort and keep the old setting on any problem) → `setHubDirPersistently`. Shows "Open a new terminal for the change to apply everywhere." Then lists `findHardcodedHubPaths(newHub)` as warnings if any.
- **Home:** header row `Hub  <path>  [enter] change`; a `This machine` row with every tool declared by any target (✔/✘ via `whichTool`); one row per target with a one-line summary from `computeSetupStatus` (`ready` / `missing NOTION_TOKEN, Gmail` / `nothing to configure` / `broken: <problem>`); footer `[s] sync agents from GitHub  [r] refresh  [q] quit`. `s` → RunOutput of `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/agents.ps1 sync` (spawn args array, shell false), then refresh.
- **This machine row → Enter:** list missing tools; Enter on one with a winget id → confirm → `installTool` → RunOutput; ones without winget show their `hint`.
- **AgentDetail:** sections Keys / Permissions / Commands / Check.
  - Keys: each env item with state. Enter on a key → if `agentsHavingKey` is non-empty and the key is missing: prompt `NOTION_TOKEN is already set in mail-triage. Use the same value? (Y/n)` → copy value without displaying it. Otherwise a `TextInput` (`mask="*"` when `secret`), showing `help` above it. Empty submit = cancel. Save with `writeEnvValue`. A non-secret existing value may be shown; a secret one shows `set` only.
  - Permissions: each auth item; Enter → leave Ink (`unmount`/`clear` as Ink requires), `runAgentCommandInteractive`, then re-render and re-check `doneWhen`.
  - Commands: every declared command except `run` (e.g. `gmail-auth`, `google-auth`, `login`) can be run interactively the same way.
  - Check: Enter → `runAgentCheck` → RunOutput with ✔/✘.
  - `esc` → back to Home (refreshed).
- **SelectList:** up/down/enter/esc via `useInput`; highlighted row inverse; no extra dependency.
- Errors never crash the TUI: every adapter call is wrapped and its message rendered in red (messages never contain secret values by construction).

- [ ] **Step 1:** Build `select-list.tsx` + `run-output.tsx`, wire `app.tsx` with a `screen` state union `{ name: 'home' } | { name: 'agent', id: string } | { name: 'hub' } | { name: 'tools' } | { name: 'output', title: string, run: () => Promise<{ok:boolean;output:string}>, back: Screen }`.
- [ ] **Step 2:** Home + HubLocation. Run `npm run setup` against the real hub, read-only paths only (do not change location, do not write keys): verify every hub agent appears, broken ones with their problem.
- [ ] **Step 3:** AgentDetail. Verify by pointing `ALBUS_AGENTS_HUB_DIR` at a temp hub containing a fixture agent (copy `resources/hub-fixture-agent` and give it a `setup` block with one key + one auth whose command is a tiny `node` script that writes the `doneWhen` file): set the key, run the auth, run check — all from the TUI. The interactive part cannot be automated; drive it with Ink's `ink-testing-library` ONLY if it installs cleanly, otherwise verify by hand and say so in the commit body.
- [ ] **Step 4:** `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(tui): setup screens — hub location, tools, keys, permissions, checks`.

---

### Task 6b: Albus's face in the header

**Files:** Create `scripts/render-logo.ts`, `src/tui/logo-art.ts` (generated, committed), `src/tui/components/logo.tsx`; modify `src/tui/screens/home.tsx`; `package.json` script `"logo:render": "tsx scripts/render-logo.ts"`.

The user wants the Albus drawing (`docs/logo.png`: white wizard-in-a-triangle on transparent, orange diamond in the beard) at the top of the TUI. Terminal image protocols (Sixel/Kitty) are not reliable across Windows Terminal, Orca and plain conhost, so draw it with Unicode half blocks + truecolor, the same trick most TUI banners use.

- [ ] **Step 1:** `scripts/render-logo.ts`: load `docs/logo.png` with `sharp` (already a dependency), `trim()` the transparent margin, resize to **28 columns** wide (height = 2 pixel rows per text row, keep aspect, `kernel: 'nearest'` or `lanczos3` + threshold — pick whichever reads better and say which in a comment), read raw RGBA. For each text cell take the top and bottom pixel: alpha < 128 → transparent. Emit cells as `▀` with fg=top/bg=bottom, `▄` when only bottom is opaque, `' '` when neither. Quantize colours to two palette entries: **white `#F2F2F2`** and **orange `#F5A623`** (nearest by hue: orange when R > 200 and B < 120). Write `src/tui/logo-art.ts` exporting `export const LOGO: { char: string; fg?: string; bg?: string }[][]` plus a header comment "Generated by npm run logo:render from docs/logo.png — do not edit by hand".
- [ ] **Step 2:** `components/logo.tsx` renders `LOGO` with Ink `<Text color={fg} backgroundColor={bg}>` per run of equal cells (merge consecutive equal cells to keep the element count low), and beside it (or under it when `process.stdout.columns < 70`) `ALBUS` in bold + `setup` dim.
- [ ] **Step 3:** Show it at the top of Home only (not on every screen). If `process.stdout.columns < 40` or `NO_COLOR` is set, render just the bold `ALBUS` text.
- [ ] **Step 4:** Run `npm run logo:render` then `npm run setup` and look at it; adjust width if the triangle/beard/diamond are not recognisable. `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(tui): Albus's face in the setup header`.

---

### Task 7: `agents.ps1` honours the chosen hub + literal-path guard in `hub:check`

**Files:** Modify `scripts/agents.ps1`, `scripts/check-hub.ts`.

- [ ] **Step 1:** In `agents.ps1`, replace the `$Hub` line with:
```powershell
# The user picks the hub folder in `npm run setup`; it is stored as a user env var.
$Hub = if ($env:ALBUS_AGENTS_HUB_DIR) { $env:ALBUS_AGENTS_HUB_DIR } else { Join-Path $env:USERPROFILE 'Documents\agents-hub' }
```
Also make `install` read the variable the same way (it already uses `$Hub`). Keep the file ASCII.
- [ ] **Step 2:** In `scripts/check-hub.ts`, add a section that runs `findHardcodedHubPaths(agentsHubDir())` against the REAL installed hub and prints each hit as `WARN` (not a failure: an agent outside this repo should not break Albus's gate). Skip the section when the hub folder does not exist.
- [ ] **Step 3:** Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/agents.ps1 status` (works with no var set) and `npm run hub:check`.
- [ ] **Step 4: Commit** `feat(hub): agents.ps1 and hub:check follow ALBUS_AGENTS_HUB_DIR`.

---

### Task 8: Declare `setup` in the hub agents + read the hub variable

Each agent is its own repo under the hub (`C:\Users\PC\Documents\agents-hub\agents\<id>`), default branch `master`. One commit per repo, pushed with the GH_TOKEN prefix. **Do NOT touch `whatsapp-digest`**: another session has uncommitted work there (`src/features/self-inbox/code-roots.ts`, `work-repo.ts`). Report it as pending.

- [ ] **mail-triage:** `agent.json` add `"auth": "npm run auth"` to `commands` and:
```json
"setup": {
  "tools": ["claude"],
  "env": [
    { "key": "GOOGLE_CLIENT_ID", "label": "Google OAuth client id (Desktop app)", "secret": false },
    { "key": "GOOGLE_CLIENT_SECRET", "label": "Google OAuth client secret" },
    { "key": "TYPESAFE_API_KEY", "label": "TypeSafe API key" },
    { "key": "NOTION_TOKEN", "label": "Notion integration token (personal workspace)", "help": "notion.so/my-integrations → Secret", "optional": true },
    { "key": "NOTION_PARENT_PAGE_ID", "label": "Notion parent page id for Gastos", "secret": false, "optional": true },
    { "key": "OWNER_NAME", "label": "Your full name as your banks write it", "secret": false, "optional": true }
  ],
  "auth": [{ "label": "Gmail personal (read-only)", "command": "auth", "doneWhen": ".secrets/gmail-token.json" }]
}
```
In `src/shared/config.ts` change the results fallback to `nonBlank(env.AGENT_RESULTS_DIR) ?? path.join(nonBlank(env.ALBUS_AGENTS_HUB_DIR) ?? path.join(home, 'Documents', 'agents-hub'), 'results', AGENT_ID)` and add a case to `config.test.ts`. Run `npm test` and `npm run typecheck` in that repo.
- [ ] **utel-study:** `agent.json` add `"setup": { "tools": ["ffmpeg", "whisper", "pdftotext", "claude"], "env": [ { "key": "NOTION_TOKEN", "label": "Notion integration token (personal workspace)", "optional": true }, { "key": "NOTION_PARENT_PAGE_ID", "label": "Notion parent page id for the board", "secret": false, "optional": true } ] }` (keep `commands` as is; `login` is not in commands — add `"login": "npm run login"` so the TUI can run it). Same `config.ts` fallback change. In `scripts/run-hidden.vbs`:
```vb
hubDir = shell.ExpandEnvironmentStrings("%ALBUS_AGENTS_HUB_DIR%")
If hubDir = "%ALBUS_AGENTS_HUB_DIR%" Or hubDir = "" Then hubDir = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\Documents\agents-hub"
resultsDir = hubDir & "\results\utel-study"
```
(declare `hubDir` in the `Dim`). Run its tests/typecheck.
- [ ] **hermes-vps:** `agent.json` add `"setup": { "tools": ["ssh"], "env": [ { "key": "HERMES_VPS_HOST", "label": "ssh alias or host of the VPS", "help": "Usually albus-vps (see README)", "secret": false } ] }`.
- [ ] After each: `npm run setup:check` / `npm run hub:check` in albus still pass, `npm run setup` shows the agent's real status.
- [ ] Commit per repo: `feat: declare setup requirements for the Albus TUI` (+ `fix: results follow ALBUS_AGENTS_HUB_DIR` where config changed). Push each.

---

### Task 9: Docs — Claude operates, the user sets up

**Files:** Modify `CLAUDE.md`, `docs/MANUAL.md`, `.claude/docs/agents-hub.md`.

- [ ] `CLAUDE.md`: new section right after the title paragraph, **"Operar los agentes del usuario"** (Spanish like the rest of the file, ≤25 lines): the user opens `claude` here to operate agents; list agents → `npm run hub -- list`; run → `npm run hub -- run <id> [command]`; status/update/clone → `powershell -File scripts/agents.ps1 status|update|clone`; results in `<hub>\results\<id>\` (hub = `ALBUS_AGENTS_HUB_DIR` or `Documents\agents-hub`); keys/permissions are the user's job in `npm run setup` — Claude never asks for a secret in chat; a new agent → hub folder + private repo + topic `albus-agent` + `setup` block in its `agent.json`. Add `npm run setup` and `npm run setup:check` to the Comandos block.
- [ ] `docs/MANUAL.md`: "Máquina nueva" becomes: tools → `gh auth login` → clone Albus → `npm install` → **`npm run setup`** (choose hub folder, it syncs agents, asks keys, opens Google permissions). The USB table shrinks to "sessions are redone by hand; keys are entered in the TUI". Add "Día a día: entra a la carpeta de Albus y escribe `claude`".
- [ ] `.claude/docs/agents-hub.md`: document the `setup` field (table like the existing one), `setup.json`, and the hub-location rules (copy never move, `setx`, literal-path guard).
- [ ] Commit `docs: the TUI sets a machine up, Claude operates the agents`. Push albus.

---

## Self-review notes

- Spec coverage: contract (T2), env writing (T3, T5), status/reuse (T4, T6), auth via commands (T5, T6), tools/winget (T5, T6), sync (T6), Albus pseudo-agent (T5), hub location + copy + setx + literal guard (T4–T7), agents updated (T8), CLAUDE.md operating section + manual (T9). whatsapp-digest deferred on purpose (concurrent session).
- The interactive TUI flow is verified by hand where Ink testing is not viable; every pure rule has a scripted check.
