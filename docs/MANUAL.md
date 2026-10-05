# Manual de Albus — para Jorge

Esto no es la documentación técnica (esa está en `.claude/docs/` y es para Claude).
Esto es lo que **tú** necesitas para instalar Albus, traerte todo y usar los comandos.

---

## Las tres piezas

| Pieza | Dónde vive | Qué es |
|---|---|---|
| **Albus** | `Documents\web\albus_agent\` | La app. Repo `JDavidcor23/albus_agent` |
| **Tus agentes** | `Documents\agents-hub\agents\<agente>\` | Uno por carpeta, cada uno con su propio repo privado en GitHub |
| **Tus datos** | `Documents\albus_agent\` y `Documents\agents-hub\results\` | Reglas, conexiones, videos, resultados. **No están en GitHub** |

---

## Máquina nueva: de cero a todo funcionando

Todo en **PowerShell**.

**1. Herramientas** (después cierra y vuelve a abrir PowerShell):
```powershell
winget install Git.Git OpenJS.NodeJS.LTS GitHub.cli Gyan.FFmpeg
```

**2. GitHub**, con tu cuenta **personal** (JDavidcor23), nunca la de 30X:
```powershell
gh auth login
```

**3. Albus**:
```powershell
mkdir $env:USERPROFILE\Documents\web -Force; cd $env:USERPROFILE\Documents\web
gh repo clone JDavidcor23/albus_agent
cd albus_agent; npm install
```

**4. Todos tus agentes, de un golpe** (de paso deja instalados los comandos de abajo):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\agents.ps1 install
```

**5. Lo que GitHub no lleva: cópialo del otro PC con una USB.** Nunca por WhatsApp, correo
ni Drive.

| Copia esto | Por qué |
|---|---|
| `Documents\web\albus_agent\.env` | Las claves de Albus. La de Supabase **abre tu base de datos entera** |
| `Documents\albus_agent\` (la carpeta entera) | Tus reglas para los agentes, conexiones y videos |
| `.env`, `.env.local` y `.secrets\` de cada agente | Las claves de cada agente |

Las sesiones (WhatsApp, LinkedIn, Google en el navegador) **no se copian**: en la máquina
nueva vuelves a iniciar sesión.

**6. Listo.** Abre Albus con `npm run dev`.

---

## Los comandos del día a día

### Tus agentes (desde cualquier PowerShell)

| Comando | Qué hace |
|---|---|
| `update-agents` | Actualiza **todos** tus agentes con lo último de GitHub |
| `clone-agents` | Baja los agentes que todavía no tienes en esta máquina |
| `sync-agents` | Las dos cosas |
| `agents-status` | Te dice qué tiene cambios sin guardar o sin subir. No cambia nada |

Nunca te borra trabajo: si un agente tiene cambios sin commitear, lo salta y te avisa.

### Albus (desde `Documents\web\albus_agent`)

| Comando | Qué hace |
|---|---|
| `npm run dev` | Abre Albus |
| `npm run hub -- list` | Lista tus agentes y si están bien instalados |
| `npm run hub -- run <agente>` | Corre un agente sin abrir la app. Ej: `npm run hub -- run mail-triage` |
| `npm run video:check -- "grabacion.mp4"` | Transcribe una grabación y saca capturas |
| `npm run notion:check` | ¿Notion responde? |
| `npm run drive:check` | ¿Google Drive responde? |
| `npm run gmail:auth` | Conecta tu Google. **Una vez** por máquina |
| `npm run jobs:login` | Inicia sesión en LinkedIn dentro de Albus. **Una vez** |

---

## Reglas de oro

1. **Antes de cambiar de máquina: `agents-status`.** Si dice "to push", haz `git push` en
   ese agente. Si no, la otra máquina no ve tus cambios.
2. **Al llegar a la otra máquina: `update-agents`.**
3. **Agente nuevo = repo privado + etiqueta `albus-agent`.** Sin la etiqueta, la otra
   máquina no lo ve. `agents-status` lo marca como `[local only]` para que no se te
   olvide. Si lo crea Claude, ya sabe hacerlo.
4. **Lo que corre solo va en UNA máquina:** WhatsApp, el triage de las 8:00, el outbox de
   UTEL. Si corren en las dos, se pelean o te duplican cosas en Notion.

---

## Cuando algo falla

| Ves esto | Haz esto |
|---|---|
| `gh is not logged in as JDavidcor23` | `gh auth login` con tu cuenta personal |
| `Authentication failed` al hacer `git push` en este PC | En este PC gh usa por defecto la cuenta de 30X. Antes del push: `$env:GH_TOKEN = gh auth token -u JDavidcor23` |
| `[skipped] … uncommitted changes` | Commitea o guarda tus cambios en ese agente y vuelve a correr `update-agents` |
| `[diverged]` | Cambiaste el mismo agente en las dos máquinas sin sincronizar. Pídele a Claude que lo junte |
| `update-agents` no se reconoce | Abre una ventana nueva de PowerShell. Si sigue, repite el paso 4 |
| Quiero la última versión de estos comandos | Repite el paso 4: `install` se baja la versión nueva |
