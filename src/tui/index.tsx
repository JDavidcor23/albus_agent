// Toolchain spike: Ink under tsx. Two real failures hit while proving this,
// neither of them the `ERR_REQUIRE_ASYNC_MODULE` this spike was built to
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
import { render, Text } from 'ink'

render(<Text color="green">Albus setup</Text>)
