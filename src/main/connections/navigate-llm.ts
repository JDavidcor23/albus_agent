import { z } from 'zod'
import type { BrowserPort, Inventario } from '../core/jobs/ports'

/**
 * El escalón 4 de la cascada, aplicado a manejar la UI de otro.
 *
 * ## El problema que resuelve
 *
 * Automatizar Notion con `clickTexto(['new integration'])` es apostar a que el
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
 */

const DecisionSchema = z.object({
  cid: z.string().nullable(),
  /**
   * `listo` e `imposible` son las que cierran el bucle. Sin ellas, la única
   * forma de terminar sería agotar los intentos — y el modelo no tendría cómo
   * decir "ya está" ni "esto no se puede desde acá".
   */
  accion: z.enum(['click', 'escribir', 'listo', 'imposible', 'nada']).default('click'),
  /** Solo se usa si la acción es escribir. */
  texto: z.string().default(''),
  /** Por qué eligió eso. Va al log que ve el usuario: es la explicación. */
  razon: z.string().default('')
})

export type Decision = z.infer<typeof DecisionSchema>

export interface PasoLlm {
  /** Qué se quiere lograr, en castellano. Es el prompt de verdad. */
  objetivo: string
  /** Si la acción es escribir, qué escribir. El modelo NO lo inventa. */
  valor?: string
}

/**
 * El puerto del modelo. Se recibe por parámetro y no se importa un CLI acá:
 * así el dominio de la navegación no queda atado a `claude` ni a `agy`, y los
 * chequeos pueden pasar uno falso.
 */
export type CorrerModelo = (prompt: string) => Promise<string>

function prompt(
  inv: Inventario,
  paso: PasoLlm,
  captura: string | null,
  hechos: string[] = []
): string {
  // Solo lo que sirve para decidir. El inventario crudo con coordenadas y
  // hrefs completos son miles de tokens que no cambian la respuesta.
  const lista = inv.items
    .map((i) => {
      const estado = i.deshabilitado ? ' [deshabilitado]' : ''
      const valor = i.valor !== '' ? ` (dice: "${i.valor}")` : ''
      return `${i.cid}\t${i.accion}\t<${i.tag}${i.rol !== '' ? ` role=${i.rol}` : ''}>\t${i.texto}${valor}${estado}`
    })
    .join('\n')

  return `Estás manejando un navegador para automatizar una tarea en un sitio web.

OBJETIVO: ${paso.objetivo}
${
  hechos.length > 0
    ? `\nLO QUE YA HICISTE (no lo repitas — si el objetivo sigue sin cumplirse, falta OTRA cosa):\n${hechos.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
    : ''
}
PÁGINA ACTUAL: ${inv.title} — ${inv.url}${inv.enModal ? '\nHAY UN MODAL ABIERTO: la lista de abajo es SOLO del modal.' : ''}
${captura !== null ? `CAPTURA DE PANTALLA: ${captura}\n(Si podés abrir esa imagen, miralá: las coordenadas de cada elemento están en la lista.)` : ''}

TEXTO VISIBLE DE LA PÁGINA:
${inv.texto.slice(0, 1800)}

ELEMENTOS DISPONIBLES (id / acción / etiqueta HTML / texto):
${lista}
${
  inv.recortado
    ? '\n⚠ La lista está RECORTADA: hay más elementos abajo que no entraron. Si lo que buscás no está acá pero sí en el texto de la página, elegí algo que haga scroll o que abra esa parte, en vez de decir que no existe.'
    : ''
}

Decidí LA PRÓXIMA acción —una sola— y respondé SOLO con JSON, sin explicación
afuera ni bloque de código:

{"cid":"<el id exacto de la lista>","accion":"click"|"escribir"|"listo"|"imposible","texto":"<solo si es escribir>","razon":"<una frase corta>"}

Reglas:
- El "cid" tiene que ser uno de la lista de arriba, tal cual. No inventes ids.
- Si el objetivo YA está cumplido según lo que ves: {"cid":null,"accion":"listo","razon":"..."}.
- Si el objetivo NO se puede cumplir desde esta pantalla —falta un permiso,
  hace falta que intervenga la persona, el sitio pide algo que no tenés—:
  {"cid":null,"accion":"imposible","razon":"<qué falta exactamente>"}.
  Decir que no se puede es una respuesta correcta; clickear cualquier cosa no.
- Un formulario puede necesitar VARIOS pasos: llenar un campo y después apretar
  el botón que confirma. Que el campo esté lleno no significa que esté guardado.
- No elijas nada que borre, cancele, cierre sesión, elimine, pague, ni que
  cierre el modal en el que estás trabajando.
- Si la acción es escribir, "texto" tiene que ser exactamente el valor que te
  pide el objetivo. No lo redactes vos.`
}

/** El modelo puede envolver el JSON en prosa o en ``` pese a lo que se le pida. */
function extraerJson(salida: string): unknown {
  const limpio = salida.replace(/```(?:json)?/g, '').trim()
  const desde = limpio.indexOf('{')
  const hasta = limpio.lastIndexOf('}')
  if (desde === -1 || hasta <= desde) throw new Error(`el modelo no devolvió JSON: ${limpio.slice(0, 200)}`)
  return JSON.parse(limpio.slice(desde, hasta + 1))
}

export interface ResultadoPaso {
  ok: boolean
  /** Lo que se clickeó o escribió, para el log. */
  detalle: string
  /** `true` si el modelo dice que el objetivo YA está cumplido. */
  listo?: boolean
  /** `true` si dice que no se puede desde acá. Reintentar no va a ayudar. */
  imposible?: boolean
}

/**
 * Un paso: mirar, decidir, ejecutar.
 *
 * `capturar` es opcional y devuelve la ruta del PNG. Va por parámetro porque
 * dónde se guardan las capturas es decisión del llamador, no de esto.
 */
export async function pasoConModelo(
  browser: BrowserPort,
  paso: PasoLlm,
  correr: CorrerModelo,
  capturar: (() => Promise<string | null>) | null = null,
  hechos: string[] = []
): Promise<ResultadoPaso> {
  const inv = await browser.inventario()

  if (inv.items.length === 0) {
    return { ok: false, detalle: 'la página no tiene nada clickeable todavía' }
  }

  const captura = capturar !== null ? await capturar() : null
  const salida = await correr(prompt(inv, paso, captura, hechos))

  let decision: Decision
  try {
    decision = DecisionSchema.parse(extraerJson(salida))
  } catch (error: unknown) {
    return {
      ok: false,
      detalle: `no entendí la respuesta del modelo: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (decision.accion === 'listo') {
    return { ok: true, listo: true, detalle: decision.razon || 'el objetivo ya estaba cumplido' }
  }

  if (decision.accion === 'imposible') {
    return {
      ok: false,
      imposible: true,
      detalle: decision.razon || 'no se puede desde esta pantalla'
    }
  }

  if (decision.cid === null || decision.accion === 'nada') {
    return { ok: false, detalle: decision.razon || 'el modelo no encontró qué apretar' }
  }

  // El id tiene que salir de la lista que NOSOTROS armamos. Un modelo que
  // alucina un id se choca acá, antes de tocar la página.
  const elegido = inv.items.find((i) => i.cid === decision.cid)
  if (elegido === undefined) {
    return { ok: false, detalle: `el modelo inventó el id "${decision.cid}", que no está en la página` }
  }
  if (elegido.deshabilitado) {
    return { ok: false, detalle: `"${elegido.texto.slice(0, 60)}" está deshabilitado` }
  }

  if (decision.accion === 'escribir') {
    // El valor lo pone el llamador, no el modelo: es la misma regla que en los
    // formularios de postulación. El modelo elige DÓNDE, nunca QUÉ.
    const valor = paso.valor ?? decision.texto
    if (valor === '') return { ok: false, detalle: 'había que escribir pero no hay qué' }
    await browser.escribirPorId(elegido.cid, valor)
    return { ok: true, detalle: `escribí "${valor}" en ${elegido.texto.slice(0, 50)} — ${decision.razon}` }
  }

  const texto = await browser.clickPorId(elegido.cid)
  return { ok: true, detalle: `clickeé "${texto || elegido.texto.slice(0, 50)}" — ${decision.razon}` }
}

/**
 * El bucle: mirar → actuar → volver a mirar, hasta lograr el objetivo.
 *
 * ## Por qué un solo paso no alcanza
 *
 * `pasoConModelo` hace UNA acción y se va. Pero un objetivo de verdad casi
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
export async function lograrObjetivo(
  browser: BrowserPort,
  paso: PasoLlm,
  correr: CorrerModelo,
  opciones: {
    /** Techo de acciones. Es el freno: sin esto, un bucle contra un sitio ajeno. */
    maxPasos?: number
    capturar?: (() => Promise<string | null>) | null
    /** Se llama en cada acción, para que el usuario lo vea mientras pasa. */
    onAccion?: (detalle: string, ok: boolean) => void
  } = {}
): Promise<ResultadoPaso> {
  const max = opciones.maxPasos ?? 5
  const hechos: string[] = []

  for (let i = 0; i < max; i++) {
    const r = await pasoConModelo(browser, paso, correr, opciones.capturar ?? null, hechos)

    if (r.listo === true) {
      return { ...r, detalle: hechos.length > 0 ? `${hechos.join(' → ')} → ${r.detalle}` : r.detalle }
    }

    // "No se puede desde acá" no se reintenta: la pantalla no va a cambiar
    // sola, y volver a preguntar es gastar cuota para escuchar lo mismo.
    if (r.imposible === true) return r

    if (!r.ok) {
      opciones.onAccion?.(r.detalle, false)
      return {
        ok: false,
        detalle: hechos.length > 0 ? `${hechos.join(' → ')}; después: ${r.detalle}` : r.detalle
      }
    }

    hechos.push(r.detalle)
    opciones.onAccion?.(r.detalle, true)
  }

  return {
    ok: false,
    detalle: `no terminé en ${max} pasos. Hice: ${hechos.join(' → ')}`
  }
}

/**
 * Lo barato primero, el modelo solo si hace falta.
 *
 * OJO con el falso positivo: `clickTexto` puede devolver ok habiendo clickeado
 * lo que no era —buscando "create" agarró el encabezado "Created" de una tabla
 * y el modelo nunca llegó a mirar—. Por eso los pasos que importan usan
 * `lograrObjetivo`, que verifica mirando de nuevo. Esta función queda para lo
 * inequívoco y para cuando NO hay ningún CLI instalado.
 */
export async function clickInteligente(
  browser: BrowserPort,
  textos: string[],
  paso: PasoLlm,
  correr: CorrerModelo | null,
  capturar: (() => Promise<string | null>) | null = null,
  timeoutMs = 6000
): Promise<ResultadoPaso> {
  try {
    const texto = await browser.clickTexto(textos, false, timeoutMs)
    return { ok: true, detalle: `clickeé "${texto}"` }
  } catch (error: unknown) {
    const porQue = error instanceof Error ? error.message : String(error)

    if (correr === null) {
      return { ok: false, detalle: `${porQue} (y no hay modelo disponible para mirar la pantalla)` }
    }

    const r = await pasoConModelo(browser, paso, correr, capturar)
    return r.ok
      ? { ok: true, detalle: `${r.detalle} [lo resolvió el modelo mirando la pantalla]` }
      : { ok: false, detalle: `${porQue}; el modelo tampoco: ${r.detalle}` }
  }
}
