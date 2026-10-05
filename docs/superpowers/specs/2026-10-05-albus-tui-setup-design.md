# Albus TUI — setup de una máquina, y Albus como casa de Claude

> 2026-10-05. Obra 1 de una mudanza mayor (ver "El mapa" al final).

## Qué cambia en una frase

El usuario deja de usar la ventana de Albus. **Configura una máquina con un TUI**
(flechas y Enter, una vez por máquina) y **opera sus agentes hablándole a Claude
dentro de la carpeta de Albus** (`cd albus_agent; claude`). La app Electron NO se
toca en esta obra: sigue funcionando hasta que cada agente interno se mude.

## Las dos puertas

| Puerta | Quién | Para qué |
|---|---|---|
| `npm run setup` (TUI, Ink) | el usuario | herramientas que faltan, claves de cada agente, permisos de Google, `check` de cada agente. Lo humano: pegar un secreto y apretar "Permitir" |
| `claude` en la carpeta de Albus | Claude | todo lo demás: correr, actualizar, revisar estado, crear agentes. Aprende cómo leyendo el `CLAUDE.md` reescrito y usando `npm run hub` + `scripts/agents.ps1` |

Claude no maneja el TUI (espera teclas). El usuario no maneja los comandos (se los pide a Claude).

## El contrato: campo nuevo `setup` en `agent.json`

Opcional y con default `{}`: un manifiesto sin el campo sigue siendo válido (misma regla
que `runLabel` y `hidden`). Va en `core/hub/manifest.ts`, el **único** lugar donde se
valida un `agent.json`. El TUI importa ese schema: no hay una segunda copia.

```json
"setup": {
  "tools": ["ffmpeg", "whisper", "claude"],
  "env": [
    {
      "key": "NOTION_TOKEN",
      "label": "Notion integration token",
      "help": "notion.so/my-integrations → your integration → Secret",
      "secret": true,
      "optional": false
    }
  ],
  "envFile": ".env",
  "auth": [
    {
      "label": "Gmail personal (read-only)",
      "command": "auth",
      "doneWhen": ".secrets/gmail-token.json"
    }
  ]
}
```

| Campo | Regla | Por qué |
|---|---|---|
| `tools` | nombres de binario, `^[a-z0-9._-]+$` | se buscan con `where`, igual que todo CLI del proyecto. Los conocidos (`git`, `node`, `gh`, `ffmpeg`, `whisper`, `claude`) traen su comando de instalación; los desconocidos se reportan sin ofrecer instalar nada |
| `env[].key` | `^[A-Z][A-Z0-9_]*$` | es un nombre de variable; cualquier otra cosa rompería el archivo |
| `env[].secret` | default `true` | se pide enmascarado y **nunca** se imprime, ni en logs ni en errores |
| `envFile` | `.env` (default) o `.env.local` | whatsapp-digest usa `.env.local` (Next.js). Se resuelve dentro de la carpeta del agente; un `../` se rechaza |
| `auth[].command` | **nombre de una entrada de `commands`**, nunca un comando nuevo | así pasa por la allowlist que ya existe (`core/hub/command.ts`): un `agent.json` sigue sin poder tocar un shell |
| `auth[].doneWhen` | ruta relativa dentro de la carpeta del agente | si el archivo existe, el permiso está dado (✔). Sin esto el TUI no sabría si el OAuth se completó |

La validación de cada clave **no** se declara: al terminar, el TUI corre el
`commands.check` del agente (que ya existe para eso) y muestra su veredicto. YAGNI.

## Qué hace el TUI

```
Albus setup
  Hub                  C:\Users\PC\Documents\web\agents-hub   → [Enter] cambiar
  Esta máquina         ✔ git ✔ node ✔ gh ✘ ffmpeg   → [Enter] instalar
  Albus (la app)       ✔ 5/5 claves
  mail-triage          ✘ falta NOTION_TOKEN · ✔ Gmail
  meeting-notes        ✘ falta permiso Google 30X
  whatsapp-digest      ✔ listo
  [s] sincronizar agentes desde GitHub   [q] salir
```

1. **Pantalla principal:** una fila por agente con su estado (claves completas, permisos
   dados, último `check`). Los agentes salen de `listExternalAgents` (`hub/discover.ts`);
   un `agent.json` roto aparece con su motivo, nunca desaparece.
2. **Detalle de un agente:** pide cada clave que falta, de a una, enmascarada, con su
   `help`. **Una clave con el mismo nombre que ya existe en otro agente** se ofrece para
   reusar ("NOTION_TOKEN ya está en mail-triage: ¿usar la misma? S/n"), con default sí y
   sin mostrar el valor.
3. **Permisos:** corre `commands.<auth>` del agente con la terminal **heredada**
   (`stdio: 'inherit'`: el script de OAuth abre el navegador e imprime lo suyo) y después
   mira `doneWhen`.
4. **Herramientas:** `winget install <id>` para las conocidas, con confirmación.
5. **Sincronizar:** corre `scripts/agents.ps1 sync` y muestra su salida.
6. **Albus mismo** aparece como una fila más mientras exista la app: sus claves
   (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_*`, `NOTION_*`) se declaran en
   `setup.json`, en la raíz del repo, con el mismo schema que `agent.json#setup`.

### Dónde vive el hub: lo elige el usuario

El primer paso del TUI en una máquina nueva: **"¿En qué carpeta guardo tus agentes?"**,
con `Documents` como default. El usuario da una carpeta padre (p. ej.
`C:\Users\PC\Documents\web`) y el hub queda en **`<esa carpeta>\agents-hub\`**:

- **El nombre `agents-hub` no cambia**, y tampoco `agents\` ni `results\` adentro. Son
  valores congelados (`frozen-contracts.md`), y meter `agents\` y `results\` sueltos en
  `web\` los mezclaría con otros proyectos.
- **La elección se guarda en UNA variable de entorno de usuario de Windows,
  `ALBUS_AGENTS_HUB_DIR`** (`setx`, sin admin). Ya es la llave que respeta
  `agentsHubDir()` en `paths.ts`. Al ser de usuario y no de una app, la ven **todos**: Albus,
  `agents.ps1`, Orca, el programador de tareas y cada agente corriendo solo. Un archivo de
  config en una ruta fija obligaría a cada uno de esos a saber leerlo.
- **Todo lo que hoy tiene `Documents\agents-hub` escrito a mano pasa a leer la variable
  primero.** Hoy son: `scripts/agents.ps1`, `mail-triage/src/shared/config.ts`,
  `utel-study/src/shared/config.ts`, `utel-study/scripts/run-hidden.vbs` y
  `whatsapp-digest/src/features/self-inbox/code-roots.ts`. El orden en cada agente queda
  así: `AGENT_RESULTS_DIR` (lo pasa Albus) → `ALBUS_AGENTS_HUB_DIR\results\<id>` →
  `Documents\agents-hub\results\<id>` (el default de siempre, para una máquina sin la
  variable). Si uno se olvida, sigue escribiendo en la carpeta vieja **sin error**: por eso
  `hub:check` lo verifica buscando la ruta literal en los agentes instalados.
- **Cambiar la ubicación con un hub que ya existe = COPIAR, nunca mover.** El TUI copia la
  carpeta entera (`robocopy /E`, que trae `.env`, `.secrets\`, resultados y trabajo sin
  commitear: nada de eso está en GitHub), verifica que cada agente esté completo en el
  destino, recién entonces cambia la variable, y **deja la carpeta vieja intacta**,
  avisando que se puede borrar a mano cuando todo funcione. Una tarea programada o una
  automatización de Orca con la ruta vieja escrita adentro se lista como advertencia.
- `setx` no afecta a las terminales ya abiertas: el TUI lo dice al terminar ("abre una
  terminal nueva").

### Escribir un `.env` sin romperlo

- Se actualiza la línea de esa clave en el lugar donde está; si no existe, se agrega al
  final. Comentarios, orden y claves ajenas quedan intactos.
- Escritura atómica: archivo temporal + rename. Un corte a mitad no deja un `.env` vacío.
- Los valores con espacios, `#` o comillas se escriben entre comillas dobles, escapadas.
- El `.env` de un agente queda **en la carpeta del agente**, como hoy: el agente sigue
  corriendo solo (Orca, programador de tareas) sin Albus. Es la opción A acordada; una
  bóveda cifrada central sería la B, y queda fuera.

## Dónde vive el código

```
src/tui/                 Ink + React. NO importa electron ni src/main/** salvo core/
  index.tsx              entrada: npm run setup
  screens/               Home, AgentDetail, Tools
src/main/core/hub/
  manifest.ts            + SetupSchema (el único lugar del contrato)
  setup-status.ts        PURO: dado un manifest + lo que hay en disco → qué falta
  dotenv.ts              PURO: parse/update de un .env preservando el resto
src/main/hub/
  setup-io.ts            lee/escribe .env, `where`, corre auth y check (adaptador)
setup.json               las claves de Albus mismo
```

`core/` sigue sin importar electron: es justamente lo que permite que el TUI lo use.

## Albus como casa de Claude

El `CLAUDE.md` de la raíz suma una sección corta, **arriba de todo**, "Operar tus agentes".
Su contenido: cuando el usuario pide algo de un agente (correr, estado, actualizar, ver
el último resultado), qué comando usar (`npm run hub -- list|run`, `scripts/agents.ps1
status|update`), dónde están los resultados (`agents-hub/results/<id>/`) y que el
setup lo hace el usuario en el TUI, no Claude. El resto del `CLAUDE.md` (cómo se programa
Albus) queda igual hasta que la app se retire.

## Verificación

- `npm run hub:check` se extiende: manifiestos con y sin `setup`, `envFile` con `../`
  rechazado, `auth.command` que no existe en `commands` rechazado.
- `dotenv.ts`: actualizar una clave preserva comentarios y claves ajenas; valor con `#`
  sale entre comillas; nunca aparece un valor en un mensaje de error.
- `setup-status.ts`: un agente sin `setup` aparece "nada que configurar", no "roto".
- `npm run typecheck`, el gate de siempre.
- A mano, en la laptop: máquina limpia → `npm run setup` → los cinco agentes en ✔.

## Fuera de esta obra

- Mudar los agentes internos y retirar la ventana (obras siguientes, ver abajo).
- Bóveda cifrada de secretos.
- Un servidor MCP de Albus: la puerta de Claude es el `CLAUDE.md` + los comandos, que no
  cuestan tokens en las sesiones que no son de Albus.

## El mapa (Strangler Fig): nada se borra hasta que su reemplazo funciona

| Obra | Qué | Condición para pasar a la siguiente |
|---|---|---|
| **1** | Este TUI + `setup` en los 5 agentes del hub + `CLAUDE.md` operativo | la laptop queda configurada solo con el TUI |
| 2 | **Video** → se une a meeting-notes (el pipeline de whisper ya portado) | meeting-notes transcribe igual que la pantalla de video de Albus |
| 3 | **Lectura de My Notes** (QRs, comprobantes, contactos, pendientes, grafo) → agente `notes-extractor` | procesa las mismas notas con los mismos resultados, contra la misma tabla `extractions` |
| 4 | **Udemy** y **búsqueda de trabajo** → agentes con tu Chrome real vía Orca (patrón de utel-study) | aplican y transcriben igual que dentro de Albus |
| 5 | Retirar la ventana: tag `v1-electron`, después borrar `renderer/`, `preload/`, `ipc/` y lo que haya quedado vacío | ninguna función queda solo en la app |

El estado del usuario (reglas `.md`, `video/`, `connections.json`) se migra **copiando**
(`copyMissing`) y nunca moviendo: son contratos congelados (`frozen-contracts.md`).
