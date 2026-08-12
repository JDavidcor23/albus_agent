import type { CandidateProfile } from './types'

/**
 * El agente: el modelo DECIDE, el programa ejecuta.
 *
 * ## Por qué esto reemplaza al router de regex
 *
 * `chat.ts` interpreta lo que el usuario escribe con ocho expresiones
 * regulares. Funciona hasta la primera frase que nadie previó, y ahí contesta
 * "no lo sé contestar" a un pedido perfectamente razonable. Pasó con
 * "postulame tu a todas las que pasaron": `\bpostula\b` no matchea "postulame",
 * así que el pedido murió antes de llegar a ningún lado. El arreglo fue agregar
 * otro patrón — y ese es el problema, no la solución: cada frase nueva del
 * usuario es una línea nueva de código, para siempre.
 *
 * El argumento que sostenía el router era el de la cascada: *"resolverlo con IA
 * es pagar cuota y esperar segundos para ejecutar el equivalente a un SELECT"*.
 * Estaba comparado con el caso equivocado. La cascada existe para lotes de 48
 * imágenes, donde los tokens se multiplican; acá vale lo que ya está escrito en
 * `connections.md` sobre por qué ahí el agente va primero: **el precio de
 * equivocarse es que se rompe el flujo entero**, y hablarle al agente pasa unas
 * pocas veces por día.
 *
 * ## Qué hace este módulo y qué NO
 *
 * Puro: arma el prompt y lee la decisión. No ejecuta nada, no toca red ni
 * disco, no sabe qué es Notion. Las herramientas se le pasan como datos y quien
 * las corre es el adaptador — mismo reparto que `navigate-llm.ts`, que ya
 * resuelve esto para el navegador desde hace rato.
 *
 * ## Las reglas del usuario entran ENTERAS
 *
 * No se parsean. Es el punto entero del `.md`: que el usuario escriba "el CV no
 * puede tener nombre genérico porque se nota que es de IA" y que eso pese, sin
 * que nadie haya programado un campo `nombreDeCv`. `parseSearchPrefs` saca dos
 * secciones para la búsqueda, que necesita strings concretos; el agente recibe
 * el texto completo.
 */

/** Lo mínimo que el agente necesita saber de una vacante en pantalla. */
export interface AgentJobView {
  id: string
  company: string
  title: string
  score: number
  /** Si ya tiene el CV y la carta compilados. Cambia qué conviene hacer. */
  kitReady: boolean
}

/** Una capacidad de la app, descrita para que el modelo pueda elegirla. */
export interface ToolSpec {
  name: string
  /** Qué hace y CUÁNDO usarla. Lo lee el modelo, no un programador. */
  description: string
  /** nombre del argumento → qué es. Vacío = no lleva argumentos. */
  args: Record<string, string>
}

/** Lo que el modelo decidió hacer en esta vuelta. */
export interface AgentDecision {
  /** Herramienta a ejecutar. `null` = no hay más que hacer. */
  tool: string | null
  args: Record<string, unknown>
  /** Lo que se le dice al usuario. Siempre en castellano. */
  say: string
  /** `true` = terminó el pedido. El bucle corta. */
  done: boolean
}

/** Una vuelta ya ejecutada, para que el modelo sepa qué pasó. */
export interface AgentTurn {
  tool: string
  args: Record<string, unknown>
  /** Resultado resumido. Es lo que el modelo lee para decidir lo que sigue. */
  result: string
  ok: boolean
}

export interface AgentContext {
  /** El `.md` del usuario, COMPLETO y sin parsear. */
  rules: string
  tools: ToolSpec[]
  /** Lo que el usuario está viendo. "esa", "la de BairesDev" salen de acá. */
  screen: AgentJobView[]
  /** Lo que ya se hizo en este pedido. Sin esto elige la misma acción siempre. */
  history: AgentTurn[]
  /** Lo que el usuario escribió, tal cual. */
  message: string
  /**
   * La postulación que quedó ABIERTA esperando al usuario, si hay.
   *
   * Es el contexto que faltaba, y su ausencia se veía así: el usuario decía *"sí
   * manda, pero rellena estos datos"* y el agente contestaba *"¿cuál es el id de
   * la vacante donde estás rellenando el formulario? hay varias en pantalla"*.
   *
   * No era terquedad. `screen` son las vacantes que se están MOSTRANDO —diez
   * resultados de una búsqueda— y ninguna dice "esta es la que está abierta en el
   * navegador ahora mismo". El agente no tenía forma de saberlo. Reclamo textual:
   * *"no está guardando la relación en cada sesión, no está referenciando la
   * pregunta que me hace con la acción que estoy realizando"*.
   *
   * Cuando esto viene lleno, "estos campos", "esa", "mandala" se resuelven acá y
   * no hay nada que preguntar.
   */
  openApplication?: {
    id: string
    company: string
    role: string
    url: string
    /** Los campos que quedaron sin responder: casi siempre son "estos datos". */
    unresolved: string[]
  } | null
  /**
   * El perfil del candidato. Los DATOS, no las preferencias.
   *
   * Faltaba, y el síntoma fue exacto: el agente contestó *"Necesito tu nivel de
   * inglés para responder esas preguntas técnicas. ¿B1, B2, C1 o C2?"* sobre un
   * perfil que tiene `englishLevel` y un formulario que ya lo mostraba lleno.
   *
   * `rules` es el `.md` —lo que el usuario QUIERE— y `profile` es el JSON —lo que
   * el usuario ES—. `answerByLlm` ya le pasaba el perfil al modelo para contestar
   * campos; el agente que decide no lo tenía, así que preguntaba lo que la app ya
   * sabía. Preguntar un dato que está a la mano es hacerle perder el tiempo.
   */
  profile?: CandidateProfile | null
}

function toolLines(tools: ToolSpec[]): string {
  return tools
    .map((t) => {
      const args = Object.entries(t.args)
      const sig =
        args.length === 0
          ? '(sin argumentos)'
          : args.map(([k, v]) => `${k}: ${v}`).join(', ')
      return `- ${t.name} — ${t.description}\n  argumentos: ${sig}`
    })
    .join('\n')
}

function screenLines(screen: AgentJobView[]): string {
  if (screen.length === 0) return '(no hay vacantes en pantalla todavía)'
  return screen
    .map(
      (j, i) =>
        `${i + 1}. id=${j.id} · ${j.company} · ${j.title} · puntaje ${j.score}` +
        ` · CV ${j.kitReady ? 'listo' : 'sin armar'}`
    )
    .join('\n')
}

function historyLines(history: AgentTurn[]): string {
  if (history.length === 0) return '(todavía no hiciste nada en este pedido)'
  return history
    .map(
      (h, i) =>
        `${i + 1}. ${h.tool}(${JSON.stringify(h.args)}) → ${h.ok ? 'ok' : 'FALLÓ'}: ${h.result}`
    )
    .join('\n')
}

/**
 * El bloque de la postulación abierta. Vacío si no hay ninguna.
 *
 * Va JUSTO DEBAJO de las vacantes en pantalla y con una instrucción explícita,
 * porque el error que viene a corregir es de referencia: con diez vacantes
 * listadas, "estos campos" es ambiguo salvo que se diga cuál es la de ahora.
 */
function openApplicationLines(open: AgentContext['openApplication']): string {
  if (open === undefined || open === null) return ''

  const pending =
    open.unresolved.length > 0
      ? `\nCampos que quedaron SIN responder: ${open.unresolved.join(', ')}.`
      : ''

  return `
POSTULACIÓN ABIERTA AHORA MISMO
id=${open.id} · ${open.company} · ${open.role}
${open.url}
El formulario está lleno y esperando en una ventana abierta; falta enviarlo.${pending}
Si el usuario dice "estos campos", "esos datos", "mandala", "esa" o cualquier cosa
en presente sin nombrar la empresa, se refiere a ESTA. No le preguntes cuál es.
`
}

/**
 * El perfil, en renglones legibles para el modelo.
 *
 * Se listan los datos que un formulario de postulación pide de verdad. Va con una
 * instrucción explícita de NO preguntar lo que está acá: el agente venía
 * preguntando el nivel de inglés teniéndolo en el perfil.
 *
 * El teléfono y el mail van igual: son lo primero que pide cualquier formulario, y
 * el modelo ya los recibe en `answerByLlm`. Lo que NO sale de acá es hacia afuera:
 * `scrubPii` sigue tachándolos antes de escribir en Notion.
 */
function profileLines(p: CandidateProfile | null | undefined): string {
  if (p === null || p === undefined) return ''

  const years = Object.entries(p.yearsExperience)
    .map(([tech, n]) => `${tech}:${n}`)
    .join(' · ')

  return `
DATOS DEL CANDIDATO
Nombre: ${p.fullName} · ${p.city}, ${p.country} (${p.countryCode})
Contacto: ${p.email} · ${p.phoneCountryCode}${p.phone}
Perfil: ${p.headline} — ${p.currentTitle} en ${p.currentCompany}
Links: ${p.linkedinUrl} · ${p.githubUrl} · ${p.portfolioUrl}
Idiomas: inglés ${p.englishLevel} · español ${p.spanishLevel}
Educación: ${p.highestEducation}
Años de experiencia: ${years}
Autorizado a trabajar: ${p.workAuthorized ? 'sí' : 'no'} · Necesita sponsorship: ${p.requiresSponsorship ? 'sí' : 'no'}
Se reubica: ${p.willingToRelocate ? 'sí' : 'no'} · Solo remoto: ${p.remoteOnly ? 'sí' : 'no'}
Pretensión: USD ${p.expectedSalaryUsdMonthly}/mes · Preaviso: ${p.noticePeriodDays} días

NO le preguntes al usuario nada que esté en esta lista: ya lo tenés. Y no inventes
experiencia que no figure acá — si un formulario pide algo que no está, ese campo se
deja vacío y se le avisa.
`
}

export function buildAgentPrompt(ctx: AgentContext): string {
  return `Sos Albus, el agente de búsqueda de trabajo de una persona concreta. Trabajás PARA ella: te pide algo en castellano y vos lo hacés usando las herramientas de abajo.

REGLAS DEL USUARIO
Esto lo escribió él en su archivo de reglas. Es su palabra y manda sobre cualquier default tuyo, aunque no se parezca a ninguna opción programada. Si dice cómo quiere que se llamen los archivos, dónde guardarlos o qué no tocar, cumplilo.
---
${ctx.rules.trim() === '' ? '(todavía no escribió reglas)' : ctx.rules.trim()}
---

${profileLines(ctx.profile)}
HERRAMIENTAS
${toolLines(ctx.tools)}

VACANTES EN PANTALLA
${screenLines(ctx.screen)}
${openApplicationLines(ctx.openApplication)}
LO QUE YA HICISTE EN ESTE PEDIDO
${historyLines(ctx.history)}

EL PEDIDO
"${ctx.message}"

CÓMO TRABAJÁS

Hacé lo que te pide, COMPLETO. Si dice "postulate a todas", postulate a todas: no le pidas que lo confirme ni le expliques por qué no podés. Ya te lo pidió. Si algo sale mal, lo contás y seguís con el resto.

Terminar un pedido a medias y pasarle el trabajo manual a él es fallar, aunque le avises. "Te dejé los formularios llenos para que los mandes vos" NO es haberse postulado: si te pidió postularse, la acción termina cuando está enviada. Solo dejás algo a mano si él lo pidió o si sus reglas lo dicen.

Un pedido puede necesitar VARIAS herramientas, una por vuelta. Elegí la siguiente mirando lo que ya hiciste. Cuando el pedido esté cumplido, poné "done": true.

Si te pide algo para lo que no hay herramienta, no inventes que lo hiciste: decilo en "say" con "done": true, y sé concreto sobre qué falta.

Si no estás seguro de a cuál vacante se refiere y hay varias posibles, preguntale en "say" con "done": true. Postularse a la equivocada no se deshace. Pero si hay UNA sola candidata razonable, es esa: no preguntes por preguntar.

Hablale de vos, en castellano rioplatense, corto y sin vender. Si algo no salió, decilo.

Devolvé SOLO este JSON, sin markdown ni texto alrededor:
{"tool":"nombre_de_la_herramienta","args":{},"say":"qué le contás al usuario","done":false}

Para terminar sin ejecutar nada más:
{"tool":null,"args":{},"say":"...","done":true}`
}

/**
 * Lee la decisión del modelo. Nunca tira.
 *
 * Un modelo que devuelve basura no puede colgar el chat: se convierte en una
 * decisión de "terminá y decí qué pasó", que el usuario puede leer y responder.
 */
export function parseDecision(raw: string): AgentDecision {
  const fallback = (say: string): AgentDecision => ({ tool: null, args: {}, say, done: true })

  const clean = raw.replace(/^```(?:json)?/gm, '').replace(/```$/gm, '')
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start === -1 || end <= start) {
    return fallback('No te entendí bien y no quiero hacer algo que no me pediste. ¿Me lo repetís?')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(clean.slice(start, end + 1))
  } catch {
    return fallback('Me colgué procesando eso. Probá de nuevo, o decímelo de otra forma.')
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return fallback('Me colgué procesando eso. Probá de nuevo, o decímelo de otra forma.')
  }

  const o = parsed as Record<string, unknown>
  const tool = typeof o.tool === 'string' && o.tool.trim() !== '' ? o.tool.trim() : null
  const say = typeof o.say === 'string' ? o.say : ''
  const args =
    typeof o.args === 'object' && o.args !== null && !Array.isArray(o.args)
      ? (o.args as Record<string, unknown>)
      : {}

  // Sin herramienta no hay nada que ejecutar: se termina, diga lo que diga el
  // campo `done`. Si no, el bucle gira hasta el tope diciendo lo mismo.
  const done = tool === null ? true : o.done === true

  return { tool, args, say, done }
}

/**
 * Techo de acciones por pedido.
 *
 * Es el freno, no una expectativa: un "postulate a todas" con doce vacantes son
 * doce llamadas más las de preparación. Alto para que los pedidos reales entren,
 * y finito para que un modelo confundido no gire para siempre gastando cuota.
 */
export const MAX_AGENT_STEPS = 40

/** Una herramienta que el modelo pidió y que no existe. Se le dice, y sigue. */
export function unknownToolMessage(name: string, tools: ToolSpec[]): string {
  return (
    `no existe la herramienta "${name}". ` +
    `Las que hay son: ${tools.map((t) => t.name).join(', ')}.`
  )
}

export interface ToolResult {
  ok: boolean
  /** Qué pasó, en una línea. Lo lee el MODELO para decidir lo que sigue. */
  result: string
  /** Si la acción cambió lo que el usuario ve, la pantalla nueva. */
  screen?: AgentJobView[]
}

export type ToolRunner = (
  tool: string,
  args: Record<string, unknown>
) => Promise<ToolResult>

export type RunModel = (prompt: string) => Promise<string>

/**
 * El bucle. Decide, ejecuta, le cuenta lo que pasó, repite.
 *
 * Cada vuelta el modelo ve el historial completo de este pedido. Sin eso vuelve
 * a elegir la misma herramienta para siempre —el mismo problema que
 * `navigate-llm.ts` resolvió para el navegador— porque nada le indica que ya la
 * usó.
 *
 * Nunca tira. Una herramienta que revienta es un resultado más: se le informa
 * al modelo y él decide si sigue con el resto o corta. Un pedido de doce
 * postulaciones no se cae porque la séptima empresa tenga el formulario roto.
 */
export async function runAgent(
  ctx: Omit<AgentContext, 'history'>,
  runModel: RunModel,
  execute: ToolRunner,
  options: {
    maxSteps?: number
    /** Lo que el agente le dice al usuario, en el momento en que lo dice. */
    onSay?: (text: string) => void
    /** Para mostrar que está trabajando, antes de que la herramienta termine. */
    onTool?: (tool: string, args: Record<string, unknown>) => void
  } = {}
): Promise<AgentTurn[]> {
  const max = options.maxSteps ?? MAX_AGENT_STEPS
  const history: AgentTurn[] = []
  let screen = ctx.screen

  for (let i = 0; i < max; i++) {
    let decision: AgentDecision
    try {
      const raw = await runModel(buildAgentPrompt({ ...ctx, screen, history }))
      decision = parseDecision(raw)
    } catch (error: unknown) {
      // El CLI se cayó. No es culpa del usuario y no puede quedar en silencio.
      const message = error instanceof Error ? error.message : String(error)
      options.onSay?.(`Se me cayó el modelo: ${message}`)
      return history
    }

    if (decision.say !== '') options.onSay?.(decision.say)
    if (decision.tool === null) return history

    /*
     * `ctx.tools` es un LÍMITE, no una sugerencia.
     *
     * Acá se ejecutaba lo que el modelo pidiera sin verificar que estuviera en la
     * lista que le dimos. `unknownToolMessage` se escribió exactamente para este
     * chequeo y no se llamaba desde ningún lado.
     *
     * Con el manifiesto del agente recortando capacidades —`tools` en
     * `<id>.agente.json`— la diferencia deja de ser teórica: un agente al que el
     * usuario NO le habilitó `postular` no puede postularse porque el modelo
     * acertó el nombre de una herramienta que no le tocaba. Es la misma regla que
     * el freno del submit: lo que no se puede hacer, no se puede hacer aunque el
     * modelo lo pida bien.
     *
     * No se corta el pedido: se le dice qué hay y sigue. Un nombre equivocado es
     * recuperable, y cortar dejaría al usuario sin las once postulaciones que
     * faltaban por un typo del modelo en la primera.
     */
    if (!ctx.tools.some((t) => t.name === decision.tool)) {
      history.push({
        tool: decision.tool,
        args: decision.args,
        result: unknownToolMessage(decision.tool, ctx.tools),
        ok: false
      })
      continue
    }

    options.onTool?.(decision.tool, decision.args)

    let outcome: ToolResult
    try {
      outcome = await execute(decision.tool, decision.args)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      outcome = { ok: false, result: message }
    }

    if (outcome.screen !== undefined) screen = outcome.screen
    history.push({
      tool: decision.tool,
      args: decision.args,
      result: outcome.result,
      ok: outcome.ok
    })

    if (decision.done) return history
  }

  // El tope es un freno de emergencia, no un final normal. Se dice: callarlo
  // deja al usuario creyendo que el pedido se cumplió.
  options.onSay?.(
    `Frené en ${max} pasos para no seguir gastando. Hice ${history.length} cosas; ` +
      `si faltó algo, pedímelo de nuevo y sigo desde acá.`
  )
  return history
}
