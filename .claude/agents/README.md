# Agents

Five agents for Albus Agent (Electron + React 19 + TypeScript). Gate is `npm run typecheck`
— this project has **no lint script and no test runner**, by the owner's decision.

| Agent | Fires when | May touch |
|---|---|---|
| `renderer-agent` | UI work: components, panels, chat views, styling | `src/renderer/**` (single stylesheet: `assets/main.css`) |
| `main-process-agent` | Domain and adapters: extraction, jobs, Supabase, Notion, Drive, Gmail, CLI, browser | `src/main/**` (except `src/main/ipc/`) |
| `ipc-contract-agent` | A call crosses main↔renderer: new/renamed channel, changed payload, new push event | `src/shared/ipc.ts` + `src/preload/index.ts` + `src/main/ipc/*.ts`, together |
| `clean-code-reviewer` | After any of the three above, or on "review / clean up / audit this" | Same files as the change under review |
| `project-rules-oracle` | "What's the rule for X here?" — read-only, never edits | Nothing (Read/Glob/Grep only) |

## Why `ipc-contract-agent` is separate

`invoke` passes `unknown` and the handler validates with zod at runtime. A preload sending
`{ taskId }` against a schema expecting `{ id }` **passes typecheck** and breaks only on click.
Those three files must move in one commit.

## Conventions every agent enforces

- New code is written in **English**. Frozen string *values* (Notion columns, Drive folders,
  `userData` filenames, `persist:albus-jobs`, CSV headers, `agentes/<id>.md` headings) never change.
- `src/main/core/**` never imports `electron`; `src/renderer/**` never imports `src/main/**`.
- Every IPC response is the envelope `{ok:true,data} | {ok:false,error}`.
- External input is validated with zod — **per row via `safeParse`**, never `.parse()` on an array.

## Skills

`skills/frontend-design/` applies fully. `skills/vercel-react-best-practices/` is Next.js-oriented:
the `rerender-*`, `rendering-*`, `js-*` and `advanced-*` groups apply; the `server-*`, hydration
and `bundle-*` groups do not. See `renderer-agent.md` for the full scoping note.
