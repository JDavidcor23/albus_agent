# Contratos congelados

> **Ninguno de estos tira una excepción cuando lo rompés.**
>
> Si renombrás un símbolo mal, TypeScript te grita y perdés treinta segundos.
> Si cambiás uno de los VALORES de esta lista, todo compila, el hub arranca — y
> por debajo los agentes desaparecen de la lista, sus resultados quedan
> huérfanos o las reglas del usuario dejan de leerse. Nadie se entera el día
> que pasa.

**Podés renombrar el identificador que sostiene el valor. Nunca el valor.**

---

## 1. El disco del usuario

Hay DOS carpetas y la línea entre ellas es si el dato se puede regenerar
(`src/paths.ts`):

| | Ruta | Qué guarda |
|---|---|---|
| `dataDir()` | `Documents/albus_agent` | lo que se perdería para siempre: las reglas de cada agente y su cola de preguntas. `ALBUS_DATA_DIR` la mueve |
| `cacheDir()` | `%APPDATA%/albus-agent` | lo desechable: el log de cada corrida del hub |

| Valor congelado | Dónde | Qué se rompe en silencio |
|---|---|---|
| `albus_agent` (carpeta) | `paths.ts` → `DATA_FOLDER` | el hub arranca mirando una carpeta vacía: el agente corre sin las reglas del usuario |
| `'albus-agent'` | `paths.ts` → `APP_NAME` | los logs de corridas anteriores quedan en la carpeta vieja |
| `agents` (dentro de `albus_agent`) | `paths.ts` → `agentsDir()` | los `.md` de reglas se vuelven invisibles; a cada agente le llega un `AGENT_RULES_PATH` que no existe |
| `<id>.md` | `agents/rules.ts` → `rulesPath()` | lo mismo, agente por agente |
| `<id>.preguntas.json` y sus claves (`pregunta`, `contexto`, `creada`, `opciones`, `respuesta`, `respondida`) | `agents/questions.ts` | se pierde la cola de preguntas ya respondidas; el agente vuelve a preguntar lo mismo |

### El formato de las respuestas del agente

Estas dos cadenas son formato de archivo, no texto de UI:

| Valor congelado | Dónde | Qué se rompe |
|---|---|---|
| `'## Respuestas a lo que el agente preguntó'` | `agents/questions.ts` → `ANSWERS_SECTION_HEADING` | la sección se DUPLICA en cada archivo de reglas que ya existe |
| `- <respuesta>  <!-- respondiste el <fecha> a: <pregunta> -->` | escrito por `answerBlock()` en `agents/questions.ts`, leído por el parser de `agents/rules.ts` | las respuestas dejan de leerse. **Este bug ya pasó una vez** |

Las dos puntas —quien escribe y quien parsea— tienen que decir exactamente lo
mismo. Son dos archivos distintos y ahí está la trampa.

---

## 2. El hub de agentes

| Valor congelado | Dónde | Qué se rompe en silencio |
|---|---|---|
| `agents-hub` (carpeta, en Documents) | `core/hub/hub-location.ts` → `HUB_FOLDER` | todos los agentes y sus resultados quedan en la carpeta vieja; `hub list` los da por inexistentes. `ALBUS_AGENTS_HUB_DIR` la mueve |
| `agents`, `results` (dentro del hub) | `paths.ts` → `agentsCodeDir()`, `agentResultsDir()` | `agents` es de dónde se descubren; `results/<id>` es lo que el agente recibe como `AGENT_RESULTS_DIR`. Cambiado, el agente escribe en una carpeta nueva y vacía |
| `agent.json` | `hub/discover.ts`, `hub/install.ts` | es el contrato con cada agente, escrito en el monorepo `agents-hub`. Renombrado, ningún agente se reconoce |
| `protocol: 1` y el sobre `{ok,data} \| {ok,error}` | `core/hub/protocol.ts`, `agents-hub/shared/agent-call.ts` | los proveedores (`google`, `notion`, `whatsapp`) y sus consumidores dejan de entenderse. Ver `agent-services.md` |
| `ALBUS_AGENTS_HUB_DIR`, `AGENT_RESULTS_DIR`, `AGENT_RULES_PATH` (y `AGENT_CALLER`, que pone `agents-hub/shared/agent-call.ts`) | `core/hub/env.ts` | cada agente lee estas variables por nombre. Renombradas, escriben en el lugar equivocado sin error |
