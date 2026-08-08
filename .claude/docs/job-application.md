# Postulación laboral

El kit (CV + carta en LaTeX, compilado y verificado) **lo sigue armando
`ai-job-search`**. Albus no lo reimplementa: lee los PDF que ese proceso dejó y
los lleva al formulario, que es la parte que hasta ahora era 100% a mano.

## La misma cascada, otro dato

El mapeo campo → respuesta es una cascada idéntica en espíritu a la de
extracción:

| # | Qué | Con qué | Costo |
|---|---|---|---|
| 1 | ¿El campo ya viene lleno y correcto? | comparación | gratis |
| 2 | ¿Matchea una regla conocida? | regex sobre label + name + placeholder (`core/jobs/answers.ts`) | gratis |
| 3 | ¿El valor existe entre las opciones del select? | `resolveOption` | gratis |
| 4 | Mapealo vos | CLI headless (`answers-llm.ts`) | **cuota del usuario** |

`core/jobs/apply.ts` es el bucle: **leer → planear → llenar → verificar**.

## Lo que Albus tiene PROHIBIDO, y es más importante que lo que hace

- **No inventa experiencia.** "¿Cuántos años con Python?" y Python no está en
  `yearsExperience` → el campo queda vacío. Contestar el total de su carrera
  porque es el único número a mano es la mentira que revienta en la primera
  entrevista técnica. Lo resuelve `yearsFor()` en `answers.ts`.
- **No firma consentimientos.** Un checkbox que diga *agree / consent / accept /
  certify / declare* cae en `requiresHuman()` y ni las reglas ni el modelo lo
  tocan.
- **No elige un título que no tiene.** Un select de nivel académico sin opción
  para bootcamp queda vacío.
- **No aprieta enviar** salvo en modo `auto`. `core/jobs/submit-guard.ts` es el
  freno: `classifyButton` + `canClick` + `explainBlock`. El default es `review`:
  llena los 20 campos, adjunta el CV, saca captura y frena.
- **El modelo devuelve valores, nunca acciones.** No emite selectores ni
  JavaScript; el ejecutor es determinista. Lo que vuelve del modelo se valida con
  zod y se vuelve a pasar por `resolveOption`.

Los modos: `dry-run` no toca la página · `review` llena y frena antes de enviar
(default) · `auto` envía.

## La sesión

Partición persistente `persist:albus-jobs` (`browser/session.ts`, valor
congelado). Se loguea LinkedIn **una vez** dentro de Albus
(`npm run jobs:login`) y la cookie queda en el disco del perfil de la app.

No hace falta relanzar Chrome con `--remote-debugging-port` ni cerrar las
pestañas del usuario, y no entra Playwright con sus 300 MB.

**El login no se automatiza.** Meterle usuario y contraseña por script a LinkedIn
es el patrón que marca su antifraude, y obligaría a Albus a guardar la
contraseña.

## Postulación por correo: por qué NO se maneja el navegador

Hay vacantes que dicen "mandá tu CV a jobs@empresa.com". La tentación es abrir
Gmail en el Chromium de Albus y apretar el clip.

Es la herramienta equivocada, y **no** porque Chromium no pueda adjuntar — puede,
el autochequeo lo prueba leyendo `input.files[0].name`. Es que el botón de
adjuntar de Gmail abre un diálogo del **sistema operativo** y su DOM se mueve
solo. La API de Gmail acepta el MIME ya armado, con el adjunto adentro, y no
tiene interfaz que se rompa. `core/jobs/email.ts` arma el MIME; `gmail/send.ts`
lo manda.

- Scope: `gmail.compose` y nada más. Alcanza para crear borradores, leerlos y
  mandar. **No se pide `gmail.readonly`**: Albus no tiene por qué ver la bandeja
  de entrada para postularse a un trabajo.
- `npm run gmail:auth` vuelve a pedir el consentimiento **incluyendo los scopes
  que ya estaban**. Sin eso, el consentimiento nuevo reemplaza al viejo y Drive
  deja de andar.
- Mismo freno que el formulario: `gmailMode()` devuelve `'draft'` en `review`,
  `'send'` en `auto`, `'none'` en `dry-run`.

## El repo `ai-job-search` es una fábrica, no un lugar de trabajo

No se puede borrar todavía, y conviene saber exactamente por qué.

**Lo que Albus ya podría absorber:** el perfil, `seen_jobs.json`, el CSV, los
seis CLIs de portales.

**Lo que no:** la generación del kit — plantillas LaTeX, `cover.cls`, el flujo
drafter/reviewer, compilar con lualatex, **abrir el PDF resultante para mirarlo**,
verificar dos páginas sin títulos huérfanos y comparar keywords con `pdftotext`.

Lo que sí cambió: quién lo dispara. `src/main/jobs/kit.ts` corre `claude -p` con
cwd en el workspace desde el botón "armar el CV a medida". El repo pasa de ser un
lugar donde se abre una terminal a una fábrica que nadie mira.

`jobs/workspace.ts` conoce las rutas del workspace; todas están **congeladas**
porque el otro repo también escribe ahí (ver `frozen-contracts.md` §5).

## El chat, no el formulario

La UI del agente es `renderer/src/components/JobChat.tsx`, montado dentro de
`AgentsPanel.tsx`. Se le habla: `core/jobs/chat.ts` → `interpret()` devuelve un
`JobIntent` (`'search' | 'apply' | 'show' | 'send' | 'discard' | 'ambiguous' |
'chat' | 'help'`) y `resolveJob()` desambigua a cuál de las vacantes en pantalla
se refiere.

Los canales viven en `ipc/jobs.ipc.ts`: `JOBS_STATUS`, `JOBS_CHAT`, `JOBS_LOGIN`,
`JOBS_HUNT`, `JOBS_KIT`, `JOBS_APPLY`, `JOBS_EMAIL`, `JOBS_CONFIRM`, más los
eventos de progreso `JOBS_STEP`, `JOBS_HUNT_PROGRESS`, `JOBS_KIT_PROGRESS`.

## Verificación

Antes de tocar `core/jobs/`, corré los dos:

```bash
npm run jobs:check      # asserts puros del dominio, sin Electron ni red
npm run jobs:selftest   # asserts del navegador contra resources/job-form-fixture.html
```
