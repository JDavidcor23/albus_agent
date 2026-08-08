# Conexiones: navegador o pegar, nunca la terminal

Un servicio se conecta desde la pestaña de agentes, no editando el `.env`. Cada
uno ofrece lo que puede: Google y LinkedIn abren una ventana y listo; Notion, que
para una integración interna solo da un token, lo saca Albus solo del navegador
—y deja el campo para pegarlo como red de contención.

## UN motor, no un archivo por servicio

Esto es lo que más importa de toda la sección. **No existe `notion-auto.ts`, ni va
a existir `supabase-auto.ts`.** Existió: 459 líneas con los pasos de Notion a
mano. Servía para Notion y para nada más, y cada servicio nuevo era escribirlo
todo de vuelta.

Un servicio conectable es **una fila de datos** en `connections/services.ts`:

```ts
{ id, name, url, goals: ['crear un token y hacerlo visible'], secretPattern: 'sbp_…' }
```

Y nada más. Sin función, sin archivo, sin `if`. El agente ya sabe navegar un panel
de credenciales —es lo que hace todo el día—; lo único que necesita saber es
adónde ir, qué lograr, y cómo se ve la credencial cuando aparece. Supabase ya está
en esa tabla como prueba de que el diseño aguanta.

`connections/connection-agent.ts` es el motor (`connectWithAgent`), y **no nombra
a Notion en su lógica** — hay un assert que lo verifica.

**Un objetivo dice QUÉ tiene que ser verdad al terminar, no qué botón apretar.**
"Crear un token llamado Albus y hacerlo visible" sobrevive a un rediseño; "apretá
el botón azul de arriba" no. Un objetivo con un selector adentro es código
disfrazado de dato, y hay un assert que lo rechaza.

Y conviene decir explícitamente cuándo NO está cumplido: **un formulario lleno
pero sin confirmar es el error más caro**, porque parece que avanzó.

## El agente MIRA la página; no adivina strings

Automatizar la UI de un tercero con `clickText(['new integration'])` es apostar a
que el botón siga diciendo eso. Se perdió dos veces:

1. `no encontré new integration` — Notion renombró el botón.
2. Peor: `clickeé "Created"`. Buscando `create` con `includes()`, ganó el `<th>`
   **encabezado de columna** de la tabla de atrás, y `clickText` devolvió **ok**.
   Un falso positivo es peor que no encontrar nada: el que llama cree que avanzó y
   **se saltea el escalón del agente**. Por eso los encabezados de tabla no entran
   ni al inventario ni al click, y el match va por precisión (exacto >
   empieza-con > contiene).

Y hay casos que un click por texto no puede resolver **ni en principio**: el `⋯`
de Notion no tiene una sola letra adentro, solo un `aria-label`.

`browser/page-scripts.ts` → `INVENTORY`: cada elemento clickeable con su texto,
aria-label, rol y **coordenadas** — las coordenadas son lo que cruza la lista con
la captura. Es lo único que sigue siendo JavaScript, y se escribe **una vez** para
cualquier página del mundo: es la vista del agente, no "el scraper de Notion".

### `cursor: pointer` es la señal, no la lista de selectores

El inventario buscaba `[onclick]` y `[tabindex]`. **React no pone ninguno de los
dos**: registra los handlers por delegación y no deja rastro en el DOM. En Notion,
la FILA de una integración no tiene `tabindex`, ni `onclick`, ni `role` — el
agente reportaba *"aparece en el texto de la página pero su fila no está en el
inventario"*, y tenía razón.

Enumerar selectores no termina nunca: siempre falta uno. Lo que **sí** deja toda
SPA es `cursor: pointer`, porque lo necesita para verse bien. Es la misma señal
que usa un humano para saber que algo se aprieta, y ningún framework la puede
evitar.

- Se toma **el más externo** de cada grupo: una fila con tres celdas es UNA cosa
  clickeable, no cuatro. Se saltea todo lo que tenga un ancestro ya marcado (el
  recorrido va en orden de documento, así que alcanza).
- Nada que ocupe **más del 60% de la pantalla**: ese es el wrapper de la app, no
  un control, y si entrara taparía todo lo de adentro.
- La etiqueta **hereda del ancestro** (hasta 3 niveles): un menú de tres puntos es
  un div con `aria-label` que adentro tiene un span con `···`. Leyendo solo el
  span queda un item que dice "···" y nada más.
- **`innerText`, no `textContent`.** `textContent` pega todo sin respirar: la fila
  de una integración salía como `AAlbus AgentRead, update, and insertJorge Diaz's
  Notion` — una palabra ilegible donde había cuatro columnas. `innerText` da el
  texto **como se ve**, y esos saltos se convierten en ` · `. Cuesta un reflow y
  vale lo que cuesta: de esto depende que quien elige entienda qué está eligiendo.
- El recorte final es **por cercanía a la pantalla**, no por orden en el DOM — el
  botón que importa suele estar después de todo el menú lateral. Y si algo quedó
  afuera, `truncated: true` se lo dice al agente: un inventario truncado en
  silencio hace que concluya "eso no existe" sobre algo que sí está.

### Navegar NO es una acción del agente

El agente solo puede elegir elementos del inventario. Un objetivo que dice *"Ir a
https://… y darle acceso"* le pide algo fuera de su repertorio, y contesta —con
razón— *"ningún elemento listado permite navegar a esa página"*.

Por eso un objetivo puede declarar su `url`, y **navega el motor**:

```ts
{ url: `https://www.notion.so/${id}`, what: 'Darle acceso a ESTA página a …' }
```

Se queda del lado del motor a propósito: darle al agente una acción "navegá a esta
URL" sería dejarlo elegir a dónde ir. Acá el destino sale de la tabla de
servicios, que es un dato que escribimos nosotros. Hay un assert que rechaza
cualquier objetivo con un "ir a http…" adentro del texto.

### El bucle: mirar → actuar → volver a mirar

`connections/navigate-llm.ts` → `achieveGoal()`.

Un objetivo casi nunca es una acción: "crear la integración" es escribir el nombre
**y apretar el botón que confirma**. Con un solo tiro, el nombre queda escrito, el
modal abierto, y el paso siguiente sale a buscar un token que no existe. Pasó,
textual.

- **El historial no es un lujo.** Cada vuelta se le cuenta al agente lo que ya
  hizo. Sin eso vuelve a elegir el mismo botón para siempre: la pantalla apenas
  cambió, así que su mejor decisión es la misma.
- **El agente devuelve un `cid` de una lista que armamos nosotros, nunca un
  selector ni JavaScript.** Un id inventado se rechaza antes de tocar la página;
  un elemento deshabilitado no se aprieta; `done` e `impossible` cierran el bucle
  —y `impossible` **no se reintenta**, porque la pantalla no va a cambiar sola.
- El enum de acciones es `'click' | 'type' | 'done' | 'impossible' | 'none'`, y
  `'type'` está acoplado a lo que emite `INVENTORY` desde adentro de la página.
  Tres archivos tienen que decir lo mismo — ver `frozen-contracts.md` §7.

**En conexiones el agente va PRIMERO, no lo barato.** La cascada existe para lotes
de 48 imágenes donde los tokens se multiplican; conectar un servicio pasa una vez
cada varios meses. Ahorrar cinco llamadas ahí no le mueve la cuota a nadie, y el
precio de equivocarse es que se rompe el flujo entero.

Se verifica con `npm run nav:check` contra fixtures que reproducen los dos bugs
reales: el botón renombrado y el `<th>Created</th>`.

## Hay credenciales que no se pueden VER, solo copiar

Notion muestra "Integration token" con el valor enmascarado y un botón de copiar.
Leyendo solo el DOM, el flujo llegaba a la pantalla correcta y volvía con las
manos vacías: *"no aparece en la página"* sobre la página que lo tenía.

Por eso `connection-agent.ts` busca en la pantalla **y en el portapapeles**, y
"apretá Copy" es una acción legítima del agente. El portapapeles se **vacía al
empezar** —si no, se guardaría algo que el usuario copió hace media hora— y lo que
tenía se le devuelve al terminar.

Si después de todos los objetivos no hay credencial, el motor lanza un objetivo de
**rescate** que dice explícitamente "si solo hay un botón de copiar, apretá ese".
Va en el motor y no en cada servicio: es la misma necesidad para todos.

## Conectar se mira, no se adivina

`connections:browser` es un `invoke`: no contesta hasta terminar, y eso pueden ser
minutos. Los pasos existían pero morían en un `console.log` del main, así que la
UI se quedaba muda y el usuario no podía distinguir "trabajando" de "colgado" —
que es exactamente lo que pasó. Cada paso sale por `IpcEvents.CONNECTIONS_STEP`
mientras ocurre, con una miniatura de la pantalla.

**La miniatura viaja en `data:`, no como ruta.** El CSP del renderer es
`img-src 'self' data:` y un `file://` se bloquea sin decir por qué. Y es JPEG: una
captura con texto pesa 4-5 veces más en PNG, y esto va por IPC en cada paso.

## `albus.yml`: un solo archivo de llaves

Las credenciales viven en **`albus.yml`**, dentro de `userData` — como un `.env`
pero con otro nombre, por pedido explícito del usuario: tiene el `.env` bloqueado
para los agentes y necesita un archivo que la app y quien la ayude puedan leer y
escribir.

| # | Se lee de | Quién escribe |
|---|---|---|
| 1 | `albus.yml` | la app y el usuario a mano |
| 2 | `connections.json` cifrado | legado: se lee, ya no se escribe |
| 3 | `.env` | quien lo configuró así |

**Se escribe siempre en `albus.yml`, y por eso también es el primero al leer**: si
el usuario lo editó hace treinta segundos, tiene que ganar. Las llaves usan los
nombres del `.env` (`notion.token` → `NOTION_TOKEN`, vía `ymlKey()`) para que
copiar de uno al otro no requiera traducir nada.

**El precio, dicho de frente:** es TEXTO PLANO. Lo anterior cifraba con
`safeStorage` (DPAPI), que ata el secreto a la cuenta de Windows — copiado a otra
máquina no servía. Un `.yml` sí sirve. Por eso está en el `.gitignore` y hay un
assert que lo verifica. Fue una decisión de producto tomada con el riesgo sobre la
mesa, no un descuido.

El parser es propio, de veinte líneas: lo que se guarda es `CLAVE: valor`. Traer
`js-yaml` —anclas, listas, multilínea— para eso es superficie de ataque gratis en
el proceso que tiene el service role key. Hay un assert que lo prohíbe.

## Reglas del secreto

- **El secreto viaja del renderer al main una sola vez y nunca vuelve.** La UI sabe
  SI hay token, jamás cuál — uno que la UI puede leer termina en un log de React.
- **Lo guardado GANA sobre el `.env`**: es lo último que el usuario tocó.
- `notion/client.ts` y `drive/client.ts` **no importan electron**: exponen un
  `setXTokenResolver()` que por defecto lee el entorno, y `main/index.ts` lo pisa
  al arrancar. Sin eso, los chequeos con `npx tsx` no podrían importarlos.

## Diagnóstico

### `npm run notion:check`

Cuando la UI dice una cosa y el log dice otra, responde la única pregunta que
importa: **¿la API contesta?** Separa los dos casos que se ven iguales desde afuera
y se arreglan distinto — token rechazado (401) vs. base no compartida (404) — y
para el 404 imprime el arreglo manual de diez segundos. No abre navegador, no
gasta cuota, no escribe nada.

### `npm run nav:inspect -- <url>`

Cuando algo falle con "eso no está en la página", hay dos culpables que se
parecen: el agente eligió mal, o el inventario nunca se lo mostró. Este comando
abre la URL con la misma sesión, imprime el inventario **tal cual lo recibe el
agente**, y marca aparte lo que está en el texto **pero no tiene id** — que es
exactamente el síntoma. No clickea, no escribe, no gasta cuota.
