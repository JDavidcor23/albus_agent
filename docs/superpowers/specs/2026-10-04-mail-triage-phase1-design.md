# mail-triage — Fase 1: descubrir la taxonomía y medir a Jev

> Diseño aprobado el 2026-10-04. Agente EXTERNO del hub (ver
> `.claude/docs/agents-hub.md`); este documento vive en Albus porque el repo
> del agente todavía no existe.

## El problema

Llegan 20-30 correos por día. Algunos importan (pagos, cobros, entrevistas),
otros quizás (alertas de empleo), otros no (promociones). No hay etiquetas
porque nadie sabe cuáles poner.

## La idea completa (tres fases; este spec cubre solo la 1)

| Fase | Qué hace |
|---|---|
| **1 (este spec)** | Opus descubre la taxonomía en 90 días de historial; se mide la precisión de Jev contra una verdad de referencia |
| 2 | Agente diario vía Orca: Jev clasifica todo, Opus resume lo `act_now` y lo de baja confianza. Reporte HTML en Albus |
| 3 | Lo de categoría pagos → base de gastos en Notion |

El patrón es *confidence-gated routing* (docs de TypeSafe): el modelo barato
decide, el caro solo entra donde hace falta. Es la regla de Albus "el escalón
caro va último".

## Jev: lo que hay que saber

- TypeSafe System One, modelo `jev-1.13.0` (alias `jev-latest`), SDK
  `@typesafe-ai/sdk` (Node ≥ 20), key en `TYPESAFE_API_KEY`.
- Devuelve decisiones tipadas + `probabilities` + `confidence` (0-1,
  concentración de la distribución). No explica ni escribe texto.
- `choice()`: una sola opción, hasta 255; criterios estructurados
  `{what, not_for, examples}`. Varias preguntas por request.
- Límites: 64k tokens por request, **32k para state + la pregunta más larga**.
  80 req/s, 100k tok/s, `429` si se pasa; los límites cambian dinámicamente.
- Precio: US$0,042 por millón de tokens de entrada; la salida es gratis.
- **Idioma principal: inglés.** Otros idiomas, con precisión reducida. Por eso
  esta fase mide antes de confiar.

## Decisiones

| Tema | Decisión | Descartado y por qué |
|---|---|---|
| Acceso a Gmail | OAuth propio del agente, solo `gmail.readonly` | `gmail.modify`: más permiso del que la fase necesita. IMAP con contraseña de aplicación: acceso total, no se puede limitar |
| Ejes de clasificación | Dos preguntas `choice()` en la misma llamada: `category` e `importance` (`act_now` / `read_later` / `ignore`) | Etiqueta combinada: multiplica las opciones. Importancia derivada de la categoría: no resuelve "quizás me interesa". Importancia por Opus: Opus leería todo cada día |
| Criterio de importancia | Lo escribe el usuario en el `.md` de reglas; Opus propone el primer borrador | — |
| Cómo se llama a Opus | CLI de Claude Code, **aislado** (`--setting-sources "" --strict-mcp-config --tools ""`), igual que `whatsapp-digest` | API de Anthropic: otra key y otra factura. Puerto con dos adaptadores: YAGNI |
| Historial para descubrir | 90 días, agrupados por remitente | 30 días: se pierden los cobros trimestrales. Muestra de 6 meses: muestreo complejo |
| Qué ve Opus al descubrir | `remitente + asunto + ~300 caracteres` | El cuerpo completo: quema cuota sin aportar a la taxonomía |
| Verdad de referencia | Opus etiqueta 150; el usuario corrige solo los desacuerdos Opus/Jev | Opus como verdad: mide concordancia, no precisión. Etiquetado manual: nadie lo termina |
| Idioma con Jev | Instrucciones y criterios en inglés; el correo va tal cual | Traducir el correo: un LLM por correo anula el sentido de Jev |
| Corregir desacuerdos | `npm run review` interactivo en la terminal → `review.json` | La cola de preguntas de Albus anexa las respuestas al `.md` de reglas (`questions.ts:167`): una etiqueta de evaluación no es una regla. JSON a mano: tedioso. El reporte HTML no sirve: Albus lo muestra con `sandbox=""` sin `allow-scripts` |
| Lenguaje | TypeScript + Node | Python: el hub solo acepta `npm`/`node` como comando; dos stacks |

## Estructura

Repo propio que vive directamente en el hub: `~/Documents/agents-hub/agents/mail-triage`.
Regla: todo agente vive físicamente en el hub, nunca en otra carpeta enlazada con `--link`.

```
mail-triage/
  agent.json                   id "mail-triage", needs: ["Gmail autorizado (npm run auth)", "Claude Code logueado"]
  src/features/
    gmail/       oauth (gmail.readonly) · fetch por rango · normalize → {id, from, subject, snippet, body}
    taxonomy/    discover: agrupa por remitente → Opus propone categorías + criterios de importancia
    classify/    Jev: 2 choice() por llamada → {category, importance} + confidence
    evaluate/    muestra estratificada · Opus etiqueta · Jev etiqueta · diff · reporte
    claude/      CLI aislado, copiado de whatsapp-digest/src/features/claude-handoff
  scripts/       auth · discover · evaluate · review · check
```

| Qué | Dónde |
|---|---|
| Token OAuth, `TYPESAFE_API_KEY` | `.env` y archivo de token del agente, ambos en `.gitignore` |
| Taxonomía + criterios de importancia | El `.md` de reglas (`AGENT_RULES_PATH`), en un bloque ```` ```yaml ```` validado con zod |
| Caché de correos, etiquetas de Opus/Jev, `review.json`, métricas | `AGENT_RESULTS_DIR`, JSON por id |
| Reportes | `.html` en `AGENT_RESULTS_DIR`: Albus los muestra sin cambios en Albus |

### El bloque de reglas

```yaml
draft: true            # discover lo escribe así; evaluate se niega a correr mientras siga en true
categories:
  payments:
    what: Receipts and charges for money the owner already paid
    not_for: Promotions that merely mention prices
    examples: ["Your Netflix receipt", "Comprobante de pago Bancolombia"]
importance:
  act_now:    { what: "...", examples: [...] }
  read_later: { what: "...", examples: [...] }
  ignore:     { what: "...", examples: [...] }
```

Si el bloque falta o no valida: código de salida 2, declarado en `exitCodes`
con un mensaje accionable. El agente nunca adivina la taxonomía. `discover`
solo reemplaza el bloque yaml: nunca toca el resto del `.md`, incluida la
sección de respuestas de Albus.

## Flujo

```
npm run auth        una vez: navegador → token gmail.readonly

npm run discover    Gmail (90 días) → caché por id (idempotente)
                    → agrupa por remitente → Opus en lotes de ~40 grupos
                    → escribe el bloque yaml con draft: true

npm run evaluate    exige draft: false
                    → muestra estratificada de 150 (tope por remitente)
                    → Opus etiqueta · Jev etiqueta (correo recortado para no pasar 32k tokens)
                    → aplica review.json si existe → métricas + reporte HTML

npm run review      terminal: cada desacuerdo sin revisar → elegir Opus / Jev / otra → review.json
```

`commands.run` en `agent.json` en esta fase es `npm run evaluate`.

## Errores

- **Por fila, no por lote**: un correo que falla queda `failed` con el motivo
  y el resto sigue.
- Reintentos con backoff solo ante `429` y errores de red, no ante `4xx` de
  validación.
- Cada etiqueta de Opus y de Jev se guarda por id de correo apenas llega: una
  corrida cortada no vuelve a pagar lo ya hecho.
- Eventos JSON lines del hub: `progress` por lote, `result` con la ruta del
  HTML, `error` ante un fallo.

## Pruebas

- `npm run check`: no gasta cuota. Verifica el token y su scope, el binario
  `claude`, `TYPESAFE_API_KEY` y la validez del yaml de reglas. Sale con
  código 2 si algo requiere a una persona.
- Tests del dominio puro con `node:test` vía `tsx`, sin red: agrupamiento por
  remitente, muestra estratificada, parseo y validación del yaml, recorte a
  32k tokens, diff, tramos de confianza. Gmail, Jev y Claude se inyectan como
  funciones para poder falsearlos.

## Criterio de éxito: la decisión que habilita la fase 2

Precisión medida contra la verdad corregida, por eje (`category`,
`importance`) y por tramo de `confidence` (`≥ 0.9`, `0.7–0.9`, `< 0.7`):

| Resultado | Decisión |
|---|---|
| ≥ 90% de acierto con `confidence ≥ 0.9`, y ese tramo cubre ≥ 50% de los correos | Fase 2 con Jev; Opus solo ve lo dudoso + `act_now` |
| `category` bien, `importance` mal | Jev pone la categoría; la importancia se decide con reglas por remitente o categoría |
| < 80% aun con confianza alta | Enriquecer `examples`/`not_for` y medir una vez más. Si no mejora: Jev no sirve para este correo en español, con evidencia |

## Fuera de alcance

Clasificación diaria, Orca, Notion, aplicar etiquetas en Gmail, desinstalar
del hub y cualquier cambio en el código de Albus.
