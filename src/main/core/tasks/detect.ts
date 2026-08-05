import { z } from 'zod'
import type { LlmProvider } from '../extraction/llm-port'
import { esLegible, limpiarOcr } from '../extraction/clean-ocr'
import { esCifrado, etiquetaDe } from './qr-identity'
import { normalizarFechaIso } from './due-date'
import type { AttachmentInfo, DetectedTask, TaskCandidate } from './types'

/**
 * Un renglón por adjunto, para que el modelo sepa QUÉ guardó sin ver la imagen.
 *
 * Lo que entra acá tiene que estar YA limpio. Antes se le pasaba el OCR crudo y
 * el ciphertext completo del QR, así que el modelo recibía la barra de estado del
 * celular ("9:14 új -- all = ED +") y 120 caracteres de base64 cifrado como si
 * fueran contexto. Un modelo no puede resumir bien lo que se le entrega sucio, y
 * limpiarlo acá no cuesta nada: son las mismas reglas que ya usa la UI.
 */
function resumirAdjunto(a: AttachmentInfo): string {
  const p = a.payload

  switch (a.kind) {
    case 'receipt':
      return (
        `comprobante de un pago YA REALIZADO` +
        `${p.merchant ? ` a ${String(p.merchant)}` : ''}` +
        `${p.amount ? ` por ${String(p.amount)}` : ''}`
      )

    case 'qr': {
      const codes = Array.isArray(p.codes)
        ? p.codes.filter((c): c is string => typeof c === 'string')
        : []
      if (codes.length === 0) return 'código QR que no se pudo leer'

      // El ciphertext no es información: decirle al modelo que la entrada está
      // cifrada le da MÁS contexto que pegarle 120 caracteres de base64.
      const descripciones = codes.map((c) =>
        esCifrado(c) ? 'entrada de evento cifrada (solo la lee la app del organizador)' : etiquetaDe(c)
      )
      return `código QR de: ${[...new Set(descripciones)].filter(Boolean).join(' / ')}`
    }

    case 'profile':
      return `perfil de una persona: ${JSON.stringify(p.profiles ?? '').slice(0, 120)}`

    case 'text':
    case 'document': {
      const limpio = limpiarOcr(String(p.text ?? ''))
      if (!esLegible(limpio)) return 'una captura de pantalla que el OCR no pudo leer'
      return `captura de pantalla, texto leído: "${limpio.replace(/\n/g, ' · ').slice(0, 400)}"`
    }

    default:
      return `adjunto sin clasificar (${a.kind})`
  }
}

const RespuestaSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        detail: z.string().optional(),
        confidence: z.number().min(0).max(1),
        /** Se valida con `normalizarFechaIso`: un modelo inventa formatos. */
        dueDate: z.unknown().optional()
      })
    )
    .default([]),

  /**
   * Opcional a propósito: un modelo que solo devuelve `tasks` sigue funcionando.
   * Los pendientes son el contrato; el resumen es una mejora de lectura, y no
   * puede tumbar la detección si el modelo lo omite.
   */
  summary: z.string().optional()
})

/**
 * Por qué esto necesita un modelo y no una lista de verbos:
 *
 * Sobre las notas reales, una regex de verbos de intención marcó 5 pendientes de
 * 20 notas — y se perdió "Hacer cursos de ia", "Si o si ver cómo automatizar mi
 * trabajo" e "Investigar si los vídeos de ia generan plata". Agrandar la lista no
 * arregla nada: siempre falta un verbo.
 *
 * Y el caso que la mata del todo: tres notas que dicen solamente "Trabajo", cada
 * una con la captura de una oferta de LinkedIn. Cero verbos. Para saber que eso
 * es "postularme" hay que ENTENDER que una oferta guardada es una oportunidad sin
 * atender. Ninguna regla de texto llega ahí.
 */
const INSTRUCCIONES = `Leés notas cortas que una persona se escribe a sí misma al guardar algo
en su app de notas. Tu única tarea es decidir si queda ALGO POR HACER.

Respondé SOLO con un objeto JSON, sin markdown y sin explicaciones:
{"summary": "...", "tasks": [{"title": "...", "detail": "...", "confidence": 0.9, "dueDate": "2026-08-27"}]}

Si no hay nada pendiente, devolvé {"summary": "...", "tasks": []}. Eso es una
respuesta correcta y frecuente — el resumen se devuelve igual.

QUÉ ES UN PENDIENTE
- Una acción que la persona todavía no hizo.
- Una oportunidad guardada sin atender (una oferta de trabajo, una convocatoria).
- Un evento con fecha que todavía no pasó.
- Hablarle o escribirle a alguien que mencionó.
- Una FACTURA o cuenta por pagar: eso es plata que todavía debe.

QUÉ NO ES UN PENDIENTE
- Algo YA HECHO. Un COMPROBANTE de pago es la prueba de que ya pagó: no es un
  pendiente, es un registro. Ojo con la diferencia: una FACTURA es algo por pagar,
  un COMPROBANTE es algo ya pagado. Los adjuntos te dicen cuál es cuál.
- Un DATO para recordar. "Mi llave de Bancolombia @jorge6954" es una referencia,
  no una tarea. Guardar un dato no es deberlo hacer.
- Una descripción de algo que pasó o de alguien que conoció.
- Los códigos QR. Esos ya los maneja una regla aparte: NO generes pendientes de
  "escanear el QR" ni "usar el código". Sí podés generar otros pendientes de la
  misma nota si los hay.

SUMMARY
De qué es esta nota, en una o dos oraciones, para alguien que no la escribió.

La nota más larga que vas a ver es un dictado de voz de 2800 caracteres sin un
solo punto. Nadie la relee. Tu resumen es lo que ese texto debería haber dicho:
  bien : "Notas del evento de AWS Serverless: contactos que hiciste (Daniel
          Vargas, Lucas Vera, Mauricio Alvarado) y qué buscar después."
  mal  : "El usuario habla de varias cosas relacionadas con un evento."

Nombres propios, fechas y lugares ANTES que adjetivos. Si la nota ya es corta y
clara, repetirla no sirve: devolvé "".

NO inventes nada que no esté en la nota ni en los adjuntos. Un resumen que agrega
datos es peor que no tener resumen, porque el usuario le va a creer.

TITLE
Accionable y en primera persona, empezando con verbo en infinitivo.
  bien : "Postularme a la vacante de Backend en Globant"
  mal  : "Oferta de trabajo" / "Trabajo" / "Hay una oferta"
Si no sabés el nombre propio, describilo: "Postularme a la oferta de LinkedIn de <rol>".

DETAIL
El pedazo de la nota que te hizo pensar que hay algo pendiente. Textual, corto,
máximo 44 caracteres — se muestra en una sola línea debajo del título.

Si lo único que podés poner es el título otra vez, dejalo vacío. "Hacer cursos de
IA" con subtítulo "Hacer cursos de ia" ocupa el doble de alto para no decir nada.
Vacío es la respuesta correcta y frecuente.

DUEDATE
Cuándo hay que ACTUAR, en formato "2026-08-27". null si la nota no da ninguna
fecha — que es lo normal.

Es lo que ordena la lista, así que importa más que el confidence:
  "Pagar la cuota del carro de agosto"  -> el último día de agosto
  "el evento es el 27 y 28 de agosto"   -> "2026-08-27", el primer día
  "hacer cursos de ia"                  -> null, es una intención sin fecha

De un rango, el PRIMER día: es cuando hay que estar listo, no cuando termina.
NO inventes fechas. Una fecha inventada manda una tarea al tope de la lista y
tapa las reales. Ante la duda, null.

CONFIDENCE
  0.9-1.0  la persona escribió el verbo: "revisar", "tengo que", "hay que", "falta"
  0.5-0.8  se deduce de lo adjunto: guardó una oferta, guardó una convocatoria
  0.2-0.4  podría ser, pero es una lectura tuya más que de ella

REGLA DE ORO
Ante la duda, NO lo inventes. Una lista con 3 pendientes reales sirve; una con 20
donde 15 son ruido se deja de leer a la semana. Preferí perderte uno antes que
llenar la lista.`

/**
 * ¿El subtítulo solo repite el título?
 *
 * Sobre los datos reales, 10 de 19 pendientes tenían un `detail` que era el
 * título otra vez en minúscula: "Hacer cursos de IA" / "Hacer cursos de ia". En
 * la tarjeta, ese subtítulo duplica el alto sin agregar una palabra.
 *
 * Se descarta al DETECTAR y no al mostrar: guardar ruido para después esconderlo
 * es peor que no guardarlo — la próxima pantalla que lea `detail` vuelve a
 * mostrarlo.
 */
function esRedundante(title: string, detail: string): boolean {
  const palabras = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3)
    )

  const delDetalle = palabras(detail)
  if (delDetalle.size === 0) return true

  const delTitulo = palabras(title)
  let comunes = 0
  for (const w of delDetalle) if (delTitulo.has(w)) comunes++

  return comunes / delDetalle.size >= 0.6
}

/** Saca el JSON aunque el modelo lo haya envuelto en markdown o prosa. */
function extraerJson(bruto: string): unknown {
  const sinCerca = bruto.replace(/```(?:json)?/gi, '').trim()
  const inicio = sinCerca.indexOf('{')
  const fin = sinCerca.lastIndexOf('}')
  if (inicio === -1 || fin <= inicio) throw new Error('la respuesta no traía JSON')
  return JSON.parse(sinCerca.slice(inicio, fin + 1))
}

export interface DetectionResult {
  tasks: DetectedTask[]
  /** Resumen legible de la nota. `null` si el modelo no lo dio o no hacía falta. */
  summary: string | null
}

/**
 * Analiza UNA nota: devuelve sus pendientes y un resumen legible.
 *
 * El resumen viene en la MISMA llamada que la detección, no en una aparte. Es la
 * decisión que mantiene esto gratis: el prompt ya lleva la nota entera y los
 * adjuntos, así que pedir el resumen ahí no gasta una sola llamada más. Un
 * segundo pedido "resumime esta nota" duplicaría el consumo de cuota para
 * mandar exactamente el mismo contexto.
 *
 * `hoy` entra por parámetro y no se lee del reloj: hace falta para decidir si un
 * evento ya pasó, y pasarlo explícito mantiene la función testeable.
 *
 * NUNCA propaga excepciones: un modelo caído o una respuesta con forma rara
 * devuelven lista vacía. Perder la detección de una nota es aceptable; frenar
 * el análisis del resto, no.
 */
export async function detectTasks(
  provider: LlmProvider,
  model: string | null,
  candidate: TaskCandidate,
  hoy: string
): Promise<DetectionResult> {
  const utiles = candidate.attachments.filter((a) => a.kind !== 'none' && a.kind !== 'failed')
  const adjuntos =
    utiles.length > 0
      ? utiles.map((a) => `  - ${resumirAdjunto(a)}`).join('\n')
      : '  (sin adjuntos)'

  const prompt =
    `${INSTRUCCIONES}\n\n` +
    `Hoy es ${hoy}. Un evento con fecha anterior ya pasó y no es pendiente.\n\n` +
    `--- NOTA ---\n${candidate.body.trim() || '(sin texto)'}\n\n` +
    `--- LO QUE GUARDÓ CON ELLA ---\n${adjuntos}`

  try {
    const bruto = await provider.run(prompt, model)
    const parsed = RespuestaSchema.parse(extraerJson(bruto))

    const resumen = parsed.summary?.trim() ?? ''

    return {
      tasks: parsed.tasks
        .map((t) => {
          const title = t.title.trim()
          const detail = t.detail?.trim() || null

          // El modelo puede devolver la fecha en cualquier formato, o inventarla.
          // Se valida acá, y una fecha ya pasada se descarta: mandaría la tarea al
          // tope de la lista como si fuera lo más urgente.
          const fecha = normalizarFechaIso(t.dueDate)

          return {
            title,
            detail: detail !== null && !esRedundante(title, detail) ? detail : null,
            confidence: t.confidence,
            dueDate: fecha !== null && fecha >= hoy ? fecha : null
          }
        })
        .filter((t) => t.title.length > 0),

      // Un resumen más largo que la nota no resume nada: si el modelo se fue de
      // largo, es más honesto no tener resumen que mostrar algo peor que el
      // original. El +40 deja pasar el caso de una nota corta reformulada.
      summary:
        resumen.length > 0 && resumen.length < candidate.body.trim().length + 40 ? resumen : null
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[tasks] no se pudo analizar la entry ${candidate.entryId}: ${message}`)
    return { tasks: [], summary: null }
  }
}
