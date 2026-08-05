import { z } from 'zod'
import type { LlmProvider } from '../extraction/llm-port'
import type { AttachmentInfo, DetectedTask, TaskCandidate } from './types'

/** Un renglón por adjunto, para que el modelo sepa QUÉ guardó sin ver la imagen. */
function resumirAdjunto(a: AttachmentInfo): string {
  const p = a.payload

  switch (a.kind) {
    case 'receipt':
      return (
        `comprobante de un pago YA REALIZADO` +
        `${p.merchant ? ` a ${String(p.merchant)}` : ''}` +
        `${p.amount ? ` por ${String(p.amount)}` : ''}`
      )
    case 'qr':
      return `código QR: ${JSON.stringify(p.codes ?? '').slice(0, 120)}`
    case 'profile':
      return `perfil de una persona: ${JSON.stringify(p.profiles ?? '').slice(0, 120)}`
    case 'text':
    case 'document':
      return `captura de pantalla, texto leído: "${String(p.text ?? '').slice(0, 220)}"`
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
        confidence: z.number().min(0).max(1)
      })
    )
    .default([])
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
{"tasks": [{"title": "...", "detail": "...", "confidence": 0.9}]}

Si no hay nada pendiente, devolvé {"tasks": []}. Eso es una respuesta correcta y frecuente.

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

TITLE
Accionable y en primera persona, empezando con verbo en infinitivo.
  bien : "Postularme a la vacante de Backend en Globant"
  mal  : "Oferta de trabajo" / "Trabajo" / "Hay una oferta"
Si no sabés el nombre propio, describilo: "Postularme a la oferta de LinkedIn de <rol>".

DETAIL
El pedazo de la nota que te hizo pensar que hay algo pendiente. Textual, corto.

CONFIDENCE
  0.9-1.0  la persona escribió el verbo: "revisar", "tengo que", "hay que", "falta"
  0.5-0.8  se deduce de lo adjunto: guardó una oferta, guardó una convocatoria
  0.2-0.4  podría ser, pero es una lectura tuya más que de ella

REGLA DE ORO
Ante la duda, NO lo inventes. Una lista con 3 pendientes reales sirve; una con 20
donde 15 son ruido se deja de leer a la semana. Preferí perderte uno antes que
llenar la lista.`

/** Saca el JSON aunque el modelo lo haya envuelto en markdown o prosa. */
function extraerJson(bruto: string): unknown {
  const sinCerca = bruto.replace(/```(?:json)?/gi, '').trim()
  const inicio = sinCerca.indexOf('{')
  const fin = sinCerca.lastIndexOf('}')
  if (inicio === -1 || fin <= inicio) throw new Error('la respuesta no traía JSON')
  return JSON.parse(sinCerca.slice(inicio, fin + 1))
}

/**
 * Analiza UNA nota y devuelve los pendientes que encuentre.
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
): Promise<DetectedTask[]> {
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

    return parsed.tasks
      .map((t) => ({
        title: t.title.trim(),
        detail: t.detail?.trim() || null,
        confidence: t.confidence
      }))
      .filter((t) => t.title.length > 0)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[tasks] no se pudo analizar la entry ${candidate.entryId}: ${message}`)
    return []
  }
}
