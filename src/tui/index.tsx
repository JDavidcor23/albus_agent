// `npm run setup` entry point. Ink under tsx: two real failures hit while
// proving the toolchain, neither of them the `ERR_REQUIRE_ASYNC_MODULE` the spike was built to
// watch for — recorded here since both are easy to reintroduce by accident:
//
// 1. Without `src/tui/package.json` (`{ "type": "module" }`), esbuild refuses
//    to transform `yoga-layout` (an Ink dependency): "Top-level await is
//    currently not supported with the "cjs" output format". tsx decides
//    CJS-vs-ESM per nearest `package.json`, and without this one it treats
//    everything under `src/tui/` as CJS.
// 2. `npm run setup` runs `tsx --tsconfig tsconfig.tui.json ...` and NOT bare
//    `tsx src/tui/index.tsx`. tsx picks the tsconfig to read `compilerOptions`
//    from by walking up from `process.cwd()` (repo root), not from the file
//    being run — so it would otherwise load the root `tsconfig.json`, which
//    is solution-style (`"files": []`, project references only, no `jsx`
//    option). That makes esbuild fall back to the classic runtime
//    (`React.createElement`), and with no `import React from 'react'` in
//    scope (unneeded under `jsx: "react-jsx"`, see below) it throws
//    `ReferenceError: React is not defined` at the `render(...)` call below.
//    The explicit `--tsconfig` flag is what makes tsx and
//    `typecheck:tui` (`tsc -p tsconfig.tui.json`) agree on the JSX runtime,
//    without touching the root `tsconfig.json`.
//
// No `import React from 'react'` here: with `jsx: "react-jsx"` (the
// automatic runtime) — from `tsconfig.tui.json`, loaded per the point above —
// the compiler injects its own `react/jsx-runtime` import and never
// references the `React` identifier, so an explicit import would trip
// `noUnusedLocals` (TS6133) without ever being needed.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { win32 } from 'node:path'
import { render } from 'ink'

import { resolveHubDir } from '../main/core/hub/hub-location'
import { App } from './app'
import type { Screen } from './screen'

// Startup rule: no ALBUS_AGENTS_HUB_DIR and no hub at the default location
// means this machine has never had a hub — ask where it should live first.
// The default is computed the same way `paths.ts` does (USERPROFILE first),
// without importing it: it pulls in electron.
//
// A variable that IS set but is not an absolute path cannot be a hub (a
// relative one would resolve against whatever folder the shell was in), so
// it also goes to HubLocation first, which shows it as the current value.
const variable = (process.env.ALBUS_AGENTS_HUB_DIR ?? '').trim()
const defaultHub = resolveHubDir({}, process.env.USERPROFILE ?? homedir())
const needsLocation = variable === '' ? !existsSync(defaultHub) : !win32.isAbsolute(variable)
const initialScreen: Screen = needsLocation ? { name: 'hub' } : { name: 'home' }

render(<App initialScreen={initialScreen} />)
