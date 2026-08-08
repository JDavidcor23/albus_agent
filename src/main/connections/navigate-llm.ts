import { z } from 'zod'
import type { BrowserPort, Inventory } from '../core/jobs/ports'

/**
 * El escalón 4 de la cascada, aplicado a manejar la UI de otro.
 *
 * ## El problema que resuelve
 *
 * Automatizar Notion con `clickText(['new integration'])` es apostar a que el
 * botón siga diciendo eso. El día que le cambien el texto —o que lo escondan
 * atrás de un menú, o que agreguen un paso de "elegí el workspace"— la
 * automatización se cae y no hay nada que hacer salvo editar la lista de
 * strings a mano. Eso ya pasó: el paso "abrir el formulario" murió con
 * `no encontré new integration`.
 *
 * Acá el objetivo se declara en castellano —"creá una integración nueva"— y el
 * modelo MIRA la página para decidir qué apretar. Si Notion renombra el botón,
 * el modelo lo reconoce igual, porque reconoce la INTENCIÓN, no el string.
 *
 * ## Qué ve el modelo
 *
 * 1. El inventario: cada elemento clickeable con su texto, rol y coordenadas.
 * 2. El texto visible de la página, para el contexto.
 * 3. La captura de pantalla, por ruta. El CLI la abre con su propia lectura de
 *    imágenes. Si no puede, el inventario alcanza — no es un requisito duro.
 *
 * ## Qué devuelve
 *
 * Un `cid` de la lista que le dimos, o `null`. **Nunca un selector, nunca
 * JavaScript, nunca una acción.** El ejecutor sigue siendo determinista: eso
 * es lo que hace que un modelo alucinado no pueda clickear "borrar workspace".
 * Un `cid` que no esté en el inventario se rechaza antes de tocar la página.
 *
 * ## Las claves del JSON y el prompt son UNA sola cosa
 *
 * El esquema de acá abajo y el bloque `{"cid":…}` del prompt se editan juntos,
 * siempre. Un cambio en uno solo no lo agarra el typecheck: revienta en tiempo
 * de ejecución como un error de zod, y recién cuando alguien conecte algo.
 */

const DecisionSchema = z.object({
  cid: z.string().nullable(),
  /**
   * `done` e `impossible` son las que cierran el bucle. Sin ellas, la única
   * forma de terminar sería agotar los intentos — y el modelo no tendría cómo
   * decir "ya está" ni "esto no se puede desde acá".
   */
  action: z.enum(['click', 'type', 'done', 'impossible', 'none']).default('click'),
  /** Solo se usa si la acción es escribir. */
  text: z.string().default(''),
  /** Por qué eligió eso. Va al log que ve el usuario: es la explicación. */
  reason: z.string().default('')
})

export type Decision = z.infer<typeof DecisionSchema>

export interface LlmStep {
  /** Qué se quiere lograr, en castellano. Es el prompt de verdad. */
  goal: string
  /** Si la acción es escribir, qué escribir. El modelo NO lo inventa. */
  value?: string
}

/**
 * El puerto del modelo. Se recibe por parámetro y no se importa un CLI acá:
 * así el dominio de la navegación no queda atado a `claude` ni a `agy`, y los
 * chequeos pueden pasar uno falso.
 */
export type RunModel = (prompt: string) => Promise<string>

function prompt(
  inv: Inventory,
  step: LlmStep,
  screenshot: string | null,
  done: string[] = []
): string {
  // Solo lo que sirve para decidir. El inventario crudo con coordenadas y
  // hrefs completos son miles de tokens que no cambian la respuesta.
  const list = inv.items
    .map((i) => {
      const state = i.disabled ? ' [deshabilitado]' : ''
      const value = i.value !== '' ? ` (dice: "${i.value}")` : ''
      return `${i.cid}\t${i.action}\t<${i.tag}${i.role !== '' ? ` role=${i.role}` : ''}>\t${i.text}${value}${state}`
    })
    .join('\n')

  return `Estás manejando un navegador para automatizar una tarea en un sitio web.

OBJETIVO: ${step.goal}
${
  done.length > 0
    ? `\nLO QUE YA HICISTE (no lo repitas — si el objetivo sigue sin cumplirse, falta OTRA cosa):\n${done.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
    : ''
}
PÁGINA ACTUAL: ${inv.title} — ${inv.url}${inv.inModal ? '\nHAY UN MODAL ABIERTO: la lista de abajo es SOLO del modal.' : ''}
${screenshot !== null ? `CAPTURA DE PANTALLA: ${screenshot}\n(Si podés abrir esa imagen, miralá: las coordenadas de cada elemento están en la lista.)` : ''}

TEXTO VISIBLE DE LA PÁGINA:
${inv.text.slice(0, 1800)}

ELEMENTOS DISPONIBLES (id / acción / etiqueta HTML / texto):
${list}
${
  inv.truncated
    ? '\n⚠ La lista está RECORTADA: hay más elementos abajo que no entraron. Si lo que buscás no está acá pero sí en el texto de la página, elegí algo que haga scroll o que abra esa parte, en vez de decir que no existe.'
    : ''
}

Decidí LA PRÓXIMA acción —una sola— y respondé SOLO con JSON, sin explicación
afuera ni bloque de código:

{"cid":"<el id exacto de la lista>","action":"click"|"type"|"done"|"impossible","text":"<solo si action es type>","reason":"<una frase corta>"}

Reglas:
- El "cid" tiene que ser uno de la lista de arriba, tal cual. No inventes ids.
- "action" vale exactamente una de: "click", "type", "done", "impossible".
- Si el objetivo YA está cumplido según lo que ves: {"cid":null,"action":"done","reason":"..."}.
- Si el objetivo NO se puede cumplir desde esta pantalla —falta un permiso,
  hace falta que intervenga la persona, el sitio pide algo que no tenés—:
  {"cid":null,"action":"impossible","reason":"<qué falta exactamente>"}.
  Decir que no se puede es una respuesta correcta; clickear cualquier cosa no.
- Un formulario puede necesitar VARIOS pasos: llenar un campo y después apretar
  el botón que confirma. Que el campo esté lleno no significa que esté guardado.
- No elijas nada que borre, cancele, cierre sesión, elimine, pague, ni que
  cierre el modal en el que estás trabajando.
- Si "action" es "type", "text" tiene que ser exactamente el valor que te pide
  el objetivo. No lo redactes vos.`
}

/** El modelo puede envolver el JSON en prosa o en ``` pese a lo que se le pida. */
function extractJson(output: string): unknown {
  const clean = output.replace(/```(?:json)?/g, '').trim()
  const from = clean.indexOf('{')
  const to = clean.lastIndexOf('}')
  if (from === -1 || to <= from) throw new Error(`el modelo no devolvió JSON: ${clean.slice(0, 200)}`)
  return JSON.parse(clean.slice(from, to + 1))
}

export interface StepResult {
  ok: boolean
  /** Lo que se clickeó o escribió, para el log. */
  detail: string
  /** `true` si el modelo dice que el objetivo YA está cumplido. */
  done?: boolean
  /** `true` si dice que no se puede desde acá. Reintentar no va a ayudar. */
  impossible?: boolean
}

/**
 * Un paso: mirar, decidir, ejecutar.
 *
 * `capture` es opcional y devuelve la ruta del PNG. Va por parámetro porque
 * dónde se guardan las capturas es decisión del llamador, no de esto.
 */
export async function stepWithModel(
  browser: BrowserPort,
  step: LlmStep,
  runModel: RunModel,
  capture: (() => Promise<string | null>) | null = null,
  done: string[] = []
): Promise<StepResult> {
  const inv = await browser.inventory()

  if (inv.items.length === 0) {
    return { ok: false, detail: 'la página no tiene nada clickeable todavía' }
  }

  const screenshot = capture !== null ? await capture() : null
  const output = await runModel(prompt(inv, step, screenshot, done))

  let decision: Decision
  try {
    decision = DecisionSchema.parse(extractJson(output))
  } catch (error: unknown) {
    return {
      ok: false,
      detail: `no entendí la respuesta del modelo: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (decision.action === 'done') {
    return { ok: true, done: true, detail: decision.reason || 'el objetivo ya estaba cumplido' }
  }

  if (decision.action === 'impossible') {
    return {
      ok: false,
      impossible: true,
      detail: decision.reason || 'no se puede desde esta pantalla'
    }
  }

  if (decision.cid === null || decision.action === 'none') {
    return { ok: false, detail: decision.reason || 'el modelo no encontró qué apretar' }
  }

  // El id tiene que salir de la lista que NOSOTROS armamos. Un modelo que
  // alucina un id se choca acá, antes de tocar la página.
  const chosen = inv.items.find((i) => i.cid === decision.cid)
  if (chosen === undefined) {
    return { ok: false, detail: `el modelo inventó el id "${decision.cid}", que no está en la página` }
  }
  if (chosen.disabled) {
    return { ok: false, detail: `"${chosen.text.slice(0, 60)}" está deshabilitado` }
  }

  if (decision.action === 'type') {
    // El valor lo pone el llamador, no el modelo: es la misma regla que en los
    // formularios de postulación. El modelo elige DÓNDE, nunca QUÉ.
    const value = step.value ?? decision.text
    if (value === '') return { ok: false, detail: 'había que escribir pero no hay qué' }
    await browser.typeById(chosen.cid, value)
    return { ok: true, detail: `escribí "${value}" en ${chosen.text.slice(0, 50)} — ${decision.reason}` }
  }

  const text = await browser.clickById(chosen.cid)
  return { ok: true, detail: `clickeé "${text || chosen.text.slice(0, 50)}" — ${decision.reason}` }
}

/**
 * El bucle: mirar → actuar → volver a mirar, hasta lograr el objetivo.
 *
 * ## Por qué un solo paso no alcanza
 *
 * `stepWithModel` hace UNA acción y se va. Pero un objetivo de verdad casi
 * nunca es una acción: "crear la integración" es escribir el nombre Y APRETAR
 * el botón que confirma. Con un solo tiro, el nombre queda escrito, el modal
 * abierto, y el paso siguiente sale a buscar un token que no existe.
 *
 * Eso pasó, textual, con Notion: el modelo lo diagnosticó perfecto —"este modal
 * es para crear una conexión nueva; todavía no existe ningún token"— pero no
 * tenía forma de apretar "Create connection", porque su turno ya había pasado.
 *
 * ## El historial no es un lujo
 *
 * Cada vuelta se le cuenta al modelo lo que ya hizo. Sin eso vuelve a elegir el
 * mismo botón para siempre: la pantalla apenas cambió, así que su mejor
 * decisión es la misma. El historial es lo que convierte N llamadas en
 * progreso en vez de en N copias del mismo click.
 */
export async function achieveGoal(
  browser: BrowserPort,
  step: LlmStep,
  runModel: RunModel,
  options: {
    /** Techo de acciones. Es el freno: sin esto, un bucle contra un sitio ajeno. */
    maxSteps?: number
    capture?: (() => Promise<string | null>) | null
    /** Se llama en cada acción, para que el usuario lo vea mientras pasa. */
    onAction?: (detail: string, ok: boolean) => void
  } = {}
): Promise<StepResult> {
  const max = options.maxSteps ?? 5
  const done: string[] = []

  for (let i = 0; i < max; i++) {
    const r = await stepWithModel(browser, step, runModel, options.capture ?? null, done)

    if (r.done === true) {
      return { ...r, detail: done.length > 0 ? `${done.join(' → ')} → ${r.detail}` : r.detail }
    }

    // "No se puede desde acá" no se reintenta: la pantalla no va a cambiar
    // sola, y volver a preguntar es gastar cuota para escuchar lo mismo.
    if (r.impossible === true) return r

    if (!r.ok) {
      options.onAction?.(r.detail, false)
      return {
        ok: false,
        detail: done.length > 0 ? `${done.join(' → ')}; después: ${r.detail}` : r.detail
      }
    }

    done.push(r.detail)
    options.onAction?.(r.detail, true)
  }

  return {
    ok: false,
    detail: `no terminé en ${max} pasos. Hice: ${done.join(' → ')}`
  }
}

/**
 * Lo barato primero, el modelo solo si hace falta.
 *
 * OJO con el falso positivo: `clickText` puede devolver ok habiendo clickeado
 * lo que no era —buscando "create" agarró el encabezado "Created" de una tabla
 * y el modelo nunca llegó a mirar—. Por eso los pasos que importan usan
 * `achieveGoal`, que verifica mirando de nuevo. Esta función queda para lo
 * inequívoco y para cuando NO hay ningún CLI instalado.
 */
export async function smartClick(
  browser: BrowserPort,
  texts: string[],
  step: LlmStep,
  runModel: RunModel | null,
  capture: (() => Promise<string | null>) | null = null,
  timeoutMs = 6000
): Promise<StepResult> {
  try {
    const text = await browser.clickText(texts, false, timeoutMs)
    return { ok: true, detail: `clickeé "${text}"` }
  } catch (error: unknown) {
    const why = error instanceof Error ? error.message : String(error)

    if (runModel === null) {
      return { ok: false, detail: `${why} (y no hay modelo disponible para mirar la pantalla)` }
    }

    const r = await stepWithModel(browser, step, runModel, capture)
    return r.ok
      ? { ok: true, detail: `${r.detail} [lo resolvió el modelo mirando la pantalla]` }
      : { ok: false, detail: `${why}; el modelo tampoco: ${r.detail}` }
  }
}
