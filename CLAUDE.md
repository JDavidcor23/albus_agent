# Albus Agent

Worker de escritorio (Electron) que lee las notas capturadas por **My Notes**
(`../my_brain`, Next.js + Supabase) y las convierte en datos: QRs, comprobantes,
contactos, pendientes, un grafo. Y es el **contenedor de los agentes del
usuario**: hoy vive ahí el de búsqueda de trabajo. **No es una app de notas** —
My Notes escribe; Albus lee y escribe de vuelta.

## Índice — este archivo es lo único que se carga solo; el resto hay que ir a buscarlo

| Antes de tocar… | Leé |
|---|---|
| **cualquier VALOR string que salga de este proceso** (Notion, Drive, `userData`, CSV, sesión, grafo) | `.claude/docs/frozen-contracts.md` — **empezá por acá** |
| `src/main/` en general, o antes de mover un archivo de carpeta | `.claude/docs/architecture.md` |
| `src/main/core/extraction/`, `core/graph/`, `core/tasks/` | `.claude/docs/extraction-cascade.md` |
| `src/main/core/jobs/`, `src/main/jobs/`, `src/main/gmail/` | `.claude/docs/job-application.md` |
| `src/main/agents/` o las reglas `.md` del usuario | `.claude/docs/agents.md` |
| `src/main/connections/`, `src/main/browser/` | `.claude/docs/connections.md` |
| `src/main/notion/`, `core/jobs/rank.ts`, `jobs/tracker.ts` | `.claude/docs/notion-and-tracking.md` |
| sharp, tesseract, CDP, un DOM ajeno, un error raro de Supabase | `.claude/docs/gotchas.md` |
| algo que "está mal" y parece obvio de arreglar | `.claude/docs/known-debt.md` · `src/main/devtools/README.md` |
| un video, un audio, "analizá esta grabación", `src/main/video/`, `core/video/` | `.claude/docs/video-analysis.md` — Claude no acepta video: hay que convertirlo, y whisper INVENTA sobre el silencio |
| un agente EXTERNO, `agent.json`, `src/main/hub/`, `core/hub/`, "instalar un agente" | `.claude/docs/agents-hub.md` — el agente NO hereda el env de Albus (tiene el `service_role`), y sus comandos nunca tocan un shell |

## Los dos repos: la frontera de seguridad

| | `my_brain` (My Notes) | `albus_agent` (este) |
|---|---|---|
| Corre en | Navegador | Escritorio (Electron) |
| Key de Supabase | `publishable` | **`service_role`** |
| RLS | Aplica | **Se saltea** |
| Rol | Captura + muestra | Procesa |

**La separación no es estética.** El service role key saltea RLS por completo, y en
un Next.js que convive con `NEXT_PUBLIC_*` un import mal puesto lo filtra al bundle
y expone la base entera. Nunca muevas el key a `my_brain`; nunca importes
`src/main/supabase/` desde el renderer.

## Arquitectura mínima

Main (Node completo) = servidor Express local: dueño de la ventana, de Supabase,
de los CLIs y de **todo el dominio**. Renderer (Chromium + React) solo pinta.
Preload expone `window.api`. **IPC = fetch.** Árbol completo en `architecture.md`.

```
src/main/core/     DOMINIO puro: extraction · jobs · graph · tasks — NO importa electron
src/main/          adaptadores: agents · browser · connections · jobs · supabase · notion ·
                   drive · gmail · graph · providers · devtools · ipc · paths.ts · index.ts
src/preload/       contextBridge → window.api      src/renderer/src/  React, nunca src/main/**
src/shared/        ipc.ts — el contrato. No importa nada.
scripts/           corren con tsx     supabase/migrations/  SQL aplicado a mano (0001-0004)
.claude/agents/    subagentes de Claude Code · .claude/docs/  esta documentación
```

## Contratos congelados — lo que rompe SIN tirar error

Podés renombrar el identificador, **nunca el valor**. El porqué de cada uno, en
`.claude/docs/frozen-contracts.md`.

| Valor | Qué se rompe en silencio |
|---|---|
| `albus_agent/`, `agents/`, `graphify/`, `albus.yml`, `connections.json`, `<id>.agente.json`, `<id>.preguntas.json` | se abandona el estado del usuario: agentes, reglas, tokens, conexiones, grafo, cola de preguntas |
| `agents-hub/`, `agents/`, `results/`, `agent.json` (el hub de agentes externos) | los agentes instalados desaparecen de la lista, o sus resultados quedan huérfanos en la carpeta vieja |
| `video/`, `meta.json`, `transcript.srt` | la biblioteca de transcripts se vacía o pierde todos los títulos. Sin error: las filas vuelven a llamarse por su timestamp y nadie distingue una reunión de otra |
| `'albus-agent'` (el `userData` de Electron) | se pierde la partición del navegador: hay que loguearse de nuevo en LinkedIn y Google |
| `'post link'` y todo nombre de propiedad/opción de Notion | el upsert se vuelve insert; Notion inventa columnas y opciones; los filtros dejan de traer nada |
| `'pagos'`, `'qr-eventos'`, `'contactos'`, `'info'`, `'sin-clasificar'` | Drive crea carpetas nuevas VACÍAS y deja el archivo viejo atrás |
| `'persist:albus-jobs'` | se pierden las sesiones de LinkedIn y Google; hay que loguearse a mano |
| los 13 headers de `COLUMNS`, `albus-profile.json`, `seen_jobs.json` | contrato con lo que también escriba ese workspace. Vive en `agents/<id>/`, derivado del id del agente: **no hay variable de entorno que configurar** |
| `trabaja_en`, `conoci_en`, `organiza`, `pagado_a`, `trata_de`, `enlaza_a` | el grafo se parte: aristas viejas y nuevas dejan de ser el mismo tipo |
| `'## Respuestas a lo que el agente preguntó'` y el formato de la viñeta | la sección se duplica; las respuestas dejan de verse (ya pasó) |

## Convenciones que NO se rompen

- **IPC como sobre tipado:** toda respuesta es `{ok:true,data} | {ok:false,error:{code,message}}`,
  siempre vía `registerHandler`. El renderer nunca recibe excepciones crudas, y el
  main nunca confía en el renderer: payloads validados con zod.
- **Todo lo que vuelve de Supabase es input externo** — sobre todo `attachments`,
  `jsonb` sin esquema. Y **validá por fila, no por lote**: un `.parse()` sobre el
  array entero convierte un registro corrupto en cero progreso para siempre.
- **Nada de colas que se tapan.** Un `order desc` + `limit` fijo deja de alcanzar
  los registros viejos en cuanto los primeros N están procesados.
- **La cascada nunca propaga excepciones:** el item que falla se escribe con
  `kind: 'failed'` y el worker sigue. Y la **idempotencia es por esquema, no por
  flag** — el unique `(entry_id, attachment_path)` en `extractions` es lo que hace
  seguro reprocesar. No agregues `processed`.
- **Secretos y CLIs solo en el main.** Si falta la variable, fallá ruidoso al
  arrancar; nunca un literal, nunca commiteado. Binario resuelto con `where`,
  flags en allowlist, timeout duro, salida validada, jamás `exec` con strings.
- **El escalón caro va último.** Regex antes que modelo — salvo en conexiones,
  donde el agente va primero y el porqué está en `connections.md`.
- **Todo en inglés: código, copy de UI y comentarios nuevos.** Cambió el 2026-08-12;
  antes el copy de UI iba en español. Los comentarios viejos en español se dejan —
  se traducen solo si se reescribe el archivo entero. **Los valores de la tabla de
  arriba NO son copy y siguen en español para siempre**: son dato que el sistema
  compara, no texto que alguien lee.

## El punto ciego: `typecheck` no cruza el IPC

`ipcRenderer.invoke` pasa `unknown` y el handler valida con zod **en runtime**. Un
preload que manda `{ taskId }` contra un schema que espera `{ id }` **compila
limpio** y falla recién cuando el usuario aprieta el botón. Por eso
`src/shared/ipc.ts` + `src/preload/index.ts` + `src/main/ipc/*.ts` se mueven en el
**mismo commit**, siempre: es el único agujero de verificación del proyecto.

## "agente" significa dos cosas acá — no lo "arregles"

`src/main/agents/` son los agentes de **Albus** (concepto de producto: la app es un
contenedor de agentes, los usa el usuario final). `.claude/agents/` son subagentes
de **Claude Code**, herramienta de desarrollo. La colisión se evaluó durante el
refactor a inglés y se dejó a propósito. Gate de todos ellos: `npm run typecheck`;
detalle en `.claude/agents/README.md`.

| Agente | Dispara cuando | Puede tocar |
|---|---|---|
| `renderer-agent` | UI: componentes, paneles, chat, estilos | `src/renderer/**` (una sola hoja: `assets/main.css`) |
| `main-process-agent` | dominio y adaptadores: extracción, jobs, Supabase, Notion, Drive, Gmail, CLI, browser | `src/main/**` menos `src/main/ipc/` |
| `ipc-contract-agent` | una llamada cruza main↔renderer: canal nuevo o renombrado, payload cambiado, evento push | `shared/ipc.ts` + `preload/index.ts` + `main/ipc/*.ts`, **juntos** |
| `clean-code-reviewer` | después de cualquiera de los tres, o ante "revisá / limpiá / auditá esto" | los mismos archivos del cambio |
| `project-rules-oracle` | "¿cuál es la regla acá para X?" — read-only, nunca edita | nada (Read/Glob/Grep) |

## Comandos

```bash
npm run dev / build      # HMR · build (build corre typecheck primero)
npm run typecheck        # node + web. EL gate: no hay linter ni test runner.
npx tsx scripts/x.ts     # un script TS sin build
npm run jobs:check       # dominio puro + contrato IPC, sin Electron ni red
npm run ipc:check        # solo el punto ciego: claves del preload vs. schemas zod del main
npm run video:check      # dominio del video + binarios. Con una ruta, corre el pipeline entero:
                         #   npm run video:check -- "grabacion.mp4" 210
npm run hub:check       # contrato de agentes externos + un agente de prueba de punta a punta
npm run hub -- list | run <id> [comando] | install <url|carpeta> [--link]   # el hub, sin Electron
npm run jobs:check:live  # los que tocan red y credenciales (scraping, Notion, Gmail)
npm run jobs:selftest    # navegador contra resources/job-form-fixture.html
npm run nav:check        # "el agente mira la página", con un modelo falso
npm run ui:selftest      # la pestaña de agentes contra el DOM real
npm run notion:check     # ¿la API de Notion contesta? 401 vs 404. No gasta cuota.
npm run nav:inspect -- <url>   # qué ve el agente ahí. No clickea, no gasta cuota.
npm run jobs:login       # abrir LinkedIn y entrar a mano. Una sola vez.
npm run gmail:auth       # pedir el scope de Gmail. Una vez.
npm run jobs:apply -- '{"url":"…","company":"…","role":"…","slug":"…","mode":"review"}'
node scripts/run-jobs.mjs demo | supa | notion-probe   # capturas · Supabase · Notion vivo
```

`mode`: `dry-run` no toca la página · `review` llena y frena antes de enviar
(default) · `auto` envía. Antes de tocar `core/jobs/`: `jobs:check` **y**
`jobs:selftest`. **Nunca uses `npx rg`** — acá resuelve a un paquete basura que
escribe un `README.md` espurio en la raíz.
