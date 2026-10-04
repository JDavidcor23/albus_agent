# Prompt para correr el módulo de Udemy sin nadie mirando

Copiar lo de abajo en una sesión de Claude Code parada en este repo.

**Antes de irte, hacé UNA cosa a mano:** `npm run udemy:login`. Se abre una
ventana, entrás a Udemy, se cierra sola. El login no lo puede hacer un agente —
ni debería: es tu usuario y tu contraseña.

---

```
Estás en C:\Users\PC\Documents\web\albus_agent. Tarea: bajar la Section 3
completa del curso de AWS Cloud Practitioner con el módulo `udemy`. Trabajás
solo, sin preguntarme nada. Yo no estoy.

URL del curso:
https://www.udemy.com/course/aws-certified-cloud-practitioner-new/learn/

## Orden de trabajo — no lo saltees

1. `npm run udemy:check` — el dominio. Si esto falla, NO sigas: hay un bug en
   el código, no en Udemy. Arreglalo y volvé a correrlo hasta verde.

2. `npm run udemy -- "<url>" --limit 1` — UNA lección, para validar selectores.
   Esto tarda ~1 minuto. No largues la sección entera antes de que esto ande.

3. Solo si el paso 2 dejó un .md con contenido real:
   `npm run udemy -- "<url>" --section 3`

## Si Electron no arranca — LEER, el error miente

Si ves `FATAL: GPU process isn't usable. Goodbye.` con `exit_code=-1073741515`:
**NO es la GPU.** Es el sandbox de Chromium, que en esta máquina no puede
cargar sus DLL. Ya se midió: las DLL de video están todas, Electron sin ventana
arranca, y `--disable-gpu` / `--in-process-gpu` / `--disable-gpu-sandbox`
crashean igual. El único que funciona es `--no-sandbox`.

Agregalo a CUALQUIER comando:

    npm run udemy -- "<url>" --limit 1 --no-sandbox

No pierdas tiempo con drivers ni con switches de GPU: ya se probaron todos.

## Cuando falle (va a fallar en el 2, probablemente)

Los selectores del DOM de Udemy nunca se validaron contra la página real. Los
scripts NO fallan en silencio: devuelven `ok: false` con un campo `debug` que
lista lo que SÍ había en la página.

- "no pude leer el índice" → mirá el `debug`: trae los `data-purpose` que
  encontró. Ajustá `ITEM_SELECTORS` o `HEADER_SELECTORS` en
  `src/main/udemy/page-scripts.ts`.
- "no pude leer el transcript" → el `debug` trae tag|class|data-purpose de todo
  lo que tenga "transcript". Ajustá `PANELS` / `CUES` en el mismo archivo.
- Secciones = 0 → las cabeceras no se asociaron. El warning imprime qué
  secciones sí leyó. Revisá `HEADER_SELECTORS` y `SECTION_RE`.
- Si necesitás ver la página con tus propios ojos:
  `npm run nav:inspect -- "<url de una lección>"`

Regla para tocar `page-scripts.ts`: **agregá candidatos a las listas, no
reemplaces el selector por uno solo.** Un selector único es una apuesta a que
Udemy no redisene, y este repo ya perdió esa apuesta dos veces (está en el
README).

## Invariantes — no los rompas para que "ande"

- `npm run udemy:check` tiene que quedar en verde al terminar.
- `npx tsc --noEmit -p tsconfig.node.json --composite false` tiene que quedar
  limpio. NO corras `npm run build`.
- Los scripts de `page-scripts.ts` son strings CONSTANTES. Los valores
  variables entran por `JSON.stringify`, nunca interpolados.
- OJO con los backticks dentro de los template literals de `page-scripts.ts`:
  un ` en un comentario cierra el string. Ya pasó una vez.
- Si un test del dominio te estorba, el test tiene razón hasta que demuestres
  lo contrario. No lo borres.

## Cuando termines

Dejame un resumen corto en el chat con:
- cuántas lecciones y cuántas capturas bajaron, y la ruta de la carpeta
- qué selectores tuviste que cambiar y por qué
- qué falló y no pudiste arreglar

Guardá lo aprendido en engram con mem_save, project "albus_agent",
topic_key "albus/udemy-selectores-reales".
```

---

## Por qué el prompt dice "no largues la sección entera antes"

Porque el modo de fallar más caro es el silencioso. Si los selectores están mal
y se larga la sección completa, el agente pasa cuarenta minutos abriendo
lecciones y escribiendo archivos vacíos, y eso se descubre al volver. Con
`--limit 1` el mismo error cuesta un minuto.
