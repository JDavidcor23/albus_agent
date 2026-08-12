# Rediseño del shell de Albus

Fecha: 2026-08-12 · Estado: aprobado en conversación, sin implementar

## Qué es esto

Albus deja de ser cuatro pestañas hermanas y pasa a ser **una conversación con
un rail al costado**. Además: la app pasa a inglés, las conexiones salen de
adentro del agente de trabajo y se vuelven configuración de la app, el selector
de CLI deja de ser una sopa de texto, y el panel izquierdo deja de desbordarse
en pantallas chicas.

Esto es el **proyecto A**. Existe un proyecto B —el motor de memoria— que se
especifica aparte y que necesita que A exista primero.

## Por qué

Dos superficies de la app ya derivaron a chat sin que nadie lo planeara:
`JobChat.tsx` lo dice en su propio comentario (*"Chat y no formulario: el agente
se maneja hablándole"*) y la pestaña `pendientes` es `ChatPanel`. Cuando el
código se mueve solo hacia una forma, esa suele ser la forma.

El destino declarado del producto —le mandás algo, Albus pregunta qué hacer y la
segunda vez ya no pregunta— es conversacional. El shell tiene que serlo antes de
que se pueda construir esa lógica, porque el chat **es** la superficie donde
Albus pregunta y avisa.

## Fuera de alcance (proyecto B)

- Cascada de reconocimiento ("esto ya lo hicimos antes")
- Decisiones del usuario que se vuelven reglas permanentes
- Flujos aprendidos, y sus modos `dry-run` / `review` / `auto`
- Cualquier router de intención

A no incluye nada que decida por el usuario. A mueve muebles.

## La regla que gobierna todo el cambio

**Se traduce lo que el usuario LEE. No se toca ningún valor que el sistema
COMPARA.**

Los contratos congelados de este proyecto son, casi todos, strings en español:

| Valor | Dónde |
|---|---|
| `'pagos'`, `'qr-eventos'`, `'contactos'`, `'info'`, `'sin-clasificar'` | carpetas de Drive |
| `'post link'` y todo nombre de propiedad u opción de Notion | upsert de Notion |
| `trabaja_en`, `conoci_en`, `organiza`, `pagado_a`, `trata_de`, `enlaza_a` | tipos de arista del grafo |
| `'## Respuestas a lo que el agente preguntó'` y el formato de su viñeta | archivo de reglas |
| `albus_agent/`, `agents/`, `graphify/`, `albus.yml`, `connections.json`, `<id>.agente.json`, `<id>.preguntas.json` | estado en disco |
| `'albus-agent'` (`userData`), `'persist:albus-jobs'` | partición del navegador |
| los 13 headers de `COLUMNS`, `albus-profile.json`, `seen_jobs.json` | contrato del workspace |

Traducir cualquiera de estos **no tira un error**. Lo que pasa es: Drive crea
carpetas nuevas vacías y abandona los archivos viejos, Notion inventa columnas
y opciones, el grafo se parte en aristas viejas y nuevas, las respuestas ya
dadas al agente desaparecen de la pantalla, y hay que volver a loguearse en
LinkedIn y Google.

Quedan en español para siempre, aunque queden raros en un código en inglés. Son
dato, no copy. El detalle de cada uno está en `.claude/docs/frozen-contracts.md`.

## El shell

```
┌────────────────┬─────────────────────────────┐
│ Albus          │                             │
│ your agents,   │                             │
│ one conversation│      conversación          │
│                │                             │
│ ▸ Chat         │                             │
│                │                             │
│ ──────         │                             │
│ Extractions    │                             │
│ Graph          │  ─────────────────────────  │
│ Tasks          │  [ input                 ]  │
│                │                             │
│ ──────         │                             │
│ Claude Code    │                             │
│ opus-5      ⚙  │                             │
└────────────────┴─────────────────────────────┘
```

### Qué renderiza cada entrada del rail

| Rail | Componente hoy | Cambia |
|---|---|---|
| **Chat** (principal) | `AgentsPanel` — tarjetas de agente, preguntas, reglas y `JobChat` | ya no es una pestaña entre cuatro: es la superficie por defecto |
| Extractions | `ResultsFeed` | recibe `procesar lote` y `reprocesar todo` |
| Graph | `GraphView` | sin cambios funcionales |
| Tasks | `ChatPanel` | sin cambios funcionales |
| Settings | nuevo | `ConnectionsPanel` + `CliPicker` rediseñado |

**Chat en A NO es todavía el buzón unificado** donde le mandás cualquier cosa y
Albus pregunta qué hacer. Eso es B. En A, Chat es la conversación con tus
agentes, que es lo que ese componente ya hace.

**Desviación deliberada.** Se acordó que Extractions y Graph fueran destinos que
se abren *desde la conversación*, no entradas de navegación. No se puede hacer
solo eso todavía: la lógica que decide ofrecerlas es proyecto B, y sin ella
quedarían inalcanzables. Entran al rail en un grupo secundario, visualmente más
liviano que Chat. Cuando B exista, la conversación también las ofrece y el rail
puede perderlas.

## Qué se mueve

| Qué | De dónde | A dónde | Por qué |
|---|---|---|---|
| `procesar lote`, `reprocesar todo` | `LeftPanel` | vista **Extractions** | son controles del worker de extracción, no identidad de la app |
| `CliPicker` | `LeftPanel` | **Settings** | es configuración global |
| `ConnectionsPanel` | dentro de `JobChat` | **Settings** | Google, Drive y Notion son de la app, no del agente de trabajo |
| modelo activo | — | línea de estado en el rail | para no abrir Settings solo para saber con qué está corriendo |

### El selector de CLI

Se rediseña la **forma**, no el dato. Hoy se pinta como texto separado por
puntos (`claude code · haiku · sonnet · …`) y se lee como ruido.

Pasa a ser: proveedor detectado + selector de modelo, cada uno con su etiqueta.

**No se hardcodea "Claude Code".** `CliPicker` enumera lo que hay en el PATH;
hoy aparece uno solo porque hay uno solo instalado. Hardcodearlo rompe el diseño
multi-proveedor sin avisar.

## El scroll

Tres causas concretas:

- `.panel-left` no tiene `overflow-y` — el contenido que no entra no se alcanza
- `html, body, #root` tienen `overflow: hidden`
- `.app-container` tiene `padding: 2.5rem` y `gap: 3rem` fijos

Arreglo: `overflow-y: auto` + `min-height: 0` en el rail, `padding` y `gap` con
`clamp()`, y `min-height: 0` en el área de conversación para que su hijo con
scroll resuelva altura.

## Verificación

- `npm run typecheck` — **el** gate. No hay linter ni test runner.
- `npm run ui:selftest` — la pestaña de agentes contra el DOM real.
- No se escriben tests. El proyecto no tiene runner y no se pidieron.

## Archivos que se tocan

- `src/renderer/**` — el shell, Settings, el picker, las vistas
- `src/renderer/src/assets/main.css` — hoja única
- `src/main/**` — solo los strings en español que el usuario lee (mensajes de
  error, avisos, ejemplos de reglas). Ningún cambio de comportamiento.
- `CLAUDE.md` — hoy dice *"comentarios y copy de UI en español. Deliberado."*
  Pasa a decir lo contrario, en el **mismo commit**. Sin eso, el próximo agente
  que toque el repo revierte la traducción sin preguntar.

**A no cambia ningún canal de IPC.** `listConnections`, `listCliProviders` y
`refreshCliProviders` ya existen en el preload. Si durante la implementación
aparece la necesidad de un canal nuevo, `src/shared/ipc.ts`, `src/preload/index.ts`
y `src/main/ipc/*.ts` se mueven juntos, en un commit — es el único agujero de
verificación del proyecto.

## Riesgos

1. **Traducir un contrato congelado.** El de arriba. Mitigación: la tabla de
   valores prohibidos es parte del spec y se revisa contra el diff.
2. **`CLAUDE.md` fuera de sincronía.** Mitigación: mismo commit.
3. **Vistas huérfanas.** Si Extractions o Graph pierden su entrada del rail antes
   de que B las ofrezca, dejan de ser alcanzables. Mitigación: la desviación
   deliberada de más arriba.

## Conflicto con el roadmap — registrado, no resuelto

`docs/ROADMAP.md` declara la restricción del proyecto: *"necesita generar dinero
ya… construir Albus no genera plata. Ahorra tiempo."* Y dice que de todas las
ramas **solo una toca el ingreso**: la pila de ofertas de LinkedIn.

Este rediseño no toca el ingreso. Mejora el uso diario y desbloquea el proyecto
B, pero contra la restricción escrita en el propio roadmap, es tiempo que no va
al cheque. Queda escrito para que la decisión sea consciente y no por olvido,
que es el criterio que ya usa la sección "Objeciones registradas" de ese archivo.
