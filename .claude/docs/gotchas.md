# Gotchas

Cosas que ya costaron tiempo. Cada una está acá porque se rompió de verdad.

## Imágenes y OCR

- **Fotos de celular vienen rotadas.** `sharp(buf).rotate()` sin argumentos
  auto-orienta según EXIF. Sin eso, `jsqr` falla en la mayoría de los QR
  fotografiados.
- **`jsqr` necesita RGBA crudo**, no un JPEG:
  `.ensureAlpha().raw().toBuffer({ resolveWithObject: true })`.
- **El worker de tesseract es caro de crear.** Instanciarlo una vez y reusarlo;
  cerrarlo al salir.

## CLIs locales

- **Los CLIs de npm en Windows son shims `.cmd`:** `execFile` necesita la ruta
  resuelta con `where`, no el nombre pelado.
- **Cada CLI pasa el prompt distinto:** `claude` lo toma por **stdin** (`-p`);
  `agy` lo toma por **argv** (`--print <prompt>`) y **se cuelga si stdin es un
  pipe abierto** — usar `stdio: ['ignore', 'pipe', 'pipe']`. Argv en Windows tiene
  techo de ~32k caracteres.
- **`VAR=1 npm run dev` no funciona en PowerShell**, que es la shell del usuario.
  Por eso los comandos de trabajo pasan por `scripts/run-jobs.mjs`, que setea el
  entorno y spawnea igual en las dos shells.

## Automatizar un DOM ajeno

- **`input.value = x` no alcanza en un formulario React.** React guarda su valor
  en el nodo y lo pisa al re-renderizar. Hay que llamar al setter nativo del
  prototipo
  (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`) y
  después disparar `input` + `change` con `bubbles: true`.
- **`input[type=file]` no se puede llenar desde JavaScript.** Es una restricción
  del navegador, no un bug. La única vía es CDP:
  `webContents.debugger.attach('1.3')` + `DOM.setFileInputFiles`.
- **El label de un grupo de radios es el `<legend>`**, no el `<label>` del
  primero. Sin eso "¿Estás autorizado a trabajar?" se lee como "Sí" y ninguna
  regla la reconoce.
- **Si hay un modal abierto, el formulario es ESE.** Sin acotar el scope, el
  buscador del header de LinkedIn entra como campo y se lleva un turno del modelo
  al pedo.
- **Un click contra una SPA sin reintento es tirar una moneda.** `clickText`
  ejecutaba su script UNA vez: si Notion todavía no había montado el botón,
  fallaba aunque el botón apareciera 300 ms después. `waitForText` sí tenía el
  bucle desde el principio — la asimetría entre las dos fue el bug. Ahora las dos
  reintentan.
- **Buscar por texto en el DOM es frágil**: `includes("conectar")` matcheaba "sin
  conectar: Notion · Google" de otra tarjeta. En los demos, click por clase.
- **`capturePage()` con `show: false` devuelve el último frame pintado**, no el
  actual. La primera captura del demo mostraba "buscando…" con los resultados ya
  en el DOM.

## Red y credenciales

- **`JWT issued at future` de Supabase NO es tu reloj.** Se midió: 0 s de desfase
  contra su servidor y +0.005 s contra el NTP. Y no podría serlo — interceptando
  el fetch se ve que supabase-js manda `apikey`, `authorization` y
  `x-client-info`, y ningún dato de tiempo: el cliente no tiene forma de hacer que
  el servidor hable de un `iat`.

  La cadena real es que la key es `sb_secret_…`, que **no es un JWT**; PostgREST
  solo entiende JWT, así que el borde de Supabase acuña uno con `iat` = su reloj y
  PostgREST lo valida contra el suyo. Desfase entre nodos **de ellos**.

  `src/main/supabase/retry.ts` (`createFetchWithRetry`, `IS_TRANSIENT`) lo
  reintenta dos veces y nada más: una key revocada o un 500 salen enseguida, sin
  disfraz. `npm run jobs -- supa` lo vuelve a medir.

- **Una allowlist de hosts exactos se rompe con los subdominios regionales.** El
  scraper devuelve `co.linkedin.com` y el botón "ver la vacante" fallaba con "host
  no permitido" en CADA resultado real. Se chequea por sufijo de etiqueta
  (`host === d || host.endsWith('.' + d)`), nunca `endsWith` pelado:
  `evil-linkedin.com` pasaría el ingenuo. Y el invariante **postulable ⊆ abrible**
  se deriva en código (`isApplicableUrl` / `isOpenableUrl` en `shared/ipc.ts`), no
  se duplica en dos listas — así fue como se desincronizaron.

## Feedback y debugging

- **Debugging = dos consolas:** errores del renderer → DevTools; errores del main
  (Supabase, CLI, IPC) → terminal de `npm run dev`.
- **Un `console.log` en el main no es feedback para el usuario.** Está en la
  terminal de `npm run dev`, y el usuario está mirando la app. Todo proceso largo
  disparado desde la UI necesita su canal de eventos; si no, "está trabajando" y
  "se colgó" se ven idénticos.

## Herramientas

- **Nunca uses `npx rg`.** En este entorno resuelve a un paquete `rg@0.0.2` que es
  un generador de READMEs y escribe un `README.md` espurio en la raíz del repo.
  Usá la herramienta Grep.
