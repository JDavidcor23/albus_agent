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

## 1. El disco del usuario (`userData`)

Todo esto vive en `%APPDATA%/albus-agent` y lo escribió el usuario o la app en
su máquina. Cambiar el nombre no migra nada: abandona lo viejo.

| Valor congelado | Dónde | Qué se rompe en silencio |
|---|---|---|
| `'albus-agent'` | `main/paths.ts` → `APP_NAME` | se mueve la raíz de `userData` entera; todo el estado de la app queda huérfano |
| `agentes` (carpeta) | `main/paths.ts` → `agentsDir()`, `agents/rules.ts` | los `.md` de reglas que el usuario escribió a mano se vuelven invisibles; la app los da por inexistentes y ofrece crear la plantilla de nuevo |
| `<id>.preguntas.json` | `agents/questions.ts` | se pierde la cola de preguntas ya respondidas; el agente vuelve a preguntar lo mismo |
| `albus.yml` | `main/paths.ts` → `albusYmlPath()`, `connections/albus-yml.ts` | **se pierden TODOS los tokens guardados** (Notion + refresh token de Google). La UI simplemente dice "sin conectar" |
| `NOTION_TOKEN`, `GOOGLE_REFRESH_TOKEN` | claves dentro de `albus.yml`, armadas por `ymlKey()` en `connections/store.ts` | el token está en el archivo y es ilegible. Mismo síntoma que arriba y más difícil de diagnosticar, porque el archivo *parece* bien |
| `connections.json` | `connections/store.ts` | los tokens cifrados del esquema viejo dejan de poder leerse. Ya no se escribe ahí, pero se sigue leyendo |
| `capturas`, `pruebas` | `connections/connection-agent.ts`, `main/index.ts` | capturas y perfil de prueba huérfanos. Daño bajo, igual congelado |

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

## 5. El workspace de `ai-job-search`

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
