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

## Dónde vive el hub: lo elige el usuario, copiar nunca mover

El primer paso de `npm run setup` en una máquina nueva es elegir la carpeta
**padre**; el hub queda en `<esa carpeta>\agents-hub` (`hubDirFromParent()`,
`core/hub/hub-location.ts`) — salvo que la carpeta elegida ya termine en
`agents-hub`, en cuyo caso se usa tal cual, para no anidar un segundo
`agents-hub` adentro.

La elección se guarda en la variable de entorno **de usuario**
`ALBUS_AGENTS_HUB_DIR` (`setx`, sin admin). `resolveHubDir()` la lee (recortada
— un valor solo de espacios cae al default) y por default cae a
`Documents\agents-hub`. Es de usuario y no de una app para que la lean todos
los procesos por igual: Albus, `scripts/agents.ps1`, Orca y cada agente
corriendo solo. `setx` no afecta a una terminal ya abierta: el TUI lo avisa al
terminar.

**El programador de tareas de Windows es la excepción — NO sigue la
variable.** Una tarea programada no relee `ALBUS_AGENTS_HUB_DIR` en cada
disparo: su acción (`Task To Run`) es una línea de comando literal, grabada
tal cual al crear la tarea con `schtasks /create` (por ejemplo, el
`run-hidden.vbs` que dispara utel-study). Mover el hub nunca toca esa línea:
la tarea sigue apuntando a la carpeta VIEJA y, en cuanto el usuario la borra,
falla.

Cambiar la ubicación con un hub que ya existe **copia, nunca mueve**: el TUI
copia la carpeta entera (`.env`, `.secrets\`, resultados y trabajo sin
commitear — nada de eso está en GitHub), verifica que cada agente quedó
completo en el destino, recién entonces cambia la variable, y deja la carpeta
vieja intacta para borrarla a mano cuando todo funcione. Antes de borrarla: el
TUI corre una búsqueda de solo lectura (`findScheduledTasksUsing`, vía
`schtasks /query /fo csv /v`) y lista en la pantalla final cualquier tarea
programada cuya acción todavía mencione la ruta vieja, para volver a
registrarla a mano. Lo mismo vale para cualquier automatización de Orca que
apunte a la carpeta vieja: ni el TUI ni nada en el proyecto la detecta
automáticamente, así que es trabajo manual del usuario revisarlas antes de
borrar la carpeta.

**El guardia del literal:** todo lo que antes tenía `Documents\agents-hub`
escrito a mano pasa a leer la variable primero, con el mismo orden en cada
agente: `AGENT_RESULTS_DIR` (lo pasa Albus) → `ALBUS_AGENTS_HUB_DIR\results\<id>`
→ `Documents\agents-hub\results\<id>` (el default, para una máquina sin la
variable). Si un agente se olvida, sigue escribiendo en la carpeta vieja **sin
error** — por eso `npm run hub:check` corre `findHardcodedHubPaths()` sobre el
hub real e imprime **WARN, nunca FALLA**, por cada archivo que todavía
hardcodea la ruta literal en vez de leer `ALBUS_AGENTS_HUB_DIR`.

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

### El campo `setup`: lo que guía a `npm run setup`

Opcional, default `{}` — un manifiesto sin el campo sigue siendo válido, misma
regla que `runLabel` y `hidden`. Se valida en el mismo `manifest.ts`
(`SetupSchema`), el único lugar donde se valida un `agent.json`: el TUI
(`src/tui/`) importa ese schema, no tiene una copia propia.

```json
"setup": {
  "tools": ["ffmpeg", "whisper", "claude"],
  "env": [
    { "key": "NOTION_TOKEN", "label": "Notion integration token",
      "help": "notion.so/my-integrations → tu integración → Secret",
      "secret": true, "optional": false }
  ],
  "envFile": ".env",
  "auth": [
    { "label": "Gmail personal (read-only)", "command": "auth",
      "doneWhen": ".secrets/gmail-token.json" }
  ]
}
```

| Campo | Regla | Por qué |
|---|---|---|
| `tools` | nombres de binario, `^[a-z0-9._-]+$` | se buscan con `where`, igual que cualquier CLI del proyecto. De las conocidas (`KNOWN_TOOLS` en `setup-io.ts`), solo `git`, `node`, `gh` y `ffmpeg` traen un instalador automático (`winget install`, un clic desde el TUI); `whisper`, `claude` y `pdftotext` también son conocidas pero sin instalador automático — el TUI solo muestra la pista para correrlo a mano (`pip install -U openai-whisper`, `npm install -g @anthropic-ai/claude-code`, `winget install oschwartz10612.Poppler`, respectivamente); una desconocida se reporta sin ofrecer instalar nada |
| `env[].key` | `^[A-Z][A-Z0-9_]*$` | es un nombre de variable; cualquier otra cosa rompería el archivo |
| `env[].secret` | default `true` | se pide enmascarado y **nunca** se imprime, ni en logs ni en errores |
| `envFile` | `.env` (default) o `.env.local` | se resuelve dentro de la carpeta del agente; un `../` se rechaza |
| `auth[].command` | nombre de una entrada de `commands`, nunca un comando nuevo | pasa por la allowlist que ya existe (`command.ts`): un `agent.json` sigue sin poder tocar un shell. `parseAgentJson` rechaza el manifiesto si el nombre no está declarado en `commands` |
| `auth[].doneWhen` | ruta relativa dentro de la carpeta del agente | si el archivo existe, el permiso está dado; sin esto el TUI no sabría si el OAuth se completó |

La validación de cada clave **no** se declara: al terminar, el TUI corre el
`commands.check` del agente (que ya existe para eso) y muestra su veredicto.

`setup.json`, en la **raíz de `albus_agent`** (no en el hub), declara las
claves de Albus mismo con el mismo schema — `SUPABASE_*`, `GOOGLE_*`,
`NOTION_*` — para que el TUI lo muestre como una fila más, junto a los
agentes del hub.

`whatsapp-digest` todavía no declara `setup` (sesión concurrente con trabajo
sin commitear cuando se escribió esto): aparece en el TUI como "nada que
configurar", no como roto, hasta que se le agregue.

### Agentes proveedores: `provides` / `grants` / `uses`

Tres campos opcionales más de `agent.json`, sumados el 2026-10-06 para que
Google, Notion y WhatsApp vivan en **un** agente proveedor cada uno en vez de
que cada consumidor traiga su propio token. El contrato completo — el
protocolo de llamada entre agentes, los tres proveedores, los grupos de
scopes de Google — está en `.claude/docs/agent-services.md`; acá va solo la
forma del campo, igual que el resto de esta tabla.

| Campo | Regla | Por qué |
|---|---|---|
| `provides` | `string[]`, default `[]`. Cada entrada matchea `^[a-z0-9.*-]+$` | los servicios que expone `scripts/call.ts` de ESTE agente (p. ej. `["fetch", "drive.upload"]`). No vacío ⇒ el TUI lo agrupa en **Connections**, no en **Agents** |
| `grants` | `{ <caller id>: [<servicio o grupo>, ...] }`, default `{}`. La clave matchea el patrón de `id` de agente; cada entrada del array matchea `^[a-z0-9.*-]+$` | el allowlist del PROVEEDOR: a quién le presta qué. `"*"` en el array = todos los servicios. Un caller no listado se queda sin nada — `grants` nunca es un pedido del consumidor, es la decisión del dueño del proveedor |
| `uses` | `string[]`, default `[]`. Cada entrada matchea `^[a-z0-9][a-z0-9-]{1,48}:[a-z0-9.*-]+$` (`<proveedor>:<servicio o grupo>`) | lo que ESTE agente llama en otros, p. ej. `["google:gmail-read", "notion:fetch"]`. `core/hub/services.ts#resolveServices` (puro) lo resuelve contra el `provides`/`grants` de todos los manifiestos; `npm run hub:check` imprime un WARN (nunca FALLA) por cada entrada sin resolver, y el TUI usa la misma función para pintar `needs <proveedor> (<servicio>)` en Home y los ✔/✘ de la pantalla del agente |

Un manifiesto viejo sin estos tres campos sigue siendo válido — quedan en sus
defaults vacíos, mismo patrón que `runLabel`/`hidden`/`setup`.

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
| URL git (`https://`, `git@`, `ssh://`) | `git clone --depth 1` a una carpeta de staging, se mueve a `agents/<id>` y se le borra el `.git` propio (ver nota abajo) |
| Carpeta local con `.git` | `git clone` desde la carpeta: **solo lo commiteado**. Sesiones, `.env` y datos privados (que están en `.gitignore`) no viajan. Mismo borrado de `.git` al final |
| Carpeta local sin `.git` | copia, salteando `node_modules`, `.git`, `.next`, `.env*`, `dist`, `out` |
| Carpeta local con `link: true` | **junction** `agents/<id>` → la carpeta original. **No usar para los agentes del usuario** (ver abajo) |

**El hub entero es un repo git desde el 2026-10-06 (ver "Dos máquinas" más abajo),
así que un `.git` propio adentro de `agents/<id>/` sería un repo anidado dentro del
monorepo.** Por eso, para las dos fuentes que clonan, `installAgent` borra ese
`.git` después de mover la carpeta a su lugar final — lo único que se pierde es
poder hacer `git log` del historial de origen desde adentro del hub; el código ya
viajó entero (solo lo commiteado) antes del borrado. Un agente instalado con
`link: true` no se toca: es una junction a una carpeta externa, no vive físicamente
en el hub.

**Regla del usuario (vigente desde el 2026-10-04, hub monorepo desde el 2026-10-06):
todo agente vive FÍSICAMENTE en `agents-hub/agents/<id>/`, commiteado en el
monorepo.** Un agente nuevo se crea ahí desde el primer commit — con `"draft": true`
en su `agent.json` hasta que Jorge lo publique, ver "Backup vs. publicar" más abajo
— y ESE commit se empuja enseguida: no hace falta que funcione todavía, el push ya
es el backup. Nada de crear el código en `my_proyects/` e instalarlo con `--link`:
la junction deja el mismo agente en dos lugares, y el usuario ya no sabe cuál es "el
agente". Pasó con `mail-triage` y se corrigió moviéndolo. Para sacar una junction:
`rmdir <ruta>` **sin** `/s` — un borrado recursivo destruye la carpeta original.

Después: leer `agent.json` del staging (el id sale de ahí), mover a `agents/<id>`
(si ya existe, falla: no hay "actualizar" todavía), `npm ci` o `npm install` si
hay `package.json`, y `check` si está declarado. Cada paso se informa por
separado. Si falla el clon o la validación, se borra el staging. Si fallan las
dependencias o el check, el agente queda instalado y se pinta apagado con el
motivo.

**No hay desinstalar todavía, a propósito.** Borrar una junction con un
`rmSync({ recursive: true })` equivocado borra la carpeta ORIGINAL del agente. Va
cuando haya tiempo de probarlo con cuidado.

## Dos máquinas: GitHub es el puente (2026-10-06 — monorepo)

> Reemplaza el diseño "un repo por agente + topic `albus-agent`" del 2026-10-05.
> Esos 12 repos viejos se están archivando en GitHub — nada en el proyecto ni
> en la cabeza de Claude debería volver a buscarlos por topic.

El usuario trabaja en el desktop y en una laptop. Desde el 2026-10-06 el hub entero
(`Documents/agents-hub`, o `ALBUS_AGENTS_HUB_DIR`) es **UN solo repo git**, privado,
`https://github.com/JDavidcor23/agents-hub`, rama `main`. Cada agente es una carpeta
plana `agents/<id>/` COMMITEADA ahí — ya no tiene su propio `.git`, ni se le pone el
topic `albus-agent`: el repo entero reemplaza esa marca. El `.gitignore` de la raíz
excluye `results/`, `node_modules`, `.env*`, `.secrets/` y `.wa-data/` para todo el
árbol de una sola vez, en vez de que cada agente repita su propio `.gitignore`.

`scripts/agents.ps1` (Windows PowerShell 5.1, ASCII) opera sobre ESE repo único —
ya no lista nada por topic. Una vez instalado (`install` agrega funciones al
`$PROFILE`): `clone-agents`, `update-agents`, `sync-agents`, `agents-status`.

| Comando | Qué hace ahora |
|---|---|
| `clone` | hub ausente o vacío → clona el monorepo. Hub con contenido pero SIN `.git` (el layout viejo, p. ej. una laptop que no se tocó desde antes del 2026-10-06) → lo archiva a `<hub>-old-<yyyyMMdd-HHmm>` (nunca lo borra), clona el monorepo fresco y copia de vuelta, por cada agente presente en ambas copias, SOLO lo local y gitignored: `.env`, `.env.local`, `.secrets\`, `.wa-data\`, más el árbol `results\` completo. Hub ya con `.git` → lo avisa y hace `update` |
| `update` | `git pull --ff-only`. Diverge (commits locales Y remotos) → lo reporta y no toca nada. Falla el `pull` por un archivo sin commitear que el merge pisaría → reporta ESE archivo, nunca resetea. Después de un pull que sí avanzó: corre `npm install`/`npm ci` en cada agente cuyo `package.json`/`package-lock.json` cambió entre el HEAD viejo y el nuevo, o que tiene `package.json` pero nunca tuvo `node_modules` |
| `sync` | `clone`-o-`update`, lo que aplique |
| `status` | una línea del repo (rama, ahead/behind de `origin` después de un fetch, archivos sin commitear) + una línea por agente (archivos sin commitear, y `[draft]` si su `agent.json` tiene `draft: true`). **Ya no existe el concepto `[local only]`**: un agente o está en el commit del monorepo o no está, no hay "instalado pero sin subir a un repo propio" |

### Backup vs. publicar — el flag `draft`

Un agente nuevo nace con `"draft": true` en su `agent.json` desde el PRIMER commit,
y ese commit se empuja al monorepo sin pedir permiso — **ese push ES su backup**.
Nada obliga a que esté terminado para vivir ahí: lo que antes era "¿lo subo ya o
espero a que funcione?" ahora es "subilo siempre; marcalo `draft` hasta que esté
listo". Jorge decide cuándo deja de ser borrador — corre el `check` del agente en
verde y borra esa línea de `agent.json` — nunca Claude por su cuenta.

Mientras `draft: true`:

- **Invisible en la app Albus**: `hub/agent-info.ts` lo filtra del `agents:list` que
  ve el renderer, igual que `hidden`, pero por un motivo distinto — `hidden` es un
  opt-out permanente del dueño, `draft` es "todavía no publicado".
- **Sigue andando para desarrollo**: `npm run hub -- list` lo imprime marcado
  `(draft)`, `npm run hub -- run <id>` lo corre igual, `scripts/agents.ps1 status`
  lo marca `[draft]`.
- **Visible en el TUI**, pero aparte: `npm run setup` (Home) lo agrupa en un tercer
  bloque atenuado, "Drafts (not published)", después de Connections y Agents — ni
  mezclado con los agentes reales ni oculto del todo, porque esta pantalla es para
  Jorge, no para el usuario final de Albus.

Ver `src/main/core/hub/manifest.ts` (el campo) y `src/main/hub/agent-info.ts` (el filtro).

### Lo que cambió, lo que no

- **Los 12 repos viejos (topic `albus-agent`) se están archivando en GitHub.** No
  hay que volver a listarlos por topic ni asumir que un agente sigue teniendo su
  propio remoto — el monorepo es la única fuente.
- **Backup local de esos `.git` viejos:** `Documents\agents-hub-git-backup\<id>.git`
  guarda una copia de cada repo per-agente tal como estaba antes de la migración
  (incluido `mail-triage.kilo`, un worktree viejo de una herramienta, no un agente).
  Es solo un respaldo manual — nada del proyecto lo lee ni escribe ahí.
- **Nunca pisa trabajo:** con cambios sin commitear que un `pull --ff-only` pisaría,
  o con commits divergentes, el script lo reporta y no toca nada. Nunca `reset`.
- **`gh` tiene la cuenta de 30X como activa en el desktop.** El script mete el token de
  `JDavidcor23` en `GH_TOKEN` solo durante la corrida y lo restaura — y eso alcanza
  para autenticar también el `git clone`/`git pull` planos, porque `gh auth
  setup-git` registra a `gh` como credential helper y ese helper mira `GH_TOKEN`
  igual que `gh auth token`. Un `git push` a mano necesita lo mismo:
  `export GH_TOKEN=$(gh auth token -u JDavidcor23)`.
- **Lo que NO viaja (sigue igual):** `.env`, `.env.local`, `.secrets/`, `.wa-data/`.
  Se copian a mano y por USB, o las carga el `clone` de una migración vieja (ver la
  tabla de arriba). La sesión de WhatsApp y las tareas programadas viven en UNA sola
  máquina: dos vigilantes de Baileys se pelean la conexión, y dos triages duplican
  filas en Notion.
- **La llave SSH de hermes-vps no se copia:** cada máquina genera la suya y se autoriza
  en el VPS. Perder la laptop significa borrar una línea de `authorized_keys`.
- **`hub install <url>` de un agente de terceros** todavía clona ese repo con SU
  propio `.git` dentro de `agents/<id>/` — un repo anidado dentro del monorepo. Ver
  "Instalar" más abajo para cómo se resuelve.

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
