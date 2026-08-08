# La cascada de extracción

Albus lee las notas que **My Notes** (`../my_brain`) ya capturó y saca de ellas
información accionable: QRs, comprobantes de pago, perfiles, contactos.

El hueco que llena está declarado en el código de la otra app —
`my_brain/src/lib/types.ts:1-5` dice que `type` se guarda en `null` *"para que
un proceso posterior lo derive del texto"*. Ese proceso es este.

## El dato decide, no el programador

El orden importa y **cada escalón es más caro que el anterior**. Se corta apenas
uno resuelve.

| # | Qué | Con qué | Costo |
|---|---|---|---|
| 1 | ¿Tiene QR? | `jsqr` (`core/extraction/qr.ts`) | gratis, milisegundos |
| 2 | ¿Qué dice? | `tesseract.js` (`ocr.ts`) | gratis, segundos |
| 3 | ¿Matchea un patrón conocido? | regex puro (`patterns.ts`) | gratis, instantáneo |
| 4 | Clasificá vos | CLI headless (`llm-classify.ts`) | **cuota del usuario** |

`cascade.ts` orquesta los escalones. `worker.ts` corre el lote.

**No elijas el extractor por adelantado.** No existe "el extractor de QR" —
existe una cascada que prueba todo lo barato y deja que el resultado decida qué
era la imagen.

El escalón 4 gasta la misma cuota que el usuario necesita para trabajar. Que sea
el último no es una optimización: es la regla.

### La cascada nunca propaga excepciones

Un item que falla se escribe con `kind: 'failed'` y el worker sigue. Un solo
archivo ilegible no puede frenar un lote de 48.

### Idempotencia por esquema, no por flag

El unique `(entry_id, attachment_path)` en `extractions` (migración 0001) es lo
que hace que reprocesar sea seguro. `attachment_path` es `not null default ''`
justamente para que ese unique funcione sin `NULLS NOT DISTINCT`.

**No agregues una columna `processed`.** Un flag se desincroniza; una restricción
de esquema no.

## Limpiar el OCR antes de que lo vea el modelo

`core/extraction/clean-ocr.ts` — `cleanOcr`, `isReadable`, `keepsEnough`,
`isCameraPhoto`, `mergeScreenshots`.

Existe porque antes se le pasaba al modelo el OCR crudo y el ciphertext completo
del QR: recibía la barra de estado del celular (`9:14 új -- all = ED +`) y 120
caracteres de base64 cifrado como si fueran contexto. Un modelo no puede resumir
bien lo que se le entrega sucio, y limpiarlo no cuesta nada — son las mismas
reglas que ya usa la UI para decidir si mostrar el texto.

## El archivo en Drive

`core/extraction/archive.ts` decide la carpeta (`decideArchive`), `drive/archive.ts`
la resuelve y sube. Los cinco nombres de carpeta y las tres `appProperties`
(`albusKey`, `albusKind`, `albusEntry`) están **congelados** — ver
`frozen-contracts.md` §3. `drive/archive.ts` se autorepara creando la carpeta si
no la encuentra, que es exactamente lo que convierte un rename en un split-brain
silencioso.

## El grafo (`core/graph/`)

`build.ts` manda las extracciones al CLI en lotes de **8**. Una por item serían
48 llamadas y 48 veces la cuota; además el modelo relaciona mejor viendo varias
juntas. `merge.ts` fusiona contribuciones de lotes distintos sobre el mismo nodo.

Las etiquetas de arista (`trabaja_en`, `conoci_en`, `organiza`, `pagado_a`,
`trata_de`, `enlaza_a`) **se persisten en `graph.json`** y están congeladas.

`graph/store.ts` guarda el archivo en el **Escritorio del usuario**, no en el
repo ni en la nube: es un artefacto suyo, que puede abrir y llevarse.
`ALBUS_GRAPH_DIR` lo mueve sin tocar código.

## Los pendientes (`core/tasks/`)

`detect.ts` saca pendientes del texto ya limpio. `ask.ts` interpreta lo que el
usuario escribe en el chat (`interpret` → `Intent` con
`'tasks' | 'close' | 'ambiguous' | 'help'`) y arma la respuesta (`compose`).
`qr-identity.ts` decide si un QR es descifrable y cómo etiquetarlo.

## Reglas de datos que valen para toda la extracción

- **Todo lo que vuelve de Supabase es input externo.** Validalo con zod. En
  particular el array `attachments`, que es `jsonb` sin esquema.
- **Validá por fila, no por lote.** Un `.parse()` sobre un array entero convierte
  un registro corrupto en cero progreso para siempre. `safeParse` por elemento y
  salteá el que falla.
- **Nada de colas que se tapan.** Cualquier query de "pendientes" tiene que poder
  alcanzar los registros viejos. Un `order desc` + `limit` fijo deja de devolver
  resultados en cuanto los primeros N están procesados, y los de atrás no se
  alcanzan nunca.
