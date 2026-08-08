/**
 * Dominio de postulación. No importa electron, no importa fs: son datos y
 * funciones puras. El navegador entra por un puerto (ver ports.ts).
 */

/** El candidato como DATO. Vive en un JSON del workspace, nunca hardcodeado. */
export interface CandidateProfile {
  firstName: string
  lastName: string
  fullName: string
  email: string
  /** Sin código de país. El código va aparte porque medio formulario lo pide separado. */
  phone: string
  phoneCountryCode: string
  /** Nombre del país tal como lo escriben los formularios en inglés. */
  country: string
  countryCode: string
  city: string
  linkedinUrl: string
  githubUrl: string
  portfolioUrl: string
  headline: string
  currentCompany: string
  currentTitle: string
  /**
   * Años por tecnología, en minúsculas. La clave `default` es la respuesta
   * cuando la pregunta menciona algo que no está en la tabla.
   */
  yearsExperience: Record<string, number>
  /** Ej. "Yes, I am legally authorized to work in Colombia". */
  workAuthorized: boolean
  requiresSponsorship: boolean
  willingToRelocate: boolean
  remoteOnly: boolean
  expectedSalaryUsdMonthly: number
  noticePeriodDays: number
  englishLevel: string
  spanishLevel: string
  highestEducation: string
  /**
   * Base del nombre con que se sube el CV, SIN extensión.
   * El pedido explícito del usuario: nunca "main_empresa.pdf".
   */
  cvFileBaseName: string
  coverFileBaseName: string
  /** Respuesta por defecto para los campos EEO/diversidad de Greenhouse y Workday. */
  declineToSelfIdentify: string
}

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'number'
  | 'tel'
  | 'email'
  | 'url'
  | 'date'
  | 'unknown'

export interface FieldOption {
  value: string
  label: string
}

export interface FormField {
  /** Id que estampamos nosotros en el DOM. Estable dentro de una lectura. */
  id: string
  /** Siempre `[data-albus-fid="..."]`. No dependemos de los selectores del sitio. */
  selector: string
  kind: FieldKind
  /** Label, aria-label, placeholder o el texto cercano — lo que haya. */
  label: string
  name: string
  placeholder: string
  required: boolean
  /** Lo que el campo ya trae. Un campo prellenado correcto no se toca. */
  value: string
  options: FieldOption[]
  maxLength: number | null
}

export type ButtonKind = 'submit' | 'next' | 'apply' | 'other'

export interface FormButton {
  selector: string
  label: string
  kind: ButtonKind
}

export interface FormModel {
  url: string
  title: string
  fields: FormField[]
  buttons: FormButton[]
}

export type AnswerSource = 'rule' | 'llm' | 'prefilled' | 'unresolved'

export interface FieldAnswer {
  fieldId: string
  label: string
  /** Para `file` es la ruta absoluta ya renombrada. Para el resto, el texto. */
  value: string
  source: AnswerSource
  /** Qué regla lo resolvió. Vacío si vino del LLM. */
  rule: string
  confidence: number
}

/**
 * `dry-run` no toca la página, solo dice qué haría.
 * `review` llena todo y frena antes del submit — el default, a propósito.
 * `auto` envía. Existe porque el usuario lo pidió; no es el default porque el
 * envío automatizado va contra el ToS de LinkedIn y el que arriesga la cuenta
 * es él.
 */
export type ApplyMode = 'dry-run' | 'review' | 'auto'

export interface ApplyPlan {
  url: string
  mode: ApplyMode
  answers: FieldAnswer[]
  /** Campos que ni las reglas ni el LLM pudieron contestar. Se reportan, no se inventan. */
  unresolved: FormField[]
  cvSourcePath: string | null
  cvUploadPath: string | null
  coverSourcePath: string | null
  coverUploadPath: string | null
}

export type ApplyStatus =
  | 'planned'
  | 'filled'
  | 'submitted'
  | 'needs-login'
  | 'blocked'
  | 'failed'

export interface ApplyStep {
  index: number
  url: string
  filled: number
  skipped: number
  unresolved: string[]
  screenshot: string | null
  action: string
}

export interface ApplyOutcome {
  status: ApplyStatus
  url: string
  mode: ApplyMode
  steps: ApplyStep[]
  /** Campos sin respuesta acumulados en todos los pasos. */
  unresolved: string[]
  uploadedAs: string[]
  message: string
}

/** Lo mínimo que identifica una oferta para armar el kit y trackearla. */
export interface JobPosting {
  url: string
  company: string
  role: string
  /** Slug del workspace: `main_<slug>.pdf` / `cover_<slug>*.pdf`. */
  slug: string
}
