import { z } from 'zod'
import type { LlmProvider } from '../extraction/llm-port'
import { resolveOption } from './answers'
import type { CandidateProfile, FieldAnswer, FormField, JobPosting } from './types'

/**
 * Escalón 4 de la cascada de postulación: el único que gasta cuota. Recibe
 * SOLO los campos que las reglas no resolvieron, nunca el formulario entero.
 *
 * El modelo mapea campos a respuestas y nada más. No emite selectores, no
 * emite JavaScript, no decide si enviar. El ejecutor es código determinista y
 * lo que vuelve de acá se valida con zod y se vuelve a pasar por
 * `resolveOption` — un valor que no está entre las opciones se descarta igual
 * que si lo hubiera propuesto una regla.
 */

const RespuestaSchema = z.object({
  fieldId: z.string(),
  value: z.string(),
  confidence: z.number().min(0).max(1)
})

const LoteSchema = z.object({
  answers: z.array(RespuestaSchema)
})

function perfilResumido(p: CandidateProfile): string {
  const years = Object.entries(p.yearsExperience)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')

  return [
    `Nombre: ${p.fullName}`,
    `Email: ${p.email} | Teléfono: ${p.phoneCountryCode} ${p.phone}`,
    `Ubicación: ${p.city}, ${p.country} (${p.countryCode}). Solo remoto: ${p.remoteOnly}. Se muda: ${p.willingToRelocate}`,
    `LinkedIn: ${p.linkedinUrl} | GitHub: ${p.githubUrl} | Portfolio: ${p.portfolioUrl}`,
    `Actualmente: ${p.currentTitle} en ${p.currentCompany}. Headline: ${p.headline}`,
    `Años de experiencia: ${years}`,
    `Autorizado a trabajar: ${p.workAuthorized}. Necesita patrocinio de visa: ${p.requiresSponsorship}`,
    `Pretensión: USD ${p.expectedSalaryUsdMonthly}/mes. Preaviso: ${p.noticePeriodDays} días`,
    `Inglés: ${p.englishLevel}. Español: ${p.spanishLevel}`,
    `Educación máxima: ${p.highestEducation}`
  ].join('\n')
}

function describirCampo(f: FormField): string {
  const partes = [
    `id: ${f.id}`,
    `tipo: ${f.kind}`,
    `etiqueta: ${f.label || '(sin etiqueta)'}`,
    f.required ? 'obligatorio' : 'opcional'
  ]
  if (f.placeholder) partes.push(`placeholder: ${f.placeholder}`)
  if (f.maxLength !== null) partes.push(`máx ${f.maxLength} caracteres`)
  if (f.options.length > 0) {
    partes.push(`opciones: ${f.options.map((o) => o.label).join(' | ')}`)
  }
  return `- ${partes.join(' · ')}`
}

export function buildPrompt(
  fields: FormField[],
  p: CandidateProfile,
  posting: JobPosting | null
): string {
  const contexto =
    posting !== null ? `\nLa vacante es "${posting.role}" en ${posting.company}.\n` : '\n'

  return `Estás completando un formulario de postulación laboral en nombre del candidato descrito abajo.
${contexto}
PERFIL DEL CANDIDATO
${perfilResumido(p)}

CAMPOS SIN RESPONDER
${fields.map(describirCampo).join('\n')}

REGLAS
1. Respondé SOLO con los datos del perfil. Está terminantemente prohibido inventar experiencia, títulos, empresas o habilidades que el perfil no diga.
2. Si un campo no se puede responder con el perfil, OMITILO de la salida. Un campo vacío es correcto; una respuesta inventada arruina la postulación.
3. Si el campo tiene opciones, el value tiene que ser EXACTAMENTE una de esas etiquetas.
4. Para campos de texto libre largos (motivación, "por qué esta empresa"), escribí como máximo 4 oraciones, en primera persona, en el idioma de la etiqueta, sin clichés y sin afirmar nada que el perfil no respalde.
5. confidence: 0.9 si la respuesta sale directo del perfil, 0.6 si es una redacción tuya a partir del perfil, menos de 0.5 si dudás (y si dudás, mejor omitilo).

Devolvé SOLO un objeto JSON, sin markdown, sin explicación:
{"answers":[{"fieldId":"...","value":"...","confidence":0.9}]}`
}

/** Saca el primer objeto JSON del texto: los CLI a veces envuelven en ```json. */
function extraerJson(texto: string): unknown {
  const limpio = texto.replace(/^```(?:json)?/gm, '').replace(/```$/gm, '')
  const inicio = limpio.indexOf('{')
  const fin = limpio.lastIndexOf('}')
  if (inicio === -1 || fin <= inicio) throw new Error('el modelo no devolvió JSON')
  return JSON.parse(limpio.slice(inicio, fin + 1))
}

export interface LlmTier {
  provider: LlmProvider
  model: string | null
}

/**
 * Nunca tira. Si el CLI falla, si devuelve basura o si el modelo alucina un
 * fieldId que no existe, los campos quedan sin responder y se reportan. Una
 * postulación a medias que el usuario completa a mano vale más que un lote
 * frenado.
 */
export async function answerByLlm(
  fields: FormField[],
  p: CandidateProfile,
  posting: JobPosting | null,
  tier: LlmTier
): Promise<{ answers: FieldAnswer[]; unresolved: FormField[] }> {
  if (fields.length === 0) return { answers: [], unresolved: [] }

  const porId = new Map(fields.map((f) => [f.id, f]))

  let lote: z.infer<typeof LoteSchema>
  try {
    const salida = await tier.provider.run(buildPrompt(fields, p, posting), tier.model)
    lote = LoteSchema.parse(extraerJson(salida))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[jobs] el escalón LLM no resolvió nada: ${message}`)
    return { answers: [], unresolved: fields }
  }

  const answers: FieldAnswer[] = []
  const resueltos = new Set<string>()

  for (const r of lote.answers) {
    const field = porId.get(r.fieldId)
    // Un fieldId inventado se descarta en silencio: no hay dónde escribirlo.
    if (field === undefined) continue
    if (r.value.trim() === '') continue
    if (r.confidence < 0.5) continue

    const valor = resolveOption(field, r.value)
    if (valor === null) continue

    answers.push({
      fieldId: field.id,
      label: field.label,
      value: valor,
      source: 'llm',
      rule: '',
      confidence: r.confidence
    })
    resueltos.add(field.id)
  }

  return { answers, unresolved: fields.filter((f) => !resueltos.has(f.id)) }
}
