# Albus es un contenedor de agentes

> Estos son los agentes de **Albus** (`src/main/agents/`), no los subagentes de
> Claude Code de `.claude/agents/`. La colisión de nombre es deliberada — ver
> `architecture.md`.

No es "la app que extrae datos de notas": es donde viven los agentes del usuario.
Hoy hay uno (`job-search`, búsqueda de trabajo); vienen gastos, contenido para
LinkedIn y lo que se le ocurra.

Por eso el registro es una **lista**, no un `if`:

- `src/main/agents/registry.ts` → `AGENTS` — una entrada por agente, con su
  propio `check()` de dependencias. Un agente al que le falta una credencial se
  pinta **apagado con el motivo**, no desaparece: un agente que se esconde es un
  agente que el usuario cree que nunca existió.
- `renderer/src/components/AgentsPanel.tsx` — mapa `id → componente`.

**Sumar un agente = una entrada en el registro + un componente.** No se toca el
shell, ni la navegación, ni los otros agentes.

El `check()` de `job-search` es un buen ejemplo de la línea correcta: si falta el
perfil devuelve `available: false` con el motivo; si falta Notion, LinkedIn o
Google devuelve `available: true` con `reason: 'sin conectar: …'`. **Sin Notion se
puede buscar y postular, solo que no se espeja.** Apagarlo entero sería exagerado.

## Las preguntas del agente se vuelven reglas

El usuario nunca va a escribir todas las reglas de antemano, y las dudas
aparecen a las 7 de la mañana cuando no hay nadie mirando. Entonces: **el agente
no inventa, encola la pregunta y sigue con lo que sí puede.** El usuario contesta
en la app y la respuesta se **anexa al `.md`** como una regla más.

Ese es todo el mecanismo de aprendizaje, y es a propósito que sea tan aburrido:
la memoria del agente es un archivo de texto que se puede abrir, leer, corregir y
borrar. Una "memoria" que solo el programa entiende es una que el usuario no
puede auditar el día que el agente haga algo raro.

`agents/questions.ts`:

- La cola vive en `userData/agentes/<id>.preguntas.json`. **JSON y no markdown
  porque es una COLA**, no algo que se edite a mano.
- **La misma duda dos veces es UNA pregunta.** Veinte postulaciones con el mismo
  campo sin resolver llenarían el panel y el usuario lo abandonaría.
- La respuesta se anexa como **viñeta** (para que el resumen la lea como regla)
  con la pregunta original en un **comentario** al lado, para acordarse en marzo
  de por qué está escrita. Lo arma `answerBlock()`.
- Eso obligó a arreglar el parser: un comentario que abre y cierra en la MISMA
  línea **se recorta, no descarta la línea**. Antes el usuario respondía y no veía
  nada cambiar.
- `agentRules()` (en `registry.ts`) repite lo ya respondido al final, bajo su
  propio título: es lo último que el agente lee antes de decidir, y son justo las
  reglas que nacieron de una duda suya.

### El split disco ↔ cable

`*.preguntas.json` guarda las claves `pregunta, contexto, creada, opciones,
respuesta, respondida` — **en español y congeladas**, porque están escritas en la
máquina del usuario. El tipo que cruza IPC, `AgentQuestion`, tiene campos en
inglés.

`questions.ts` mantiene `StoredQuestion` con las claves de disco y **mapea** con
`toAgentQuestion()` al salir. Esas seis claves españolas existen en **exactamente
un archivo**. Que siga así.

## Las reglas de un agente son un `.md`, no una pantalla

Cada agente puede declarar un `rulesTemplate`, y el usuario edita
`userData/agentes/<id>.md` para decirle qué mirar. Pedido textual: *"hagamos un
MD y yo pongo las rutas"*.

El motivo de fondo: con una pantalla de configuración, **agregar una regla nueva
es trabajo de UI**. Con un archivo, es escribir una línea. Y como el agente
recibe el markdown ENTERO como contexto, entiende reglas que nadie programó —
"nada con Java" funciona sin que exista un campo `excluirLenguajes`.

**Solo se parsean los links.** El código necesita una cosa concreta: a qué base
de Notion escribir. Todo lo demás queda como texto. Parsear más sería inventar un
formato que el usuario tiene que aprender, que es justo lo que este archivo viene
a evitar.

`agents/rules.ts`:

- El id de Notion se saca con el patrón UUID **exacto** (8-4-4-4-12), no con
  `[0-9a-f-]{36}`: en `notion.so/otra-1234abcd-…` la `a` de "otra" también es hex,
  y el patrón laxo devolvía un id corrido por una letra.
- Los links dentro de `<!-- -->` **se ignoran**. Sin eso, la plantilla recién
  creada se autoconfigura sola apuntando a una base de ceros.
- El **primero** de la lista es el que se usa. Un orden que dependa de en qué
  sección quedó el link sería impredecible.
- `notionDatabaseId()` (en `notion/client.ts`) sale de ahí, no de una constante.
  `DEFAULT_DATABASE_ID` queda como red: un id hardcodeado solo funciona en UNA
  cuenta.
- La UI recarga al **volver el foco** a la ventana: el usuario edita el archivo en
  su editor, y sin eso vuelve y sigue viendo "no apunta a ningún lado".

## Dónde vive el estado del usuario

`src/main/paths.ts`. La regla, sin excepciones: **lo que el usuario escribe o la
app genera va a `userData`. El repo tiene código, no estado.**

Existe porque las reglas y `albus.yml` se escribían en el directorio del proyecto
cuando la app corría en desarrollo. Reclamo del usuario, y es correcto: *"si algún
día yo quiero sacar esto, literalmente se va a guardar en el código fuente"*.

Fuera de Electron —`npx tsx scripts/…`— `dataDir()` calcula la MISMA ruta a mano,
no una carpeta del repo. Si apuntaran a lugares distintos, `notion:check` leería
un `albus.yml` vacío mientras la app usa uno con el token adentro, y el
diagnóstico diría "no hay token" sobre una conexión que funciona.

La consecuencia buena: desinstalar la app no borra tus reglas, actualizarla
tampoco, y un `git clean -xdf` deja de ser una forma de perder la configuración.
