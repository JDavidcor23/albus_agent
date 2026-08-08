# Deuda conocida

Lo que sabemos que está flojo y por qué se dejó así. No es una lista de tareas:
es contexto para que nadie lo "descubra" de nuevo y lo arregle mal.

## Seguridad y empaquetado

- **`sandbox: false`** en `src/main/index.ts:47`, heredado del template de
  electron-vite. Con `contextIsolation` en su default `true` y un preload que solo
  usa `contextBridge`, se puede pasar a `true`. Pesa más acá que en un template
  porque el main tiene el service role key.
- **Electron 33 tiene un ASAR integrity bypass conocido.** Subir versión **antes
  de empaquetar**. No bloquea `npm run dev`.
- **`src/main/devtools/` viaja en el bundle del main.** Siete archivos de
  autochequeo y demo que ningún usuario final debería poder alcanzar. Están
  detrás de variables de entorno `ALBUS_*`, así que no se ejecutan solos, pero
  son candidatos a exclusión de build antes de empaquetar.
- **CSP del renderer es `img-src 'self' data:`.** Correcto hoy. Cuando la UI
  muestre las fotos, las signed URLs de Storage van a quedar bloqueadas: pasar los
  bytes por IPC como `data:` antes que abrir el CSP.

## Verificación

- **No hay linter ni test runner**, por decisión del dueño. El gate es
  `npm run typecheck` más los scripts de `check-*` y los selftests de `devtools/`.
  Los checks son asserts a mano, no un framework — cambiarlo es un proyecto, no un
  arreglo.
- **`npm run typecheck` no cruza el IPC.** El punto ciego real; está explicado en
  `architecture.md`. Es la razón de que exista el subagente `ipc-contract-agent`.
- **Las migraciones se aplican a mano en el SQL Editor.** No hay
  `supabase migration up` acá. Por eso 0004 renombra las políticas con
  `alter policy … rename to` y no editando 0001/0002: **una migración ya aplicada
  es historia, no código fuente.** Cada statement está guardado con un `if exists`
  para que corra dos veces sin romper y sobre una base creada de cero.

## Postulación

- **El upload por CDP solo alcanza el frame principal.** `DOM.querySelector` parte
  del documento raíz, así que un Greenhouse embebido en iframe se lee y se llena
  bien (`executeJavaScript` sí baja a los frames) pero el adjunto falla. Se reporta
  y el resto de la postulación sigue.
- **`auto` no tiene reintento ni backoff.** Deliberado: un bucle que reintenta
  envíos solo es exactamente lo que hace que LinkedIn te cierre la cuenta.
- **La UI del agente de trabajo existe pero es un chat, no un tablero.**
  `AgentsPanel.tsx` monta `JobChat.tsx` y desde ahí se busca, se arma el kit, se
  postula y se confirma. Lo que falta no es la pantalla: es una vista de estado
  que muestre la cola completa sin tener que preguntarle.
- **Nada de esto toca Supabase todavía.** El tracker sigue siendo el CSV de
  `ai-job-search`, que es la fuente de verdad del usuario. Meter una tercera copia
  del estado antes de que la UI la necesite es deuda, no arquitectura.

## Idioma

- **El código está en inglés; los comentarios, la copy de la UI y la prosa de los
  prompts, en español.** Es deliberado y está cerrado: es una app personal cuya
  interfaz el dueño lee en español, y los comentarios cargan la historia de las
  decisiones — traducirlos aplana el razonamiento.
- Quedan cadenas españolas que **son datos, no identificadores** y por eso no se
  traducen nunca: los nombres de propiedad de Notion, las carpetas de Drive, las
  claves de los `.preguntas.json`, las etiquetas de arista del grafo, las fases de
  progreso de `hunt.ts` y los regex sobre comprobantes reales. Están todas en
  `frozen-contracts.md`.
- **Código y comentarios nuevos se escriben en inglés.** Un comentario que nombra
  un símbolo renombrado se actualiza: apuntar a un símbolo que ya no existe no es
  "estar sin traducir", es estar mal.
