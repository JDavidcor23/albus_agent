import type { CandidateProfile, FieldAnswer, FormField } from './types'

/**
 * Escalón barato de la cascada de postulación: reglas puras sobre el texto del
 * campo. Resuelve la enorme mayoría de un Easy Apply / Greenhouse / Lever sin
 * gastar un token. Lo que quede sin resolver lo mira el LLM (answers-llm.ts).
 *
 * Nada acá adivina. Un campo que la regla no reconoce vuelve sin respuesta, y
 * un campo cuyo `select` no tiene ninguna opción compatible también. Inventar
 * una respuesta en una postulación es peor que dejarla vacía.
 */

/** Minúsculas, sin acentos, espacios colapsados. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Todo lo que el campo dice de sí mismo, junto. */
export function haystack(field: FormField): string {
  return normalize([field.label, field.name, field.placeholder].filter(Boolean).join(' | '))
}

/**
 * Campos que NO contesta ni la regla ni el modelo. Aceptar términos, autorizar
 * el tratamiento de datos o declarar algo bajo juramento es un acto del
 * usuario: que lo tilde él, que para eso el modo `review` ya lo deja mirando
 * la pantalla. Un tilde automático acá es firmar en nombre de otro.
 */
const SOLO_HUMANO =
  /(agree|consent|accept|acknowledg|certify|declare|acepto|autorizo|consiento|declaro)\b/

export function requiereHumano(field: FormField): boolean {
  if (field.kind !== 'checkbox' && field.kind !== 'radio') return false
  return SOLO_HUMANO.test(haystack(field))
}

interface Rule {
  id: string
  match: RegExp
  /** Si esto matchea, la regla se saltea aunque `match` haya dado. */
  avoid?: RegExp
  /** `null` = la regla reconoció el campo pero el perfil no lo puede contestar. */
  answer: (p: CandidateProfile, field: FormField, hay: string) => string | null
}

function siNo(valor: boolean): string {
  return valor ? 'Yes' : 'No'
}

/**
 * Tecnologías que existen en el mundo y que el perfil puede no tener. Si la
 * pregunta nombra una de estas y el perfil no declara años para ella, la
 * respuesta correcta es "no sé", no el total de la carrera.
 *
 * No pretende ser exhaustiva: es la lista de los falsos positivos caros, los
 * stacks que aparecen todo el tiempo en vacantes que igual te llegan al feed.
 */
const TECNOLOGIAS = [
  'python',
  'java',
  'php',
  'ruby',
  'rails',
  'golang',
  'rust',
  'c#',
  '.net',
  'angular',
  'vue',
  'svelte',
  'django',
  'flask',
  'laravel',
  'spring',
  'kotlin',
  'swift',
  'objective-c',
  'aem',
  'adobe experience manager',
  'salesforce',
  'sap',
  'sql server',
  'oracle',
  'mongodb',
  'kubernetes',
  'terraform',
  'aws',
  'azure',
  'gcp',
  'scala',
  'elixir',
  'symfony',
  'wordpress',
  'drupal',
  'shopify',
  'magento',
  'flutter',
  'react native',
  'unity',
  'tableau',
  'power bi',
  'snowflake',
  'databricks',
  'hadoop',
  'spark',
  'kafka',
  'sitecore',
  'contentful'
]

/** "…do you have with X?" — la plantilla literal de LinkedIn Easy Apply. */
const CALIFICADOR = /\b(with|using|con|usando)\s+[a-z0-9+#.]/

/**
 * Cuántos años con X. Busca la tecnología más específica mencionada — así
 * "typescript" le gana a "script" — y si la pregunta nombra algo que NO está
 * en la tabla devuelve null.
 *
 * Null y no el default: contestar "4 años" a "¿cuántos años con Python?"
 * porque 4 es el total de su carrera es inventar experiencia, y es
 * exactamente el tipo de mentira que revienta en la primera entrevista
 * técnica. Sin respuesta el campo sube al modelo, que tiene la tabla entera
 * delante y la instrucción de no inventar.
 */
export function yearsFor(p: CandidateProfile, hay: string): string | null {
  const claves = Object.keys(p.yearsExperience)
    .filter((k) => k !== 'default')
    .sort((a, b) => b.length - a.length)

  for (const clave of claves) {
    if (hay.includes(normalize(clave))) return String(p.yearsExperience[clave])
  }

  // Nombra un stack concreto que el perfil no declara.
  if (TECNOLOGIAS.some((t) => hay.includes(t))) return null
  // O usa la plantilla "…with <algo>" sin que ese algo esté en la tabla.
  if (CALIFICADOR.test(hay)) return null

  // Queda la pregunta genérica: "how many years of professional experience".
  return String(p.yearsExperience.default)
}

const REGLAS: Rule[] = [
  // ── identidad ────────────────────────────────────────────────────────────
  {
    id: 'first-name',
    match: /\b(first|given)[\s_-]*name\b|primer[\s_-]*nombre|^nombres?$/,
    answer: (p) => p.firstName
  },
  {
    id: 'last-name',
    match: /\b(last|family|sur)[\s_-]*name\b|apellidos?/,
    answer: (p) => p.lastName
  },
  {
    id: 'full-name',
    match: /\b(full|complete|legal)[\s_-]*name\b|nombre completo|^name$|^nombre$|\bname\b/,
    avoid: /user|company|file|referr|manager|recruiter|universit|school|college|emergency|empresa/,
    answer: (p) => p.fullName
  },

  // ── contacto ─────────────────────────────────────────────────────────────
  { id: 'email', match: /e-?mail|correo/, answer: (p) => p.email },
  {
    // Antes que `phone`: LinkedIn parte el teléfono en dos campos y el select
    // de código de país matchea "phone" igual que la caja del número.
    id: 'phone-country-code',
    match: /(country|phone)[\s_-]*code|codigo[\s_-]*(de[\s_-]*)?pais|prefijo/,
    answer: (p) => p.phoneCountryCode
  },
  {
    id: 'phone',
    match: /\bphone\b|\bmobile\b|celular|telefono|\btel\b|numero de contacto/,
    answer: (p) => p.phone
  },

  // ── links ────────────────────────────────────────────────────────────────
  { id: 'linkedin', match: /linked-?in/, answer: (p) => p.linkedinUrl },
  { id: 'github', match: /git-?hub/, answer: (p) => p.githubUrl },
  {
    id: 'portfolio',
    match: /portfolio|portafolio|personal (web)?site|\bwebsite\b|\bweb site\b|sitio web/,
    avoid: /linked-?in|git-?hub|company/,
    answer: (p) => p.portfolioUrl
  },

  // ── ubicación ────────────────────────────────────────────────────────────
  {
    // Antes que `city`, si no "country of residence" se lleva la ciudad.
    id: 'country',
    match: /\bcountry\b|\bpais\b/,
    avoid: /code|codigo|phone|telefono/,
    answer: (p) => p.country
  },
  {
    id: 'city',
    match: /\bcity\b|ciudad|\blocation\b|ubicacion|where are you (located|based)|residenc/,
    avoid: /relocat|company|office|job|puesto/,
    answer: (p) => `${p.city}, ${p.country}`
  },

  // ── experiencia ──────────────────────────────────────────────────────────
  {
    id: 'years-experience',
    match:
      /(years?|anos)[^a-z]{0,30}(experience|experiencia)|experience[^a-z]{0,20}(years?|anos)|how many years|cuantos anos/,
    answer: (p, _f, hay) => yearsFor(p, hay)
  },
  {
    id: 'current-company',
    match: /current (employer|company)|empresa actual|employer name/,
    answer: (p) => p.currentCompany
  },
  {
    id: 'current-title',
    match: /current (job )?(title|role|position)|cargo actual|puesto actual|current position/,
    answer: (p) => p.currentTitle
  },
  { id: 'headline', match: /headline|titular profesional/, answer: (p) => p.headline },

  // ── elegibilidad ─────────────────────────────────────────────────────────
  {
    // "authorized to work WITHOUT sponsorship" invierte la respuesta respecto
    // de "do you REQUIRE sponsorship". Es la trampa clásica de estos forms.
    id: 'sponsorship',
    match: /sponsor|\bvisa\b|patrocinio/,
    answer: (p, _f, hay) =>
      /without sponsor|no sponsor|sin patrocinio/.test(hay)
        ? siNo(!p.requiresSponsorship)
        : siNo(p.requiresSponsorship)
  },
  {
    id: 'work-authorization',
    match:
      /(legally )?authoriz|work permit|right to work|eligible to work|autorizacion.{0,20}trabaj|permiso de trabajo/,
    answer: (p) => siNo(p.workAuthorized)
  },
  {
    id: 'relocate',
    match: /relocat|reubica|mudar|willing to move|traslad/,
    answer: (p) => siNo(p.willingToRelocate)
  },
  {
    id: 'remote-comfort',
    match: /(comfortable|willing|able|open)[^a-z]{0,25}(remote|work from home|remoto)/,
    answer: () => 'Yes'
  },

  // ── condiciones ──────────────────────────────────────────────────────────
  {
    id: 'salary',
    match:
      /salary|compensation|expected pay|desired pay|pretension|aspiracion salarial|remuneracion|\brate\b/,
    answer: (p, f) =>
      f.kind === 'number'
        ? String(p.expectedSalaryUsdMonthly)
        : `USD ${p.expectedSalaryUsdMonthly.toLocaleString('en-US')} / month`
  },
  {
    id: 'notice-period',
    match:
      /notice period|available to start|start date|availability|disponibilidad|preaviso|when can you start|cuando puedes empezar/,
    answer: (p) =>
      p.noticePeriodDays === 0 ? 'Immediately' : `${p.noticePeriodDays} days notice period`
  },

  // ── idiomas ──────────────────────────────────────────────────────────────
  { id: 'english', match: /english|ingles/, answer: (p) => p.englishLevel },
  { id: 'spanish', match: /spanish|espanol/, answer: (p) => p.spanishLevel },

  // ── varios ───────────────────────────────────────────────────────────────
  {
    id: 'education',
    match:
      /(highest )?(level of )?education|\bdegree\b|nivel educativo|titulo academico|formacion academica/,
    answer: (p) => p.highestEducation
  },
  {
    id: 'how-heard',
    match: /how did you hear|how.{0,15}find (out )?about|como te enteraste|referral source/,
    answer: () => 'LinkedIn'
  },
  {
    // EEO de Greenhouse/Workday. Declinar es una respuesta válida y es la que
    // el perfil declara; no es el modelo eligiendo por él.
    id: 'eeo',
    match:
      /\bgender\b|\brace\b|ethnic|veteran|disabilit|hispanic|latino|self-identif|genero|etnia|discapacidad|orientacion sexual/,
    answer: (p) => p.declineToSelfIdentify
  }
]

/**
 * Elige la opción del select/radio que corresponde al valor buscado. Devuelve
 * null si ninguna encaja — un select con 40 países y ninguno que sea el suyo
 * es un campo sin respuesta, no una excusa para mandar el primero.
 */
export function resolveOption(field: FormField, deseado: string): string | null {
  if (field.options.length === 0) return deseado

  const objetivo = normalize(deseado)
  const opciones = field.options.map((o) => ({
    ...o,
    nLabel: normalize(o.label),
    nValue: normalize(o.value)
  }))

  const exacta = opciones.find((o) => o.nLabel === objetivo || o.nValue === objetivo)
  if (exacta) return exacta.value

  // Sí/No: casi todos los radios de elegibilidad. "Yes, I am authorized" cuenta.
  if (objetivo === 'yes' || objetivo === 'no') {
    const busca = objetivo === 'yes' ? /^(yes|si)\b/ : /^no\b/
    const evita = objetivo === 'yes' ? /^no\b/ : /^(yes|si)\b/
    const yn = opciones.find((o) => busca.test(o.nLabel) && !evita.test(o.nLabel))
    if (yn) return yn.value
  }

  // Un número contra rangos: "1-3 years", "3 to 5", "5+".
  const numero = Number(objetivo)
  if (Number.isFinite(numero) && objetivo !== '') {
    const enRango = opciones.find((o) => rangoContiene(o.nLabel, numero))
    if (enRango) return enRango.value
  }

  const contiene = opciones.find((o) => o.nLabel.includes(objetivo) || objetivo.includes(o.nLabel))
  if (contiene) return contiene.value

  // La primera palabra significativa: "Bogotá, Colombia" contra "Colombia".
  const primera = objetivo.split(/[\s,]+/)[0]
  if (primera.length >= 4) {
    const parcial = opciones.find((o) => o.nLabel.includes(primera))
    if (parcial) return parcial.value
  }

  return null
}

function rangoContiene(label: string, n: number): boolean {
  const rango = label.match(/(\d+)\s*(?:-|–|to|a)\s*(\d+)/)
  if (rango) return n >= Number(rango[1]) && n <= Number(rango[2])

  const masDe = label.match(/(\d+)\s*\+|more than\s*(\d+)|mas de\s*(\d+)/)
  if (masDe) return n >= Number(masDe[1] ?? masDe[2] ?? masDe[3])

  const menosDe = label.match(/less than\s*(\d+)|menos de\s*(\d+)|under\s*(\d+)/)
  if (menosDe) return n < Number(menosDe[1] ?? menosDe[2] ?? menosDe[3])

  const solo = label.match(/^(\d+)$/)
  if (solo) return Number(solo[1]) === n

  return false
}

export interface RuleOutcome {
  answers: FieldAnswer[]
  /** Campos que ninguna regla resolvió. Van al escalón del LLM. */
  pending: FormField[]
  /** Campos que el usuario tiene que tocar a mano. No van al LLM. */
  humanOnly: FormField[]
}

/** Escalón 1-3 completo: prellenado válido, reglas, y resolución de opciones. */
export function answerByRules(fields: FormField[], p: CandidateProfile): RuleOutcome {
  const answers: FieldAnswer[] = []
  const pending: FormField[] = []
  const humanOnly: FormField[] = []

  for (const field of fields) {
    // Los archivos los maneja apply.ts: sabe cuál es el CV y cuál la carta.
    if (field.kind === 'file') continue

    if (requiereHumano(field)) {
      humanOnly.push(field)
      continue
    }

    const hay = haystack(field)
    const regla = REGLAS.find((r) => r.match.test(hay) && !(r.avoid?.test(hay) ?? false))

    if (!regla) {
      // Un campo ya cargado por el sitio y que nadie reclama se deja como está.
      if (field.value.trim() !== '') {
        answers.push({
          fieldId: field.id,
          label: field.label,
          value: field.value,
          source: 'prefilled',
          rule: '',
          confidence: 0.5
        })
      } else {
        pending.push(field)
      }
      continue
    }

    const crudo = regla.answer(p, field, hay)
    if (crudo === null) {
      pending.push(field)
      continue
    }

    const valor = resolveOption(field, crudo)
    if (valor === null) {
      // La regla supo qué contestar pero el select no tiene esa opción. Que lo
      // mire el modelo con la lista de opciones delante.
      pending.push(field)
      continue
    }

    answers.push({
      fieldId: field.id,
      label: field.label,
      value: valor,
      source: 'rule',
      rule: regla.id,
      confidence: 0.95
    })
  }

  return { answers, pending, humanOnly }
}
