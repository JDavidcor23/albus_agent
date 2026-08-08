# Arquitectura

Tres procesos, el mismo modelo mental que una app web:

- **Main** (Node completo): dueño de la ventana, de Supabase, de la ejecución de
  CLIs y de **todo el dominio**. Mental: un servidor Express local.
- **Renderer** (Chromium + React): solo pinta y pide datos. Nunca habla con
  Supabase, nunca importa `electron`, nunca importa `src/main/**`.
- **Preload**: expone `window.api` tipada vía `contextBridge`.
- **IPC = fetch**: `window.api.x()` → `ipcRenderer.invoke('x')` → `ipcMain.handle('x')`.

## Stack

- **electron-vite** (React 19 + TS), main/preload/renderer separados con HMR.
- **@supabase/supabase-js** en el main, con service role.
- Extracción local y gratuita: **sharp** (imágenes), **jsqr** (QR),
  **tesseract.js** (OCR).
- IA: **CLIs locales ya autenticados** (`claude`, `agy`) vía adaptadores en
  `providers/`. Sin APIs de pago.
- **zod 4** para todo lo que entra de afuera.
- Sin linter y sin test runner, por decisión del dueño. El gate es
  `npm run typecheck` más los scripts de `check`.

## El árbol real

```
src/
├─ main/
│  ├─ index.ts                bootstrap: ventana, lifecycle, wiring de resolvers
│  ├─ paths.ts                userData — dónde vive el estado del usuario
│  ├─ ipc/                    register-handler.ts (el sobre) + un archivo por dominio:
│  │                          extraction · graph · tasks · jobs · connections
│  ├─ core/                   ── DOMINIO ── nada de acá importa `electron`
│  │  ├─ extraction/          types · ports · llm-port
│  │  │                       qr (escalón 1) · ocr (2) · patterns (3) · llm-classify (4)
│  │  │                       cascade (orquesta) · clean-ocr · archive · present · worker
│  │  ├─ jobs/                types · ports (BrowserPort) · profile
│  │  │                       answers (esc. 1-3) · answers-llm (esc. 4) · resolveOption
│  │  │                       apply (el bucle) · submit-guard (el freno) · cv-name
│  │  │                       rank (triage) · notion-map · chat · email
│  │  ├─ graph/               build (batches al CLI) · merge · types
│  │  └─ tasks/               detect · ask · rules · qr-identity · types
│  ├─ agents/                 registry · rules · questions   ← agentes de ALBUS
│  ├─ browser/                page (BrowserPort) · page-scripts (JS inyectado) · session
│  ├─ connections/            connection-agent (EL motor) · services (la tabla de datos)
│  │                          navigate-llm · registry · store · albus-yml · google-oauth
│  ├─ jobs/                   hunt · search · apply-runner · email-runner · kit
│  │                          tracker (CSV) · workspace (ai-job-search) · headless
│  ├─ supabase/               client (service role) · item-source · result-sink
│  │                          results-repo · tasks-repo · note-summary-repo · retry
│  ├─ notion/                 client · applications
│  ├─ drive/                  client · archive
│  ├─ gmail/                  send
│  ├─ graph/store.ts          persiste graph.json en el Escritorio, no en el repo
│  ├─ providers/              claude-code · agy · cli-common · registry · model-discovery
│  └─ devtools/               selftests y diagnósticos. Ver su propio README.
├─ preload/index.ts           contextBridge → window.api (+ index.d.ts)
├─ renderer/src/              App.tsx + components/ (AgentsPanel, JobChat, ChatPanel,
│                             ConnectionsPanel, GraphView, ResultsFeed, LeftPanel, …)
└─ shared/                    ipc.ts — el contrato, no importa NADA · google-calendar.ts

supabase/migrations/          SQL aplicado a mano en el dashboard (0001-0004)
resources/                    fixtures de verificación (job-form-fixture.html)
scripts/                      corren con `tsx`: check-* · verify-* · inspect-* · drive-*
.claude/agents/               subagentes de Claude Code (herramienta de desarrollo)
.claude/docs/                 esta documentación
```

## `src/main/devtools/` — por qué está ahí y no en `scripts/`

Siete archivos de autochequeo y diagnóstico: `selftest.ts`, `nav-selftest.ts`,
`ui-selftest.ts`, `ui-demo.ts`, `inspect.ts`, `probe-notion.ts`, `repro.ts`.

Se llegan por variables de entorno `ALBUS_*` a través de `jobs/headless.ts`,
**nunca desde código de producción**. Están bajo `src/main/` porque necesitan un
`BrowserWindow` de verdad y el `app` de Electron, y `headless.ts` los importa
dinámicamente desde dentro del bundle del main. `scripts/` corre bajo `tsx`
pelado, donde no hay runtime de Electron.

Son dev-only y candidatos a exclusión de build antes de empaquetar. Tienen su
propio README en `src/main/devtools/README.md`.

## Las reglas de capa

| Regla | Se rompe cuando |
|---|---|
| `src/main/core/**` nunca importa `electron` | alguien necesita `app.getPath()` en el dominio. La salida es un port, no un import |
| `src/renderer/**` nunca importa `src/main/**` | un tipo "queda cómodo". Un leak de `src/main/supabase/` mete el service role key en el bundle |
| `src/shared/ipc.ts` no importa nada | alguien mete un tipo de zod o de electron ahí |
| Todo handler pasa por `registerHandler` | alguien llama a `ipcMain.handle` directo y devuelve una excepción cruda al renderer |
| Los CLIs solo se ejecutan desde el main | binario resuelto con `where`, flags en allowlist, timeout duro, salida validada |

## El punto ciego: `npm run typecheck` no cruza el IPC

Es el único agujero real de verificación del proyecto y conviene tenerlo
presente cada vez que se toca un handler.

`ipcRenderer.invoke` pasa `unknown`. El handler valida con zod **en runtime**.
Un preload que manda `{ taskId }` contra un schema que espera `{ id }`
**compila limpio** y falla recién cuando el usuario aprieta el botón, como un
error de zod envuelto en el sobre.

Por eso los tres lados se mueven en el mismo commit:

```
src/shared/ipc.ts      nombre de canal + tipos de payload/resultado
src/preload/index.ts   método de window.api → ipcRenderer.invoke
src/main/ipc/*.ts      registerHandler → zod → llamada al dominio
```

Y por eso existe el subagente `ipc-contract-agent`: no es organización, es la
compensación de una garantía que el compilador no da.

## La palabra "agente" significa dos cosas acá

Colisión deliberada. **No la "arregles".**

| | Qué es | Quién lo usa |
|---|---|---|
| `src/main/agents/` | los agentes de **Albus**: búsqueda de trabajo, y los que vengan. Es un concepto de PRODUCTO — la app es un contenedor de agentes | el usuario final, desde la pestaña "Agentes" |
| `.claude/agents/` | subagentes de **Claude Code**: renderer, main, IPC, review, oracle. Es herramienta de DESARROLLO | quien programa este repo |

Se evaluó renombrar uno de los dos durante el refactor a inglés y se decidió que
no: `agents` es el nombre correcto para los dos, y forzar `runtime-agents/` o
`dev-agents/` sería inventar vocabulario para resolver un problema que solo
existe si uno lee el nombre sin el contexto. La colisión está documentada, que
es más barato que renombrarla.
