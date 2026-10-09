# Manual de Albus — para Jorge

Esto no es la documentación técnica (esa está en `.claude/docs/` y es para Claude).
Esto es lo que **tú** necesitas para instalar Albus, traerte todo y usar los comandos.

---

## Las tres piezas

| Pieza | Dónde vive | Qué es |
|---|---|---|
| **Albus** | `Documents\web\albus_agent\` | El CLI que corre tus agentes (`npm run hub`) y el TUI de configuración (`npm run setup`). Repo `JDavidcor23/albus_agent` |
| **Tus agentes** | `Documents\agents-hub\agents\<agente>\` | Uno por carpeta, todos juntos en UN solo repo privado en GitHub (`agents-hub`) |
| **Tus datos** | `Documents\albus_agent\` y `Documents\agents-hub\results\` | Reglas y resultados. **No están en GitHub** |

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

**4. `npm run setup`** (el TUI, con flechas y Enter): elige en qué carpeta
guardar tus agentes (el hub), clona el repo `agents-hub` con todos los que ya
tienes en GitHub, te pide una por una las claves que falten y abre los
permisos de Google.

La pantalla principal del TUI tiene tres grupos: **Connections** (Google,
Notion, WhatsApp — ahí entras UNA sola vez por cuenta), **Agents** (el resto,
ya publicados) y, solo si tienes alguno sin terminar, **Drafts (not
published)** al final, en gris — agentes guardados y a salvo en GitHub pero
que todavía no le pediste a Claude que publique (ver la regla 3 más abajo). Ya
no hace falta pegar el mismo token de Notion o volver a autorizar Google en
cada agente nuevo: configuras la conexión una vez en Connections y cualquier
agente que la necesite la usa sola. Si a un agente le falta una conexión, el
TUI te lo dice con un aviso tipo `needs google (gmail-read)` — entras a esa
conexión en Connections, la terminas de configurar, y el aviso desaparece
solo.

**5. Lo que GitHub no lleva: cópialo del otro PC con una USB.** Nunca por WhatsApp, correo
ni Drive.

| Copia esto | Por qué |
|---|---|
| `Documents\albus_agent\` (la carpeta entera) | Tus reglas para los agentes y las preguntas que ya contestaste |
| `agents-hub\agents\google\.env` y `agents-hub\agents\google\.secrets\` | Google personal ya autorizado (leer correo, enviar, Drive y Calendar). Con esto no vuelves a autorizar nada |
| `agents-hub\agents\notion\.env` | Tu token de Notion |

Son las ÚNICAS credenciales de Google y Notion que existen: ningún otro agente
tiene las suyas. Si prefieres no copiarlas, entra en el TUI a Connections →
Google / Notion y cárgalas ahí.

**WhatsApp va en UNA sola máquina.** No vincules la laptop mientras el PC lo
tenga: dos sesiones se pelean la conexión. Si algún día lo mudas, en la nueva
máquina entra en Connections → WhatsApp → link y escanea el QR.

Las sesiones del navegador (LinkedIn, UTEL) se rehacen a mano.

**6. Listo.** Comprueba que todo está con `npm run hub -- list`.

---

**Día a día:** entra a la carpeta de Albus y escribe `claude`. Pídele lo que
necesites de un agente — correrlo, ver su estado, actualizarlo — él sabe qué
comando usar.

---

## Los comandos del día a día

### Tus agentes (desde cualquier PowerShell)

| Comando | Qué hace |
|---|---|
| `update-agents` | Trae lo último del repo `agents-hub` (todos tus agentes a la vez) |
| `clone-agents` | Si esta máquina todavía no tiene el repo, lo baja completo |
| `sync-agents` | Lo que aplique: baja el repo si falta, o lo actualiza si ya lo tienes |
| `agents-status` | Te dice qué tiene cambios sin guardar o sin subir, agente por agente. No cambia nada |

Nunca te borra trabajo: si hay cambios sin commitear que se pisarían al actualizar,
el comando se detiene y te dice cuáles son — no hace `reset` ni te los pisa.

### Albus (desde `Documents\web\albus_agent`)

| Comando | Qué hace |
|---|---|
| `npm run hub -- list` | Lista tus agentes y si están bien instalados |
| `npm run hub -- run <agente>` | Corre un agente. Ej: `npm run hub -- run mail-triage` |
| `npm run setup` | El TUI: dónde vive el hub, claves, permisos de Google y Notion, vincular WhatsApp |

### Albus en el VPS (desde `Documents\agents-hub\agents\hermes-vps`)

| Comando | Qué hace |
|---|---|
| `npm run gmail:vps-auth` | Le da a Albus del WhatsApp permiso para leer y enviar tu Gmail personal. **Una vez**. Se abre el navegador dos veces: elige tu cuenta personal las dos. Para enviar, Albus siempre te pide tu "sí" y un código que te llega como imagen |

---

## Sesiones de feedback y psicología

Cada mes, después de una conversación de feedback (Camila, Natalie, etc.) o
de tu sesión con la psicóloga, tres pasos desde `Documents\agents-hub\agents`:

```powershell
# 1. Transcribe la grabación (carpeta transcriber)
cd transcriber
npm run transcribe -- "C:\ruta\a\la grabación.mp4" --title "Camila octubre"

# 2. Analízala con el lente que corresponda (carpeta growth)
cd ..\growth
npm run ingest -- "<nombre de la unidad que imprimió transcriber>" --lens work-feedback --with "Camila"
# para psicología: --lens therapy --with "Nombre de tu psicóloga"

# 3. Cuando ya cargaste todas las sesiones del mes, arma el plan y publícalo
npm run plan
```

`npm run plan` actualiza la página **Plan de mejora** y la base **Crecimiento**
en tu Notion personal (adentro de la página Albus). Después puedes preguntarle
a Albus por WhatsApp "qué debo mejorar" o "qué me dijo Camila" y te contesta
desde ahí — no hace falta que abras Notion.

Lo de psicología es privado: queda solo en tu Notion personal y en
`agents-hub\results\growth` (nunca en GitHub), y Albus nunca lo repite en un
grupo ni a nadie más que a ti.

---

## Reglas de oro

1. **Antes de cambiar de máquina: `agents-status`.** Si dice "not pushed", haz `git push`
   en el repo del hub (`cd` a `agents-hub`, o pídeselo a Claude). Si no, la otra máquina
   no ve tus cambios.
2. **Al llegar a la otra máquina: `update-agents`.**
3. **Agente nuevo = borrador hasta que tú digas "publícalo".** Claude lo guarda y lo sube
   a GitHub enseguida — eso ya es tu respaldo, no se pierde — pero lo marca como
   borrador (`[draft]` en `agents-status`, gris en el TUI) hasta que tú decides que está listo y le pides a Claude que lo publique.
4. **Lo que corre solo va en UNA máquina:** WhatsApp, el triage de las 8:00, el outbox de
   UTEL. Si corren en las dos, se pelean o te duplican cosas en Notion.

---

## Cuando algo falla

| Ves esto | Haz esto |
|---|---|
| `gh is not logged in as JDavidcor23` | `gh auth login` con tu cuenta personal |
| `Authentication failed` al hacer `git push` en este PC | En este PC gh usa por defecto la cuenta de 30X. Antes del push: `$env:GH_TOKEN = gh auth token -u JDavidcor23` |
| `update failed` con un mensaje sobre cambios sin commitear | Commitea o guarda esos cambios y vuelve a correr `update-agents` |
| `diverged` | Cambiaste algo en las dos máquinas sin sincronizar. Pídele a Claude que lo junte |
| `update-agents` no se reconoce | Corre `powershell -ExecutionPolicy Bypass -File scripts\agents.ps1 install` una vez: instala estos atajos en tu perfil de PowerShell. Si ya lo hiciste, abre una ventana nueva |
| Quiero la última versión de estos comandos | Corre `powershell -File scripts\agents.ps1 install` de nuevo: baja la versión nueva del script |
