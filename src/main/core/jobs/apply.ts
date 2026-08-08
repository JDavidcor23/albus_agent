import { answerByRules } from './answers'
import { answerByLlm, type LlmTier } from './answers-llm'
import { classifyFileField } from './cv-name'
import { canClick, classifyButton, explainBlock } from './submit-guard'
import type { BrowserPort } from './ports'
import type {
  ApplyMode,
  ApplyOutcome,
  ApplyPlan,
  ApplyStep,
  CandidateProfile,
  FieldAnswer,
  FormButton,
  FormModel,
  JobPosting
} from './types'

/**
 * El bucle de postulación. Misma forma que `processBatch` de extracción: una
 * cosa por vez, nada que pueda tirar excepción hacia afuera, y el resultado
 * dice qué pasó aunque haya salido mal.
 *
 * Lo que NO hace, a propósito:
 * - no ejecuta JavaScript que venga del modelo (el modelo devuelve valores, no acciones)
 * - no toca un checkbox de consentimiento (eso lo firma el usuario)
 * - no aprieta submit salvo en modo `auto`
 */

/** Un formulario de 8 pantallas ya es raro; 12 clicks es un bucle roto. */
const MAX_PASOS = 12

export interface StagedKit {
  cvSource: string | null
  cvUpload: string | null
  coverSource: string | null
  coverUpload: string | null
}

export interface ApplyDeps {
  browser: BrowserPort
  profile: CandidateProfile
  kit: StagedKit
  llm: LlmTier | null
  mode: ApplyMode
  /** Dónde escribir los PNG. Un screenshot por paso. */
  screenshotDir: string
  onStep?: (step: ApplyStep) => void
}

/** Arma el plan de un paso sin tocar la página. Es la parte testeable. */
export async function planStep(
  form: FormModel,
  profile: CandidateProfile,
  kit: StagedKit,
  llm: LlmTier | null,
  posting: JobPosting | null,
  mode: ApplyMode
): Promise<ApplyPlan> {
  const { answers, pending, humanOnly } = answerByRules(form.fields, profile)

  let unresolved = [...pending, ...humanOnly]
  const todas = [...answers]

  // El escalón caro solo ve lo que quedó, y nunca los campos de consentimiento.
  if (llm !== null && pending.length > 0) {
    const delModelo = await answerByLlm(pending, profile, posting, llm)
    todas.push(...delModelo.answers)
    unresolved = [...delModelo.unresolved, ...humanOnly]
  }

  return {
    url: form.url,
    mode,
    answers: todas,
    unresolved,
    cvSourcePath: kit.cvSource,
    cvUploadPath: kit.cvUpload,
    coverSourcePath: kit.coverSource,
    coverUploadPath: kit.coverUpload
  }
}

/**
 * Firma del formulario visible. Si después de apretar "Siguiente" es idéntica,
 * el formulario no avanzó — probablemente hay una validación en rojo que
 * nosotros no vemos — y seguir clickeando no lo va a arreglar.
 */
function firma(form: FormModel): string {
  return `${form.url}::${form.fields.map((f) => `${f.kind}:${f.label}`).join('|')}`
}

function elegirBoton(buttons: FormButton[]): FormButton | null {
  return (
    buttons.find((b) => b.kind === 'next') ??
    buttons.find((b) => b.kind === 'submit') ??
    buttons.find((b) => b.kind === 'apply') ??
    null
  )
}

async function subirArchivos(
  deps: ApplyDeps,
  form: FormModel
): Promise<{ subidos: string[]; fallidos: string[] }> {
  const subidos: string[] = []
  const fallidos: string[] = []

  for (const field of form.fields) {
    if (field.kind !== 'file') continue

    const cual = classifyFileField(`${field.label} ${field.name} ${field.placeholder}`)
    // `unknown` cae al CV: si el formulario tiene un solo adjunto sin etiquetar,
    // es el CV en el 99% de los casos. La carta nunca va sin etiqueta explícita.
    const ruta =
      cual === 'cover' ? deps.kit.coverUpload : cual === 'cv' ? deps.kit.cvUpload : deps.kit.cvUpload

    if (ruta === null) continue

    try {
      await deps.browser.uploadFile(field.selector, ruta)
      subidos.push(ruta.replace(/\\/g, '/').split('/').pop() ?? ruta)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[jobs] no se pudo adjuntar en "${field.label}": ${message}`)
      fallidos.push(field.label)
    }
  }

  return { subidos, fallidos }
}

async function escribir(deps: ApplyDeps, form: FormModel, answers: FieldAnswer[]): Promise<number> {
  const porId = new Map(form.fields.map((f) => [f.id, f]))
  let escritos = 0

  for (const a of answers) {
    if (a.source === 'prefilled') continue
    const field = porId.get(a.fieldId)
    if (field === undefined) continue

    try {
      await deps.browser.fill(field.selector, a.value)
      escritos++
    } catch (error: unknown) {
      // Un campo que no se deja escribir (oculto, deshabilitado, un typeahead
      // que se cerró) no puede tirar abajo los otros catorce.
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[jobs] no se pudo llenar "${a.label}": ${message}`)
    }
  }

  return escritos
}

export async function runApply(
  deps: ApplyDeps,
  posting: JobPosting | null,
  url: string
): Promise<ApplyOutcome> {
  const steps: ApplyStep[] = []
  const unresolved = new Set<string>()
  const uploadedAs = new Set<string>()

  const salida = (status: ApplyOutcome['status'], message: string): ApplyOutcome => ({
    status,
    url,
    mode: deps.mode,
    steps,
    unresolved: [...unresolved],
    uploadedAs: [...uploadedAs],
    message
  })

  try {
    await deps.browser.open(url)
  } catch (error: unknown) {
    return salida('failed', error instanceof Error ? error.message : String(error))
  }

  let anterior = ''

  for (let i = 0; i < MAX_PASOS; i++) {
    let form: FormModel
    try {
      form = await deps.browser.readForm()
    } catch (error: unknown) {
      return salida('failed', `no se pudo leer el formulario: ${String(error)}`)
    }

    const actual = firma(form)
    const estancado = actual === anterior
    anterior = actual

    // Sin campos: o todavía no abrimos el modal, o ya terminamos.
    if (form.fields.length === 0) {
      const abrir = form.buttons.find((b) => b.kind === 'apply')
      if (abrir !== null && abrir !== undefined && !estancado) {
        if (!canClick('apply', deps.mode)) {
          return salida('planned', explainBlock('apply', deps.mode))
        }
        await deps.browser.click(abrir.selector)
        steps.push({
          index: i,
          url: form.url,
          filled: 0,
          skipped: 0,
          unresolved: [],
          screenshot: null,
          action: `abrir: ${abrir.label}`
        })
        continue
      }
      return salida(
        steps.length === 0 ? 'blocked' : 'filled',
        steps.length === 0
          ? 'no encontré formulario ni botón de postulación en esa página'
          : 'no quedan campos por llenar'
      )
    }

    const plan = await planStep(form, deps.profile, deps.kit, deps.llm, posting, deps.mode)
    for (const u of plan.unresolved) unresolved.add(u.label || u.name || u.id)

    if (deps.mode === 'dry-run') {
      steps.push({
        index: i,
        url: form.url,
        filled: 0,
        skipped: plan.answers.length,
        unresolved: plan.unresolved.map((f) => f.label),
        screenshot: null,
        action: 'dry-run: no se escribió nada'
      })
      return salida('planned', `plan listo: ${plan.answers.length} campos resolubles`)
    }

    const escritos = await escribir(deps, form, plan.answers)
    const archivos = await subirArchivos(deps, form)
    for (const nombre of archivos.subidos) uploadedAs.add(nombre)

    let shot: string | null = null
    try {
      shot = await deps.browser.screenshot(`${deps.screenshotDir}/paso-${i + 1}.png`)
    } catch {
      // Un screenshot es evidencia, no un requisito. Si falla, seguimos.
    }

    const boton = elegirBoton(form.buttons)
    // La clasificación que vale es la del main sobre el texto, no la que vino
    // de la página: el DOM es input externo como cualquier otro.
    const kind = boton === null ? 'other' : classifyButton(boton.label)

    steps.push({
      index: i,
      url: form.url,
      filled: escritos,
      skipped: plan.answers.length - escritos,
      unresolved: plan.unresolved.map((f) => f.label),
      screenshot: shot,
      action: boton === null ? 'sin botón de avance' : `${kind}: ${boton.label}`
    })
    deps.onStep?.(steps[steps.length - 1])

    if (boton === null) {
      return salida('filled', 'campos llenados; no encontré el botón para avanzar')
    }

    if (!canClick(kind, deps.mode)) {
      return salida('filled', explainBlock(kind, deps.mode))
    }

    if (estancado && i > 0) {
      return salida(
        'blocked',
        'el formulario no avanza: probablemente hay un campo obligatorio que no pude responder'
      )
    }

    await deps.browser.click(boton.selector)

    if (kind === 'submit') {
      return salida('submitted', 'postulación enviada')
    }
  }

  return salida('blocked', `me pasé de ${MAX_PASOS} pasos sin terminar`)
}
