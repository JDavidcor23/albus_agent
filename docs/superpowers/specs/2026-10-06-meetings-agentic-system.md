# Sistema agéntico de reuniones — piezas y contratos

> 2026-10-06. Reemplaza el diseño monolítico de `meeting-notes` (2026-10-05): un
> agente que capturaba, transcribía, buscaba en Drive, juntaba y ruteaba era un
> espagueti. Ahora son piezas chicas que encajan por **contrato de archivos**.

## La regla del encastre

1. **Cada agente escribe SOLO en `<hub>\results\<su-id>\`.**
2. **Un agente puede LEER la carpeta de resultados de otro**, nunca escribirla.
   `<hub>` se resuelve igual que en todo el hub: `ALBUS_AGENTS_HUB_DIR` (trim) →
   `<home>\Documents\agents-hub`. Nunca hardcodeado.
3. **Cada unidad de salida es una carpeta con un manifiesto JSON escrito AL
   FINAL.** Sin manifiesto = incompleta, se ignora. Esa es la única señal de "listo".
4. **Idempotencia por carpeta:** si la carpeta de salida con su manifiesto existe,
   esa unidad ya se procesó. Nada de flags.
5. **Ningún agente llama a otro.** El orden lo da el tiempo (cada uno corre en su
   horario o a pedido) y los manifiestos.
6. Si dos manifiestos traen tamaños de archivo (`files: {nombre: bytes}`), el lector
   verifica los tamaños antes de procesar (Syncthing no respeta el orden de escritura).

## Las piezas

| id | Hace UNA cosa | Corre en | Lee | Escribe |
|---|---|---|---|---|
| `obs-capture` | grabación de OBS → paquete liviano | laptop y desktop | la carpeta de OBS | `results/obs-capture/inbox/<pkg>/` |
| `transcriber` | paquete o video → transcript + capturas por cambio de texto + HTML | desktop | `results/obs-capture/inbox/` o un archivo dado a mano | `results/transcriber/<unidad>/` |
| `gemini-notes` | notas y transcript de Gemini de las reuniones de 30X | desktop | Calendar + Drive de 30X | `results/gemini-notes/<reunion>/` |
| `meeting-router` | junta lo de una misma reunión y la deja en su destino según reglas | desktop | `results/transcriber/`, `results/gemini-notes/` | `results/meeting-router/<reunion>/` + copia al destino |
| `job-dispatcher` *(después)* | reunión de trabajo → tareas → subagente por repo, PR sin merge | desktop | `results/meeting-router/` | PRs |
| `interviews` *(después)* | entrevistas → carpeta de estudio + feedback | desktop | `results/meeting-router/` | `entrevistas/` |

### `obs-capture` (es la Fase 1 ya construida de `meeting-notes`, renombrada)

- Paquete `<YYYY-MM-DD_HH-MM-SS_<maquina>>/`: `audio.opus`, `proxy.mp4` (1 fps,
  sin audio), `capture.json` (manifiesto, con `files` y tamaños).
- Syncthing comparte SOLO `results/obs-capture/inbox/` entre las máquinas.

### `transcriber` (es la mudanza del video de Albus: la "obra 2" del mapa)

- Porta el pipeline de `albus_agent/src/main/core/video/` + `src/main/video/`
  (whisper `small`, tramos de 3 min de a dos, filtro de alucinaciones por volumen
  −50 dB) y la selección de capturas por cambio de TEXTO (OCR) que ya existe en
  `obs-capture/src/features/frames/`. **Una sola copia de cada regla**: el código
  pasa a vivir acá. Lo de Albus queda marcado como deprecado en `known-debt.md`
  hasta retirar la pantalla de video.
- Entradas: (a) cada paquete completo de `obs-capture`; (b) a mano:
  `npm run transcribe -- "<video o audio>"`.
- Salida `<unidad>/`: `transcript.srt`, `transcript.txt`, `frames/` (solo las que
  cambiaron de texto, a resolución de lectura), `page.html` (captura junto a su
  minuto), `transcript.json` (manifiesto: origen, `startedAt` de la grabación,
  `durationSec`, conteos, `files`). Escrito al final.

### `gemini-notes`

- Lista los eventos de Calendar de 30X de los últimos N días, busca en Drive el Doc
  `<título> - <fecha> - Notes by Gemini` y lo exporta como texto (resumen,
  decisiones, próximos pasos y transcripción con hablantes).
- Salida `<YYYY-MM-DD_HH-MM>_<slug>/`: `notes.md` (texto tal cual), `meta.json`
  (manifiesto: `eventId`, título, inicio y fin, asistentes, organizador, `docId`,
  `docUrl`). Escrito al final.
- Auth: OAuth de escritorio propio, `calendar.readonly` + `drive.readonly`, cuenta
  de 30X, token en `.secrets/`. **Riesgo:** el Workspace de 30X puede bloquear la app.
  Plan B ya verificado: los conectores de claude.ai, que ya leen ese Drive y ese
  Calendar, vía `claude -p` con solo esas herramientas permitidas.

### `meeting-router`

- Une las unidades por **solapamiento de horario** (± 15 min) entre `transcriber`
  (`startedAt` + `durationSec`) y `gemini-notes` (inicio/fin del evento). Con una
  sola fuente también procesa.
- Escribe `<YYYY-MM-DD_HH-MM>_<slug>/acta.md` (encabezado + resumen de Gemini +
  link al HTML del transcriber + transcript), y `route.json` (manifiesto: fuentes,
  regla que matcheó, destino).
- **Reglas en `routes.yml` del usuario, no en código.** Primera regla: asistentes
  de `@30x.com` → `C:\Users\PC\Documents\web\job\meetings\<carpeta>\`. Sin regla →
  queda solo en sus resultados.
- Copia al destino, nunca mueve. Nunca escribe dentro de un repo git que no sea
  una carpeta `meetings/` declarada en la regla.

## Orden de construcción

1. Renombrar `meeting-notes` → `obs-capture` (repo, carpeta, id, resultados). No
   está instalado en la laptop todavía: es el momento más barato.
2. `transcriber`: desbloquea probar con la grabación real del 2026-10-05.
3. `gemini-notes`.
4. `meeting-router`.
5. `job-dispatcher` e `interviews`, cada uno con su propio diseño.

Cada pieza: repo privado `JDavidcor23/<id>` con topic `albus-agent`, bloque `setup`
en su `agent.json`, convenciones de mail-triage (Node ≥ 22.18 con TS nativo,
`node --test`, zod).
