# Agentes proveedores: un agente por servicio externo

> Decidido con el usuario el 2026-10-06. Su lema: **responsabilidad única**. Un
> agente para Google, uno para Notion, uno para WhatsApp. Ningún otro agente
> tiene un token, un cliente OAuth ni un cliente de esas APIs.

## El problema que resuelve

Hasta el 2026-10-06 cada agente traía su propio acceso: 4 implementaciones de
Google OAuth (mail-triage, outreach, whatsapp-digest, Albus), 4 clientes de
Notion con el mismo `NOTION_TOKEN` copiado, y `whatsapp-digest` mezclando la
sesión de WhatsApp con resúmenes, Calendar, Drive y Notion. El TUI pedía las
mismas claves agente por agente.

## Los tres proveedores

| id | Responsabilidad | Credencial (vive SOLO acá) | Servicios |
|---|---|---|---|
| `google` | todo HTTP contra Google de la cuenta **personal** | 1 OAuth client + 1 token por grupo de scopes en `.secrets/<grupo>.json` | `fetch`, `drive.upload`, `drive.doc`, `calendar.create` |
| `notion` | todo HTTP contra el Notion **personal** | `NOTION_TOKEN` en su `.env` | `fetch` |
| `whatsapp` | la sesión Baileys del WhatsApp **personal** | `.wa-data/auth/` | `status`, `sync`, `groups`, `messages`, `send` |

La cuenta de Google de **30X** no pasa por `google`: `gemini-notes` la alcanza
con los conectores de claude.ai, sin tokens propios.

### Grupos de scopes de Google (mínimo privilegio)

| Grupo | Scopes | Quién lo tiene hoy |
|---|---|---|
| `gmail-read` | `gmail.readonly` | mail-triage |
| `gmail-send` | `gmail.send` | outreach |
| `workspace` | `drive.file`, `calendar.events` | nadie todavía (lo usará Albus) |

Un token por grupo, **el mismo OAuth client**. Por qué no un solo token con todo:
`mail-triage` lee correo escrito por cualquiera; si su token pudiera enviar, un
correo con instrucciones maliciosas tendría a quién pedírselo. Con grupos, el
límite lo pone **Google**, no nuestro código: el token de `gmail-read` no puede
enviar aunque el proxy se lo pida.

## El contrato de llamada (protocolo 1)

Un consumidor llama a un proveedor así, sin Albus abierto y sin npm de por medio:

```
spawn(process.execPath, ['scripts/call.ts'], {
  cwd: <hub>/agents/<proveedor>, shell: false, env: <allowlist>, stdio: pipe })
stdin  ← {"protocol":1,"caller":"mail-triage","service":"fetch","input":{…}}
stdout → última línea no vacía = sobre JSON
```

- `<hub>` = `ALBUS_AGENTS_HUB_DIR` recortada, si no `~/Documents/agents-hub`.
- **env = allowlist**, igual que el runner del hub: `PATH`, `PATHEXT`,
  `SystemRoot`, `SystemDrive`, `windir`, `COMSPEC`, `USERPROFILE`, `HOME`,
  `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `USERNAME`, `ALBUS_AGENTS_HUB_DIR`,
  más `AGENT_CALLER=<id>`. Los secretos del consumidor nunca llegan al proveedor,
  y los del proveedor nunca salen de él.
- **Sobre de respuesta** (mismo que el IPC de Albus):
  `{"ok":true,"data":…}` | `{"ok":false,"error":{"code":"…","message":"…"}}`.
  Los logs del proveedor van por **stderr**; stdout es solo el sobre.
- **Códigos de error**: `not_granted`, `unknown_service`, `bad_input`,
  `needs_setup` (falta token/sesión: el consumidor sale con exit 2, "corre
  `npm run setup`"), `upstream` (la API contestó mal; `message` trae el status),
  `internal`.
- Sin sobre en stdout (crash, timeout) = `internal`. Timeout lo pone el
  consumidor (default 120 s; `whatsapp:sync` necesita ~200 s) y mata el árbol.
- El **proveedor** valida el pedido con zod y chequea `grants[caller]` antes de
  tocar la red. `caller` es declarativo — el modelo de amenaza es un LLM
  dentro de un agente siguiendo texto ajeno, no código hostil instalado; contra
  eso protege que el consumidor no TENGA el token.

`fetch` es un proxy: `{group?, method, url|path, headers?, body?, bodyBase64?,
multipart?}` → `{status, headers, body | bodyBase64}`. El proveedor agrega el
`Authorization` y valida el host (`*.googleapis.com` / `api.notion.com`). La
ventaja: el consumidor conserva su código (`@notionhq/client` acepta un `fetch`
propio; los wrappers de Gmail ya reciben `fetchFn`) y solo cambia **quién**
hace el request.

### El cliente: una sola copia en `shared/`

Hasta que el hub pasó a ser un monorepo (2026-10-06) `agent-call.ts` se copiaba
a mano en cada consumidor — una por `notion`, otra por `outreach`, otra por
`whatsapp-digest`, etc. Ya no hace falta: con todos los agentes en el mismo
repo, la copia vive UNA sola vez en `agents-hub/shared/` —
`shared/agent-call.ts` y `shared/notion-agent-fetch.ts` (el `fetch` que se le
pasa a `new Client({ fetch })` de `@notionhq/client`), cada uno con su
`shared/agent-call.test.ts` / `shared/notion-agent-fetch.test.ts` al lado,
corridos con `node --test shared/*.test.ts` desde la raíz del hub.
`shared/package.json` es nada más `{"private": true, "type": "module"}`: existe
solo para que `tsc` (modo `nodenext`) trate la carpeta como ESM, no para armar
un workspace de npm — no hay `workspaces` en el `package.json` raíz del hub, cada
agente sigue instalando sus propias dependencias por separado.

Cada consumidor importa por ruta relativa, sin ningún paso de build ni paquete
publicado: `import { callAgent } from '../../../../shared/agent-call.ts'` (la
cantidad de `../` depende de la profundidad del archivo que importa dentro de
`agents/<id>/`). El contrato sigue versionado por `protocol`, igual que antes —
lo que cambió es dónde vive el archivo, no el contrato en sí.

## `agent.json`: tres campos nuevos (opcionales, protocolo sigue en 1)

```json
"provides": ["fetch", "drive.upload"],
"grants":   { "mail-triage": ["gmail-read"], "outreach": ["gmail-send"] },
"uses":     ["google:gmail-read", "notion:fetch"]
```

| Campo | Regla |
|---|---|
| `provides` | servicios que expone `scripts/call.ts`. No vacío ⇒ es proveedor |
| `grants` | `{ <caller id>: [<servicio o grupo>] }`. `"*"` = todos los servicios |
| `uses` | `<proveedor>:<servicio o grupo>`. Lo lee el TUI y `hub:check` |

`npm run hub:check` avisa (WARN) si un `uses` apunta a un proveedor que no está
instalado o que no le da ese grant.

## En el TUI

Home tiene dos bloques: **Connections** (los proveedores: ahí se cargan el OAuth
client de Google, se autoriza cada grupo, el token de Notion y se vincula
WhatsApp) y **Agents** (los consumidores). Un consumidor ya no pide claves de
Google/Notion: muestra `needs google (gmail-read)` hasta que la conexión esté
lista.

## Lo que NO viaja entre máquinas

`google/.secrets/`, `notion/.env`, `whatsapp/.wa-data/`. Y la sesión de WhatsApp
vive en UNA sola máquina (dos Baileys se pelean el socket).

## Excepción deliberada: el proveedor de correo del VPS

> Decidido con el usuario el 2026-10-06. El VPS es OTRA máquina y tiene que
> leer y enviar correo 24/7 con el PC apagado: no puede llamar a `google`.

En el VPS el único dueño de Gmail es el servidor MCP `gmail` del agente
`hermes-vps` (`hermes/mcp/gmail/`, corre en el host, fuera del Docker de
Hermes). Responsabilidad única allá también: nada más en el VPS tiene un token
de Google.

| | |
|---|---|
| Tokens | `~/.albus-secrets/gmail-read.json` (`gmail.readonly`) y `gmail-send.json` (`gmail.send`): dos refresh tokens, mismos grupos que `google`, **el mismo OAuth client** (se lee del `.env` de `google` en el PC) |
| Quién los crea | el usuario, con `npm run gmail:vps-auth` en `hermes-vps` (o el TUI). Viajan por stdin de ssh, nunca en una línea de comando |
| Herramientas | `search_emails`, `read_email`, `request_send`, `confirm_send` |
| Enviar | `request_send` guarda el borrador en el host y manda al usuario por WhatsApp el texto + un código de 4 dígitos **como imagen**; solo `confirm_send` con ese código envía. `hermes send` copia el TEXTO de cada mensaje a la conversación del modelo, por eso el código nunca va en texto |
| Lo que NO se monta en el sandbox | `~/.albus-secrets/` y `~/.albus-mail/` (borradores con su código). Si se montan, el modelo lee el código y la aprobación deja de existir |

No es un segundo proveedor en el PC: nada del PC llama a ese MCP. Los datos del
PC llegan al VPS con `hermes-vps/scripts/publish.ts` (→
`~/albus-bridge/data/<agente>/latest.json`); `mail-triage` publica ahí su
clasificación después de cada triage.

## Fuera de alcance (todavía)

- Albus (Electron) mantiene su propio Google/Notion (`src/main/connections/`,
  `src/main/notion/`): es la app interna de job-search. Migrarlo a los
  proveedores es la siguiente fase.
- `hermes-vps` usa Notion por MCP en el VPS, otra máquina. No llama a `notion`.
  Gmail en el VPS: ver la excepción de arriba.
