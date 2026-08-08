# devtools

Test harnesses and one-off diagnostics: `selftest.ts`, `nav-selftest.ts`,
`ui-selftest.ts`, `ui-demo.ts`, `inspect.ts`, `probe-notion.ts`, `repro.ts`.
They are reached through env vars (`ALBUS_*`) via `jobs/headless.ts`, never
from production code paths.

**Why they stay under `src/main/` and not in `scripts/`:** they need a real
`BrowserWindow` and Electron's `app`, and they are dynamically imported by
`src/main/jobs/headless.ts` from inside the bundled main process. `scripts/`
runs under plain `tsx`, where no Electron runtime exists.

**Dev-only.** Nothing here should run for an end user. This directory is a
candidate for build exclusion before packaging, so the harnesses stop shipping
in the production bundle.
