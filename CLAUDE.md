# Albus Agent

El CLI que corre los agentes del usuario. Cada agente es una carpeta del
monorepo `agents-hub` con su `agent.json`; Albus los descubre, los corre con un
entorno limpio y junta lo que producen. Albus en WhatsApp vive en un VPS
(Hermes) y le pide trabajo al PC por el `bridge`.

**No hay app de escritorio.** Hasta el 2026-10-09 esto era una app Electron
(notas de Supabase, agente de búsqueda de trabajo, grafo, video, Udemy). Murió
entera: lo que sobrevive es el hub y el TUI. Si algo de eso hace falta, vive
en el historial de git, no se resucita acá.

## Operar los agentes del usuario

Esta carpeta es la casa de Claude: el usuario abre `claude` acá y pide lo que
necesita de sus agentes. La otra puerta es el TUI (`npm run setup`), del
usuario — ahí van las claves y los permisos, nunca acá: **Claude nunca pide un
secreto por chat**, eso es trabajo del usuario en el TUI.

| Pedido | Comando |
|---|---|
| Listar agentes y su estado | `npm run hub -- list` |
| Correr uno | `npm run hub -- run <id> [comando]` |
| Estado (ahead/behind/dirty, por agente y del repo) | `powershell -File scripts/agents.ps1 status` |
| Traer los que faltan / actualizar los instalados | `powershell -File scripts/agents.ps1 clone` / `update` |

Resultados en `<hub>\results\<id>\`, con `<hub>` = `ALBUS_AGENTS_HUB_DIR` si
está seteada, si no `Documents\agents-hub`.

**Agente nuevo:** carpeta física en el hub (`agents-hub/agents/<id>/`, nunca en
otra carpeta ni con `--link`), commiteada y empujada al monorepo `agents-hub`
con `"draft": true` en su `agent.json` desde el primer commit +, si necesita
claves, herramientas o permisos, el bloque `setup` — el usuario completa eso
después con `npm run setup` y saca el `draft` cuando decide publicarlo.

## Índice — este archivo es lo único que se carga solo

| Antes de tocar… | Leé |
|---|---|
| cualquier VALOR string que salga de este proceso (carpetas, nombres de archivo, variables de entorno) | `.claude/docs/frozen-contracts.md` — **empezá por acá** |
| `agent.json`, `src/hub/`, `src/core/hub/`, "instalar un agente" | `.claude/docs/agents-hub.md` — el agente NO hereda el env de Albus, y sus comandos nunca tocan un shell |
| `provides`/`uses`/`grants`, un agente llamando a Google/Notion/WhatsApp | `.claude/docs/agent-services.md` — un agente proveedor por servicio externo, nadie más tiene el token |
| un comando que usa el usuario (`package.json` scripts, `scripts/agents.ps1`) | `docs/MANUAL.md` — el manual de Jorge, en español simple. **Si agregás, renombrás o borrás un comando suyo, se actualiza en el mismo commit** |

## Estructura

```
src/core/hub/     dominio puro: manifest, protocolo, env, servicios, setup — sin I/O de proceso
src/hub/          adaptadores: descubrir, instalar, correr, setup-io
src/agents/       reglas (.md) y cola de preguntas de cada agente
src/paths.ts      dónde viven los datos del usuario
src/tui/          el TUI de `npm run setup` (Ink + React)
scripts/          hub.ts (el CLI), check-hub.ts, check-setup.ts, agents.ps1, hub-reminder.mjs
resources/        hub-fixture-agent: el agente de prueba de `hub:check`
```

## Convenciones que NO se rompen

- **Todo agente vive FÍSICAMENTE en el hub:** `Documents/agents-hub/agents/<id>/`, una
  carpeta plana del monorepo `agents-hub`, con su `.env` y su estado local adentro
  (gitignored). Nunca se crea el código de un agente en otra carpeta ni se instala con
  `--link`: el usuario pidió que eso no pase nunca más (2026-10-04). El push ES el
  backup; publicarlo (sacarle el `draft`) es una decisión aparte de Jorge.
- **Un agente por servicio.** Google, Notion y WhatsApp tienen cada uno su agente
  proveedor y son los ÚNICOS con credenciales. Los demás los llaman por el protocolo 1.
- **El sobre es siempre** `{ok:true,data} | {ok:false,error:{code,message}}`.
- **Todo lo que llega de afuera se valida con zod**, y por fila, no por lote: un
  `.parse()` sobre el array entero convierte un registro corrupto en cero progreso.
- **Comandos en allowlist, nunca un shell.** Binario resuelto con `where`, timeout
  duro, jamás `exec` con strings.
- **Todo en inglés: código y comentarios nuevos.** Los comentarios viejos en español
  se dejan. **Los valores congelados siguen en español para siempre**: son dato que
  el sistema compara, no texto que alguien lee.

## Comandos

```bash
npm run typecheck        # EL gate. No hay linter.
npm run hub:check        # contrato de agentes + un agente de prueba de punta a punta
npm run setup:check      # dominio puro de `setup` + temp-dir — nunca toca la máquina real
npm run hub -- list | run <id> [comando] | install <url|carpeta>
npm run setup            # TUI del USUARIO: hub, claves, permisos, check de cada agente
npm run logo:render      # regenera src/tui/logo-art.ts desde docs/logo.png
powershell -File scripts/agents.ps1 sync|clone|update|status|install
```

**Nunca uses `npx rg`** — acá resuelve a un paquete basura que escribe un
`README.md` espurio en la raíz.
