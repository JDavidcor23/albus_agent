import { z } from 'zod'
import type { LlmClassification, LlmProvider } from './llm-port'

const RespuestaSchema = z.object({
  kind: z.enum(['receipt', 'profile', 'job_offer', 'event', 'note', 'none']),
  summary: z.string(),
  fields: z.record(z.string(), z.string()).default({})
})

const INSTRUCCIONES = `Sos un clasificador. Recibís texto sacado por OCR de una captura de
pantalla o una foto de celular. El OCR es RUIDOSO: viene con caracteres sueltos, palabras
partidas y basura. Reconstruí el sentido; no te frenes por los errores.

Respondé SOLO con un objeto JSON, sin markdown, sin explicación, con esta forma:
{"kind": "...", "summary": "...", "fields": {...}}

kind es uno de:
  receipt    comprobante de pago (Nequi, Bancolombia, Daviplata, Bre-B, PSE, etc.)
  profile    perfil de una persona (LinkedIn, tarjeta, contacto)
  job_offer  oferta de trabajo o vacante
  event      evento, charla, meetup, conferencia
  note       texto que no cae en lo anterior pero dice algo
  none       ilegible o sin contenido útil

summary: UNA línea en español, concreta, que diga qué es. Nada de "parece ser una captura".

fields: pares clave/valor con lo que puedas extraer. Todos los valores son strings.
  receipt   -> entity, amount, date, reference
  profile   -> name, headline, company, linkedin
  job_offer -> company, role, location, seniority
  event     -> name, organizer, date, url

Si un campo no está, omitilo. No inventes datos que no estén en el texto.`

/** Saca el JSON aunque el modelo lo haya envuelto en markdown o prosa. */
function extraerJson(bruto: string): unknown {
  const sinCerca = bruto.replace(/```(?:json)?/gi, '').trim()

  const inicio = sinCerca.indexOf('{')
  const fin = sinCerca.lastIndexOf('}')
  if (inicio === -1 || fin <= inicio) throw new Error('la respuesta no traía JSON')

  return JSON.parse(sinCerca.slice(inicio, fin + 1))
}

export async function classifyWithLlm(
  provider: LlmProvider,
  model: string | null,
  texto: string
): Promise<LlmClassification> {
  const prompt = `${INSTRUCCIONES}\n\n--- TEXTO ---\n${texto}`
  const bruto = await provider.run(prompt, model)
  return RespuestaSchema.parse(extraerJson(bruto))
}
