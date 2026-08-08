# Notion es el espejo, el CSV es la fuente

Base "Registro de aplicaciones". El CSV de `ai-job-search` sigue siendo la fuente
de verdad del usuario; Notion es donde la mira.

## Reglas que no se rompen

- **Upsert por `post link`, nunca insert.** La misma vacante se toca varias veces
  (Backlog hoy, Applying mañana); insertando siempre, la base termina con tres
  filas de la misma empresa y el seguimiento —lo único para lo que sirve— se
  rompe. `notion/applications.ts` busca primero por esa propiedad y recién ahí
  decide crear o actualizar.
- **El mapeo de estados es total y cerrado.** Un `Status` que no existe hace que
  Notion cree la opción sola: de golpe hay siete estados y los filtros del usuario
  dejan de servir. `notionStatus()` en `core/jobs/notion-map.ts` devuelve `null`
  antes que inventar una, y el llamador no escribe la fila.
- **Nada de PII del candidato.** `scrubPii()` tacha su mail y su teléfono en todas
  las formas (con código de país, con espacios, con guiones) — y **de más largo a
  más corto**: reemplazar `3003073883` antes que `+573003073883` deja el `+57`
  suelto.
- **Token de integración interna, no el MCP.** El MCP de Claude Code sirve para
  que un humano lea la base en una conversación. Albus tiene que poder escribir a
  las 7 de la mañana sin nadie mirando.

Los nombres de propiedad y de opción están **congelados** — ver
`frozen-contracts.md` §2. Sí, algunos están en español (`'Descartada'`,
`'Próxima acción'`): son los nombres que el usuario le puso a su base con el
mouse.

## El triage no rellena el lote

`applyFloor()` en `core/jobs/rank.ts` es puro y **no recorta a tres**. Si califican
dos, devuelve dos.

Rellenar hasta el número con fits flojos es lo que hace que uno mande veinte
postulaciones y no le contesten ninguna. `QUALITY_FLOOR = 65` y ningún corte duro
por cantidad. `Sieve` devuelve `{ qualified, rejected }`.

`HARD_GATES` son los filtros duros previos al puntaje. `rankJobs()` manda las
candidatas al CLI con `MAX_DESC = 1400` caracteres de descripción por vacante:
más que eso es pagar cuota por texto de plantilla legal.

## La búsqueda no se reimplementa

`ai-job-search` ya tiene seis CLIs de portales con su parser de HTML.
`jobs/search.ts` los ejecuta con `bun`. Cuando LinkedIn cambie el markup se
arregla en un solo lugar, que además es el que el usuario ya sabe mantener.

- **Cuatro en paralelo, no más.** Un spawn de `bun` por vacante en serie son 106
  segundos; cuatro en paralelo lo bajan a ~70. Más de cuatro es parecerle un
  scraper agresivo a LinkedIn.
- `dedupeKey()` y `DedupeSources` cruzan lo nuevo contra `seen_jobs.json` del
  workspace (archivo y clave congelados). `dedupe()` devuelve
  `{ unseen, duplicates }`.

## El CSV

`jobs/tracker.ts`. Trece columnas, RFC 4180 (comillas solo cuando hacen falta,
las internas duplicadas). Los headers están congelados y `'source'` es además la
clave de deduplicación.

## `hunt.ts` y el progreso

`jobs/hunt.ts` encadena buscar → deduplicar → puntuar → cribar → escribir en
Notion, y reporta por `onProgress(phase, detail)`.

**Las fases siguen en español** (`'buscando'`, `'puntuando'`, `'criba'`…) y está
bien: `HuntProgress.phase` es un `string` libre que se pinta en la UI, no una
unión sobre la que alguien haga `switch`. Parece un enum y no lo es.
