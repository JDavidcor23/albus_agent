# Contratos congelados

> **Ninguno de estos tira una excepción cuando lo rompés.**
>
> Ese es el punto entero del documento. Si renombrás un símbolo mal, TypeScript
> te grita y perdés treinta segundos. Si cambiás uno de los VALORES de esta
> lista, todo compila, la app arranca, la pantalla dice "listo" — y por debajo:
>
> - Notion crea sola una opción nueva en el select y los filtros del usuario
>   dejan de traer nada.
> - Drive crea una carpeta nueva VACÍA y deja los archivos viejos donde estaban.
> - Una partición de sesión renombrada tira el frasco de cookies y el login de
>   LinkedIn ya no existe.
>
> Nadie se entera el día que pasa. Se entera tres semanas después, cuando el
> seguimiento ya no sirve y no hay forma de saber desde cuándo.

**Podés renombrar el identificador que sostiene el valor. Nunca el valor.**
`COLUMNAS` → `COLUMNS` está bien; los 13 strings de adentro no se tocan.

---

## 1. El disco del usuario

**Hay DOS carpetas y la línea entre ellas es si el dato se puede regenerar.**

| | Ruta | Qué guarda |
|---|---|---|
| `dataDir()` | `Documentos/albus_agent` | lo que se perdería para siempre: agentes, reglas, cola de preguntas, credenciales, grafo |
| `cacheDir()` | `%APPDATA%/albus-agent` | lo desechable: caches de Chromium, capturas, staging de subidas, perfil de prueba |

La carpeta visible existe porque la otra tenía **3.190 archivos** de Chromium y
las reglas del usuario eran cuatro de esos tres mil: nadie podía encontrarlas,
abrirlas ni respaldarlas. `ALBUS_DATA_DIR` mueve la primera.

Cambiar cualquiera de estos nombres **no migra nada: abandona lo viejo.**

| Valor congelado | Dónde | Qué se rompe en silencio |
|---|---|---|
| `albus_agent` (carpeta) | `main/paths.ts` → `DATA_FOLDER` | la app arranca mirando una carpeta vacía: sin reglas, sin tokens, sin agentes. El usuario cree que perdió todo |
| `'albus-agent'` | `main/paths.ts` → `APP_NAME` | se mueve `cacheDir()`; se pierde la partición del navegador, o sea las sesiones de LinkedIn y Google |
| `agents` (carpeta) | `main/paths.ts` → `agentsDir()` | los `.md` de reglas y los `.agente.json` se vuelven invisibles; la app da los agentes por inexistentes |
| `<id>.agente.json` | `agents/manifest.ts` → `SUFFIX` | el agente desaparece de la lista aunque su `.md` esté ahí |
| `<id>.preguntas.json` | `agents/questions.ts` | se pierde la cola de preguntas ya respondidas; el agente vuelve a preguntar lo mismo |
| `albus.yml` | `main/paths.ts` → `albusYmlPath()`, `connections/albus-yml.ts` | **se pierden TODOS los tokens guardados** (Notion + refresh token de Google). La UI simplemente dice "sin conectar" |
| `NOTION_TOKEN`, `GOOGLE_REFRESH_TOKEN` | claves dentro de `albus.yml`, armadas por `ymlKey()` en `connections/store.ts` | el token está en el archivo y es ilegible. Mismo síntoma que arriba y más difícil de diagnosticar, porque el archivo *parece* bien |
| `connections.json` | `main/paths.ts` → `connectionsPath()` | el usuario abre la app con todos los servicios "desconectados", sin ningún error |
| `graphify` (carpeta) | `main/paths.ts` → `graphifyDir()` | el grafo construido queda huérfano y se reconstruye desde cero |
| `video` (carpeta) | `main/paths.ts` → `videoDir()` | la biblioteca de transcripts aparece VACÍA. Los archivos están en el disco y la app no los ve — y cada transcript costó su duración en CPU |
| `meta.json` | `core/video/library.ts` → `META_FILE` | **se pierde el título de cada transcript.** No hay error: la biblioteca sigue funcionando, pero todas las filas vuelven a llamarse `2026-09-02-10-29-05` y nadie distingue una reunión de otra |
| `transcript.srt` | `video/store.ts` → `entryFor()` | es el archivo por el que se decide "esta carpeta ES un transcript". Renombralo y la carpeta entera deja de listarse, con título y todo adentro |
| `capturas`, `pruebas` | `connections/connection-agent.ts`, `main/paths.ts` | capturas y perfil de prueba huérfanos. Daño bajo, igual congelado |

### La migración es obligatoria, y COPIA

`migrateLegacyData()` en `paths.ts` trae lo viejo: `%APPDATA%/agentes` → `agents/`,
`albus.yml`, `connections.json`, y `Escritorio/albus-graph` → `graphify/`.

Tres cosas que no son negociables ahí, cada una porque ya falló:

1. **Copia, no mueve.** Si la copia sale mal no hay a dónde volver. El original
   queda hasta que el usuario verifique.
2. **Entrada por entrada, no la carpeta entera.** La primera versión salteaba todo
   si el destino existía, y `check-agents.ts` dejaba ahí una carpeta VACÍA: la
   migración se daba por hecha y el `job-search.md` del usuario quedaba atrás sin
   error, sin log y sin síntoma hasta abrir el panel.
3. **La dispara también `albus-yml.ts`**, no solo el arranque. Los scripts nunca
   abren la app: sin eso `notion:check` mira la carpeta nueva vacía y reporta "no
   hay token" sobre uno que existe.

Y `dataDir()` en modo prueba devuelve `cacheDir()/pruebas`, con `cacheDir()`
capturado **al importar** — antes de que `index.ts` redirija el `userData`. Sin esa
captura la ruta salía `pruebas/pruebas` en la app y `pruebas` en los scripts: dos
lugares distintos para el mismo perfil.

### El formato de las respuestas del agente

Estas dos cadenas son formato de archivo, no texto de UI:

| Valor congelado | Dónde | Qué se rompe |
|---|---|---|
| `'## Respuestas a lo que el agente preguntó'` | `agents/questions.ts` → `ANSWERS_SECTION_HEADING` | la sección se DUPLICA en cada archivo de reglas que ya existe: el código busca el título viejo, no lo encuentra, y agrega uno nuevo abajo |
| `- <respuesta>  <!-- respondiste el <fecha> a: <pregunta> -->` | escrito por `answerBlock()` en `agents/questions.ts`, leído por el parser de `agents/rules.ts` | las respuestas dejan de aparecer en el panel. **Este bug ya pasó una vez**: el usuario contestaba y no veía cambiar nada |

Las dos puntas —quien escribe y quien parsea— tienen que decir exactamente lo
mismo. Son dos archivos distintos y ahí está la trampa.

---

## 2. Notion

La base es "Registro de aplicaciones" y es el espejo que el usuario mira.

| Valor congelado | Dónde | Qué se rompe en silencio |
|---|---|---|
| `'post link'` | `core/jobs/notion-map.ts`, `notion/applications.ts` | **es la clave del upsert.** Si cambia, la búsqueda previa no encuentra nada y cada corrida INSERTA: tres filas de la misma empresa, y el seguimiento —lo único para lo que sirve la base— deja de funcionar |
| `Company`, `Role/Position`, `Status`, `Date of application`, `Fit Score`, `Email/Linkedin URL`, `Job description`, `cover letter`, `Próxima acción` | `notionProperties()` en `core/jobs/notion-map.ts` | Notion crea una COLUMNA nueva con el nombre nuevo. La vieja queda con los datos históricos, la nueva se llena desde hoy. Split-brain silencioso |
| `Applying`, `In process`, `Rejected`, `First contact`, `Backlog`, `Descartada` | `NOTION_STATUSES` en `core/jobs/notion-map.ts` | Notion inventa la opción sola. De golpe hay siete estados donde había seis y los filtros guardados del usuario dejan de traer filas |
| `'[oculto]'` | placeholder de `scrubPii()` | cosmético, pero ya está escrito en filas reales |

Sí, `'Descartada'` y `'Próxima acción'` están en español en medio de un
codebase en inglés. **Es correcto.** Son los nombres que el usuario le puso a
su base con el mouse. El código se traduce; los datos de un tercero no.

Por eso `notionStatus()` devuelve `null` antes que inventar una opción: el
mapeo `AlbusStatus → NotionStatus` es total y cerrado, y si un estado no está
mapeado, el llamador no escribe la fila. Una fila sin estado es un problema
visible; un select con basura adentro es uno invisible.

---

## 3. Google Drive

| Valor congelado | Dónde | Qué se rompe en silencio |
|---|---|---|
| `'pagos'`, `'qr-eventos'`, `'contactos'`, `'info'`, `'sin-clasificar'` | `ArchiveFolder` en `core/extraction/archive.ts`, consumido por `drive/archive.ts` y `scripts/drive-*.ts` | `drive/archive.ts` **se autorepara**: si no encuentra la carpeta, la crea. Traducidas al inglés, crea cinco carpetas nuevas y VACÍAS, y todo el archivo histórico se queda en las viejas. Nada falla. Nadie avisa |
| `'albusKey'`, `'albusKind'`, `'albusEntry'` | `drive/archive.ts` (`appProperties`) | son las llaves de idempotencia ya escritas sobre archivos reales de Drive. Renombradas, cada corrida vuelve a subir todo como si fuera nuevo |

---

## 4. La sesión del navegador

| Valor congelado | Dónde | Qué se rompe en silencio |
|---|---|---|
| `'persist:albus-jobs'` | `browser/session.ts` → `PARTITION` | **se pierden las sesiones de LinkedIn y Google.** Electron crea una partición nueva, vacía, y hay que volver a loguearse a mano (`npm run jobs:login`). El síntoma que ve el usuario es "me pide login de nuevo", no un error |
| `li_at`, `SID` | `browser/session.ts` | son los nombres de cookie con los que se detecta si hay sesión viva. Cambiados, `hasLinkedInSession()` dice que no hay sesión aunque la haya |
| scopes de OAuth (`https://www.googleapis.com/auth/gmail.compose`, …) | `connections/google-oauth.ts`, `gmail/send.ts` | se rompe la autenticación. Este sí falla ruidoso, pero está acá porque son strings de un tercero que no se "mejoran" |

---

## 5. El workspace del agente de trabajo

**Dónde está: `agents/<id del agente>/`. Se DERIVA. No hay nada que configurar.**

La regla es **agente `X` → `agents/X/`**. Un agente nuevo trae su carpeta sin que
nadie agregue una variable de entorno ni una constante. La única perilla de rutas
que queda en todo el proyecto es `ALBUS_DATA_DIR`, que mueve la RAÍZ de los datos:
una para todo, cero por agente.

Hubo tres versiones peores, y cada una se murió por un motivo distinto:

1. **`JOB_WORKSPACE_DIR` obligatoria.** `workspaceDir()` tiraba si faltaba, y la
   variable apuntaba a un clon de `github.com/MadsLorentzen/ai-job-search` — el
   repo de un TERCERO. Arrancar Albus exigía clonar el repositorio de otra persona.
2. **La misma variable como override que ganaba.** Reclamo del usuario, y va al
   hueso: *"si ahí están listados todos los agentes, ¿por qué yo tengo que poner en
   el `.env` todo eso? Si esto yo lo quiero publicar el día de mañana para otra
   persona, ¿qué hago?"*. Una ruta de una máquina no se publica.
3. **La ruta absoluta HARDCODEADA** como fallback en `check-jobs.ts`,
   `check-agents.ts` y `check-live.ts`. Era el "esto no se puede publicar" más
   concreto de todos, porque ni se podía configurar.

> **Los tests se aíslan por PARÁMETRO, nunca por variable de entorno.**
> `createWorkspaceKitSource(stagingDir, workspace?)` y `createCsvTracker(csvPath?)`
> existen por eso. Una perilla pública que existe solo para que los tests se aíslen
> es una perilla que se puede girar al revés — y girada al revés, `check-jobs.ts`
> **le agregó dos filas de prueba al CSV real del usuario**. Un parámetro no se
> puede ignorar.
>
> Y por la misma razón el autochequeo del navegador usa
> `resources/albus-profile.fixture.json` en vez del perfil real: un test que
> necesita los datos personales de alguien no corre en la máquina de nadie más.

Y ojo con lo que sigue siendo cierto: si el usuario mantiene el clon de
`ai-job-search`, ese repo **también escribe** en su copia. Dos carpetas con los
mismos nombres de archivo divergen en silencio — un CV nuevo generado por las
skills de ese repo no aparece del lado de Albus. Una sola tiene que ser la de
verdad.

Este repo **no es el único que escribe** en esas rutas. Son un contrato entre
dos programas, y el otro no se entera de los cambios de este.

| Valor congelado | Dónde | Qué se rompe en silencio |
|---|---|---|
| los 13 headers de `COLUMNS` (`date, company, sector, role, roleType, channel, status, contactPerson, fitRating, notes, cvFile, coverLetterFile, source`) | `jobs/tracker.ts` | el CSV se vuelve ilegible para `ai-job-search`. Y `'source'` es además la **clave de deduplicación**: si cambia, se postula dos veces a la misma vacante |
| `albus-profile.json` y sus 27 claves de esquema | `jobs/workspace.ts` → `PROFILE_FILE`, `core/jobs/profile.ts` | el perfil no se lee y el agente se apaga con "falta el perfil" |
| `cv/main_<slug>.pdf`, `cover_letters/cover_<slug>*.pdf` | `jobs/workspace.ts` | el kit ya compilado no se encuentra: se postula sin CV o no se postula |
| `job_scraper/seen_jobs.json` y su clave `seen` | `jobs/search.ts` | se pierde el historial de vacantes vistas y vuelven todas como nuevas |

---

## 6. El grafo

Las etiquetas de arista del grafo **se persisten** en `graph.json`, que vive en
el Escritorio del usuario (o donde diga `ALBUS_GRAPH_DIR`).

| Valor congelado | Dónde | Qué se rompe en silencio |
|---|---|---|
| `trabaja_en`, `conoci_en`, `organiza`, `pagado_a`, `trata_de`, `enlaza_a` | `core/graph/build.ts` (el modelo las emite, `graph/store.ts` las guarda) | las aristas viejas y las nuevas dejan de ser el mismo tipo. El grafo se parte en dos mitades que no se unen. Mismo split-brain que las carpetas de Drive |
| las etiquetas `tipo:` / `contenido:` del cuerpo que se le manda al modelo | `core/graph/build.ts` | el formato de entrada está descrito en prosa española dos líneas más arriba, en el mismo prompt. **Las dos puntas o ninguna** |

Los regex `comercio` / `llave` de `core/extraction/patterns.ts` matchean texto
español impreso en comprobantes reales. Son patrones sobre datos, no
identificadores. No se traducen.

---

## 7. Los pares acoplados: schema zod ↔ prompt

No son valores en disco, pero fallan igual de mal: el modelo devuelve una
clave, zod espera otra, y el error aparece en runtime como un parse error, no
en `npm run typecheck`.

| Par | Archivos | Nota |
|---|---|---|
| las claves JSON que el prompt pide ↔ el `z.object` que las valida | `connections/navigate-llm.ts`, `core/jobs/answers-llm.ts`, `core/jobs/rank.ts`, `core/graph/build.ts`, `core/tasks/detect.ts`, `core/extraction/llm-classify.ts` | **una edición, los dos lados.** El prompt describe la forma; el schema la exige |
| `InventoryItem.action` con valores `'click' \| 'type'` | emitido por `INVENTORY` en `browser/page-scripts.ts`, tipado en `core/jobs/ports.ts`, consumido por el `z.enum` de `connections/navigate-llm.ts` | **tres archivos.** Si uno dice `'escribir'` y otro `'type'`, el agente de navegación nunca más puede escribir en un campo |

La prosa en español dentro de los prompts **no se traduce**: `llm-classify.ts`
pide explícitamente resúmenes en español y esos resúmenes ya están guardados en
Supabase. Traducir un prompt es un cambio de comportamiento, no un rename.

---

## 8. Lo que NO está congelado, y por qué conviene saberlo

- **Nombres de tabla y columna de Supabase**: ya estaban en inglés.
- **Nombres de canal IPC** (`'extraction:run'`, `'jobs:hunt'`): ya en inglés,
  convención `dominio:verbo`. Cruzan procesos pero no sobreviven a un reinicio,
  así que cambiarlos es seguro *si se cambian las tres puntas juntas*.
- **Las fases de progreso de `hunt.ts`** (`'buscando'`, `'puntuando'`,
  `'criba'`…) siguen en español. `HuntProgress.phase` es un `string` libre que
  se pinta en la UI, no una unión sobre la que alguien haga `switch`. Parece un
  enum y no lo es.
- **`ConnectionInfo.id`** (`'notion'`, `'google'`, `'google-browser'`,
  `'linkedin'`, …) en `connections/registry.ts`. Cruza IPC al renderer y está
  asertado en `scripts/check-agents.ts`, pero **no se persiste en disco** — no es
  una clave de `albus.yml`. Se puede renombrar, siempre en UNA pasada:
  `connections/registry.ts` + `renderer/components/ConnectionsPanel.tsx` + el
  check. Así se hizo con `'google-navegador'` → `'google-browser'`.
