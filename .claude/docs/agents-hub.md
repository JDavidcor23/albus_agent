# Albus como orquestador: el hub de agentes externos

> Diseño escrito la noche del 2026-10-03, a partir de
> `my_proyects/whatsapp/docs/albus-orchestrator-prompt.md`. Las decisiones que el
> prompt pedía confirmar se tomaron sin el usuario (estaba durmiendo) y están
> marcadas **[DECIDIDO SIN CONFIRMAR]**: son las primeras a revisar.

## La idea en una línea

Albus deja de ser el lugar donde VIVE el código de los agentes y pasa a ser quien
los **descubre, instala, ejecuta y muestra**. El código de cada agente es una
carpeta propia (su propio repo git) y lo que produce va a otra carpeta propia.

Analogía de obra: hasta ahora Albus era una casa con los electrodomésticos
empotrados en la pared. Ahora es el tablero eléctrico: define el enchufe (el
contrato) y cualquier aparato que respete el enchufe se conecta, se prende y se
mide. El aparato funciona igual enchufado en otra casa (Orca, el programador de
tareas de Windows, una terminal).

## Las carpetas

```
Documents/agents-hub/            ← agentsHubDir()   (ALBUS_AGENTS_HUB_DIR la mueve)
  agents/                        ← agentsCodeDir()  el CÓDIGO, una carpeta por agente
    whatsapp-digest/
      agent.json                 ← el contrato con Albus
      ...su código, su package.json, su .git
  results/                       ← lo que PRODUCEN
    whatsapp-digest/             ← agentResultsDir(id), mismo id que la carpeta de código
Documents/albus_agent/           ← solo el estado de Albus: albus.yml, connections.json,
                                    graphify/, agents/ (reglas .md y cola de preguntas)
%APPDATA%/albus-agent/agent-runs ← el log de cada corrida (desechable, como todo cacheDir)
```

**[DECIDIDO SIN CONFIRMAR]** La raíz es `Documents/agents-hub`, calculada a mano
igual que `dataDir()` (nunca `app.getPath('documents')`: ver el comentario de
`documentsDir()` en `paths.ts`, colgaba el arranque con OneDrive).

**Valores nuevos congelados**: `agents-hub`, `agents`, `results`, `agent.json`.
Cambiar cualquiera abandona los agentes instalados o sus resultados.

Las reglas `.md` y la cola de preguntas **siguen en `Documents/albus_agent/agents/`**:
son la forma en que el USUARIO le habla al agente a través de Albus, o sea estado de
Albus. Al agente le llega la ruta por `AGENT_RULES_PATH`.

El log de cada corrida va a `cacheDir()`, no a `results/`: es diagnóstico de Albus,
no un entregable del agente, y "Albus nunca escribe en la carpeta del agente" es la
misma regla en las dos direcciones.

## El contrato: `agent.json`

```json
{
  "protocol": 1,
  "id": "whatsapp-digest",
  "name": "WhatsApp digest",
  "description": "Resume los grupos de WhatsApp y dice qué requiere atención",
  "version": "0.1.0",
  "commands": {
    "run": "npm run digest",
    "check": "npm run check"
  },
  "timeoutMinutes": 30,
  "needs": ["sesión de WhatsApp vinculada"],
  "schedule": "daily 08:00",
  "exitCodes": { "2": "La sesión de WhatsApp venció: vincúlala de nuevo con npm run dev" }
}
```

| Campo | Regla | Por qué |
|---|---|---|
| `protocol` | entero, hoy solo `1` | sin versión, el día que cambie el formato de eventos no hay forma de saber qué agente habla qué |
| `id` | `^[a-z0-9][a-z0-9-]{1,48}$` y **igual al nombre de la carpeta** | el id arma rutas (`results/<id>`). Si pudiera diferir de la carpeta, dos agentes podrían escribir en los mismos resultados |
| `commands.run` | obligatorio | es lo único que Albus necesita para que el agente sirva |
| `commands.check` | opcional | se corre al instalar y a pedido, nunca al listar (listar no puede tardar minutos) |
| `commands.*` | allowlist, ver abajo | un string de un tercero nunca toca un shell |
| `timeoutMinutes` | 1–240, default 30 | timeout duro, igual que todos los CLIs del proyecto |
| `needs` | strings libres, **solo informativos** | Albus no puede sondear la sesión de WhatsApp de otro programa. El sondeo real es `check` |
| `schedule` | string libre, informativo | Albus no programa: lo hace Orca o el SO, para que corra con Albus cerrado |
| `exitCodes` | `{ "<código>": "mensaje" }` | el `2 = hay que escanear el QR` de WhatsApp, generalizado. Es dato, no un `if` por agente |
| `runLabel` | string, 0–40 caracteres, default `''` | la etiqueta del botón primario en la pantalla del agente (p. ej. `"Generate digest"`). `''` (o un manifiesto viejo sin el campo) hace que la UI muestre `"Run"` — ningún `.min(1)`: un `runLabel: ""` explícito cae en el mismo fallback en vez de rechazar el manifiesto por un campo cosmético |
| `hidden` | boolean, default `false` | opt-out EXPLÍCITO del dueño del agente: "corro esto solo desde CLI/Orca, no lo quiero en la lista de Albus". Un manifiesto viejo sin el campo sigue viéndose, igual que siempre. Se filtra únicamente en `hub/agent-info.ts` (lo que arma `agents:list` para el renderer) — `hub/discover.ts#listExternalAgents` nunca lo filtra, porque `runner.ts` y `npm run hub -- run <id>` tienen que seguir encontrando el agente por id. `npm run hub -- list` también lo sigue imprimiendo, marcado `(hidden)`. **No es la misma regla que un `agent.json` roto**: un manifiesto inválido siempre se lista con su problema (`entry.manifest === null`, nunca `hidden`); `hidden: true` es lo contrario — un manifiesto SANO que el dueño pidió no mostrar |

### Los comandos: allowlist, no shell

Un comando es una línea que **se parte en espacios**, sin comillas ni escapes:

- El primer token es `npm` o `node`. Nada más.
- `npm` solo con `run <script> [-- args]`, `test` o `start`.
- `node` solo con un archivo `.js|.mjs|.cjs|.ts` **dentro de la carpeta del agente**.
- Cada token tiene que matchear `^[A-Za-z0-9@._:=/+,-]+$`: sin `&`, `|`, `>`, `;`,
  comillas, `%` ni `$`.

Se ejecuta con `shell: false`. `node` se resuelve con `where` (es un `.exe` de
verdad). `npm` NO se puede lanzar sin shell en Windows (es un `.cmd`, y Node ≥ 20
tira `EINVAL`), así que se ejecuta como `node <npm-cli.js> run …`, con
`npm-cli.js` buscado al lado del `node.exe` resuelto.

Lo que el `package.json` del agente haga adentro de su script es código del
agente: lo instalaste, confías en él igual que en cualquier dependencia. La
allowlist protege contra el `agent.json` como vector, no contra el agente.

### El entorno: allowlist, no herencia

**El agente NO hereda el `process.env` de Albus.** Albus tiene en su entorno la
`service_role` de Supabase, que saltea RLS. Heredarlo sería entregarle la base
entera a cualquier agente de terceros que se instale. Es la misma frontera de
seguridad que separa `my_brain` de `albus_agent`, un nivel más abajo.

Se pasa: las variables del sistema necesarias para que Node y npm funcionen
(`PATH`, `SystemRoot`, `USERPROFILE`, `APPDATA`, `TEMP`, …) más el contrato:

| Variable | Valor |
|---|---|
| `AGENT_ID` | el id |
| `AGENT_RUN_ID` | id de esta corrida |
| `AGENT_PROTOCOL` | `1` |
| `AGENT_RESULTS_DIR` | `results/<id>/`, creada antes de lanzar |
| `AGENT_RULES_PATH` | el `.md` de reglas del agente en la carpeta de Albus |
| `NO_COLOR`, `FORCE_COLOR=0` | para que la salida no venga con códigos ANSI |

Los secretos propios del agente los carga el agente (su `.env`), no Albus.

### La salida: JSON lines por stdout

Cada línea de stdout que sea un objeto JSON con un `type` conocido es un evento.
**Todo lo demás es log**: npm imprime banners, `console.log` existe. Un parser que
rechazara la línea rara rompería al primer agente real.

```jsonl
{"type":"progress","message":"Claude leyendo lote 2 de 5","percent":40}
{"type":"result","path":"resumenes/2026-10-04.json","message":"Resumen listo: 7 grupos"}
{"type":"question","question":"¿Cuento el grupo Familia?","context":"grupo nuevo","options":["sí","no"]}
{"type":"error","message":"No se pudo conectar"}
```

- Cada línea se valida **por separado** con zod. Una línea mala es un log, nunca
  aborta la corrida (validar por fila, no por lote).
- `type` desconocido → log. Así un agente con `protocol: 1` más nuevo no rompe a
  un Albus más viejo.
- `result.path` puede ser `null` ("no había nada nuevo"). Si viene, se resuelve
  contra `AGENT_RESULTS_DIR` y **tiene que quedar adentro**. Si no, se descarta el
  path y se avisa: un agente no puede hacer que Albus abra `C:\Windows\…`.
- `question` entra a la cola que ya existe (`agents/questions.ts`): la misma duda
  dos veces es una pregunta, y la respuesta se anexa al `.md` de reglas.
- stderr se junta como log, no como error. El veredicto es el código de salida.
- Líneas de más de 4000 caracteres se recortan; se guardan los últimos 500 eventos.

El estado final: `ok` (exit 0), `failed` (otro código, con el mensaje de
`exitCodes` si lo declara), `timeout` o `cancelled`. Al vencer el timeout o
cancelar se mata el **árbol** (`taskkill /T /F`): matar solo a `npm` deja vivo al
`node` hijo.

## Instalar (el marketplace mínimo)

`hub:install` recibe una fuente:

| Fuente | Qué hace |
|---|---|
| URL git (`https://`, `git@`, `ssh://`) | `git clone --depth 1` a una carpeta de staging |
| Carpeta local con `.git` | `git clone` desde la carpeta: **solo lo commiteado**. Sesiones, `.env` y datos privados (que están en `.gitignore`) no viajan |
| Carpeta local sin `.git` | copia, salteando `node_modules`, `.git`, `.next`, `.env*`, `dist`, `out` |
| Carpeta local con `link: true` | **junction** `agents/<id>` → la carpeta original. **No usar para los agentes del usuario** (ver abajo) |

**Regla del usuario (2026-10-04): todo agente vive físicamente en `agents-hub/agents/<id>/`.**
Un agente nuevo se crea ahí desde el primer commit, con su `.git`, su `.env` y su estado
local adentro (así vive `whatsapp-digest`). Nada de crear el código en `my_proyects/` e
instalarlo con `--link`: la junction deja el mismo agente en dos lugares, y el usuario ya no
sabe cuál es "el agente". Pasó con `mail-triage` y se corrigió moviéndolo. Para sacar una
junction: `rmdir <ruta>` **sin** `/s` — un borrado recursivo destruye la carpeta original.

Después: leer `agent.json` del staging (el id sale de ahí), mover a `agents/<id>`
(si ya existe, falla: no hay "actualizar" todavía), `npm ci` o `npm install` si
hay `package.json`, y `check` si está declarado. Cada paso se informa por
separado. Si falla el clon o la validación, se borra el staging. Si fallan las
dependencias o el check, el agente queda instalado y se pinta apagado con el
motivo.

**No hay desinstalar todavía, a propósito.** Borrar una junction con un
`rmSync({ recursive: true })` equivocado borra la carpeta ORIGINAL del agente. Va
cuando haya tiempo de probarlo con cuidado.

## En la pestaña de agentes

Los externos entran a la misma lista (`agents:list`) con `origin: 'external'` y
`screen: 'external'`: una pantalla genérica con ejecutar, cancelar, el progreso en
vivo, abrir la carpeta de resultados y los últimos resultados. Los internos no
cambian.

Un `agent.json` roto **se lista apagado con el motivo**, no desaparece: misma
regla que `agents.md` ("un agente que se esconde es un agente que el usuario cree
que nunca existió").

## Fase 5: la migración de los internos — CHOCA con una decisión documentada

El prompt pide extraer video, udemy y job-search a `agents/<id>/`. **No se hizo,
y no por falta de tiempo.**

| Agente | ¿Puede correr solo, sin Albus? | Por qué |
|---|---|---|
| `video-analysis` | **Sí** | ffmpeg + whisper son CLIs; `core/video/` ya es dominio puro |
| `job-search` | **No, tal como está** | usa el navegador de Electron (`BrowserPort` sobre `webContents`) y la partición `persist:albus-jobs`, donde vive tu sesión de LinkedIn y Google |
| `udemy` | **No, tal como está** | igual: la sesión de Udemy está en esa partición |

La norma 4 ("un agente debe poder correr solo") es incompatible con depender de
la sesión del navegador de Albus. Opciones:

1. **El agente trae su navegador** (Playwright con un perfil persistente propio en
   `results/<id>/.profile` o similar). Corre solo de verdad. Costo: loguearse de
   nuevo una vez por agente, y reescribir `browser/page.ts` contra Playwright.
2. **Albus ofrece el navegador como servicio** (expone CDP o una API local). Costo:
   el agente solo corre con Albus abierto, que es justo lo que la norma 4 quiere
   evitar.
3. **Se quedan internos** hasta decidir. Costo: dos clases de agentes por un
   tiempo.

Recomendación: **3 ahora, 1 después**, empezando por video (que no tiene el
problema). Y la migración de resultados `albus_agent/video` →
`results/video-analysis` va **en el mismo commit** que el agente de video externo,
nunca antes. Si se mueve la carpeta y el panel sigue leyendo `videoDir()`, la
biblioteca aparece vacía sin ningún error. Es el contrato congelado de `video/`,
`meta.json` y `transcript.srt` de `frozen-contracts.md`. Se copia entrada por
entrada con `copyMissing`, nunca se mueve.

## Reportes HTML

Cualquier agente puede escribir un `.html` en su carpeta de resultados (la
misma `results/<id>/` de siempre, sin convención de nombre ni de ubicación
adicional). Si lo hace, Albus lo muestra en la pantalla del agente, dentro de
un `<iframe sandbox="">` sin `allow-scripts`, sin `allow-same-origin` y sin
`allow-popups`: el HTML viene de un tercero y puede traer texto generado por
un modelo, así que Albus no le da ni ejecución de script ni origen propio ni
capacidad de abrir ventanas. Los links de adentro no navegan por eso mismo —
para eso queda el botón "open in browser", que abre el archivo con
`hub:open`/`target: 'file'`, el mismo camino que ya usaba cualquier otro
resultado.

El contrato es una línea: **un resultado con ruta `.html` es un reporte que
se puede ver.** No hay que declarar nada en `agent.json` ni avisarle a Albus
de ninguna otra forma — es el mismo principio que el resto del hub: el agente
dueño de su presentación, Albus genérico. El canal que lee el archivo es
`hub:read-report` (`{agentId, relPath}` → `{relPath, html, modifiedAt}`),
separado de `hub:open`: ese le pide al sistema operativo que abra un path,
este le entrega los bytes al renderer para pintarlos. Mismas reglas de
seguridad que el resto del hub — `relPath` se resuelve con
`resolveInsideResults` y se rechaza si se escapa de `results/<id>/` — más un
límite de 2 MB: un reporte se lee entero a memoria antes de mandarlo por
IPC, y eso lo mantiene barato.

## Lo que NO cambió y conviene saber

- El provider `claude-code.ts` sigue sin aislar el contexto. La sesión de WhatsApp
  midió ~227k tokens contra ~1,3k con `--setting-sources "" --strict-mcp-config
  --tools ""`. Pidió que se le consultara antes de tocarlo. Ver
  `my_proyects/whatsapp/docs/albus-whatsapp-agent-prompt.md`.
- No hay vista específica del resumen de WhatsApp dentro de Albus. La pantalla es
  genérica a propósito: una vista por agente es volver a "hay que compilar Albus
  para sumar un agente".
