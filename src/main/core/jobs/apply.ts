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
const MAX_STEPS = 12

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
  const all = [...answers]

  // El escalón caro solo ve lo que quedó, y nunca los campos de consentimiento.
  if (llm !== null && pending.length > 0) {
    const fromModel = await answerByLlm(pending, profile, posting, llm)
    all.push(...fromModel.answers)
    unresolved = [...fromModel.unresolved, ...humanOnly]
  }

  return {
    url: form.url,
    mode,
    answers: all,
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
function signature(form: FormModel): string {
  return `${form.url}::${form.fields.map((f) => `${f.kind}:${f.label}`).join('|')}`
}

function pickButton(buttons: FormButton[]): FormButton | null {
  return (
    buttons.find((b) => b.kind === 'next') ??
    buttons.find((b) => b.kind === 'submit') ??
    buttons.find((b) => b.kind === 'apply') ??
    null
  )
}

async function uploadFiles(
  deps: ApplyDeps,
  form: FormModel
): Promise<{ uploaded: string[]; failed: string[] }> {
  const uploaded: string[] = []
  const failed: string[] = []

  for (const field of form.fields) {
    if (field.kind !== 'file') continue

    const which = classifyFileField(`${field.label} ${field.name} ${field.placeholder}`)
    // `unknown` cae al CV: si el formulario tiene un solo adjunto sin etiquetar,
    // es el CV en el 99% de los casos. La carta nunca va sin etiqueta explícita.
    const path =
      which === 'cover'
        ? deps.kit.coverUpload
        : which === 'cv'
          ? deps.kit.cvUpload
          : deps.kit.cvUpload

    if (path === null) continue

    try {
      await deps.browser.uploadFile(field.selector, path)
      uploaded.push(path.replace(/\\/g, '/').split('/').pop() ?? path)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[jobs] no se pudo adjuntar en "${field.label}": ${message}`)
      failed.push(field.label)
    }
  }

  return { uploaded, failed }
}

async function fillFields(
  deps: ApplyDeps,
  form: FormModel,
  answers: FieldAnswer[]
): Promise<number> {
  const byId = new Map(form.fields.map((f) => [f.id, f]))
  let count = 0

  for (const a of answers) {
    if (a.source === 'prefilled') continue
    const field = byId.get(a.fieldId)
    if (field === undefined) continue

    try {
      await deps.browser.fill(field.selector, a.value)
      count++
    } catch (error: unknown) {
      // Un campo que no se deja escribir (oculto, deshabilitado, un typeahead
      // que se cerró) no puede tirar abajo los otros catorce.
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[jobs] no se pudo llenar "${a.label}": ${message}`)
    }
  }

  return count
}

export async function runApply(
  deps: ApplyDeps,
  posting: JobPosting | null,
  url: string
): Promise<ApplyOutcome> {
  const steps: ApplyStep[] = []
  const unresolved = new Set<string>()
  const uploadedAs = new Set<string>()

  const finish = (status: ApplyOutcome['status'], message: string): ApplyOutcome => ({
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
    return finish('failed', error instanceof Error ? error.message : String(error))
  }

  let previous = ''

  for (let i = 0; i < MAX_STEPS; i++) {
    let form: FormModel
    try {
      form = await deps.browser.readForm()
    } catch (error: unknown) {
      return finish('failed', `no se pudo leer el formulario: ${String(error)}`)
    }

    const current = signature(form)
    const stalled = current === previous
    previous = current

    // Sin campos: o todavía no abrimos el modal, o ya terminamos.
    if (form.fields.length === 0) {
      const openButton = form.buttons.find((b) => b.kind === 'apply')
      if (openButton !== null && openButton !== undefined && !stalled) {
        if (!canClick('apply', deps.mode)) {
          return finish('planned', explainBlock('apply', deps.mode))
        }
        await deps.browser.click(openButton.selector)
        steps.push({
          index: i,
          url: form.url,
          filled: 0,
          skipped: 0,
          unresolved: [],
          screenshot: null,
          action: `abrir: ${openButton.label}`
        })
        continue
      }
      return finish(
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
      return finish('planned', `plan listo: ${plan.answers.length} campos resolubles`)
    }

    const filledCount = await fillFields(deps, form, plan.answers)
    const files = await uploadFiles(deps, form)
    for (const name of files.uploaded) uploadedAs.add(name)

    let shot: string | null = null
    try {
      shot = await deps.browser.screenshot(`${deps.screenshotDir}/paso-${i + 1}.png`)
    } catch {
      // Un screenshot es evidencia, no un requisito. Si falla, seguimos.
    }

    const button = pickButton(form.buttons)
    // La clasificación que vale es la del main sobre el texto, no la que vino
    // de la página: el DOM es input externo como cualquier otro.
    const kind = button === null ? 'other' : classifyButton(button.label)

    steps.push({
      index: i,
      url: form.url,
      filled: filledCount,
      skipped: plan.answers.length - filledCount,
      unresolved: plan.unresolved.map((f) => f.label),
      screenshot: shot,
      action: button === null ? 'sin botón de avance' : `${kind}: ${button.label}`
    })
    deps.onStep?.(steps[steps.length - 1])

    if (button === null) {
      return finish('filled', 'campos llenados; no encontré el botón para avanzar')
    }

    if (!canClick(kind, deps.mode)) {
      return finish('filled', explainBlock(kind, deps.mode))
    }

    if (stalled && i > 0) {
      return finish(
        'blocked',
        'el formulario no avanza: probablemente hay un campo obligatorio que no pude responder'
      )
    }

    await deps.browser.click(button.selector)

    if (kind === 'submit') {
      return finish('submitted', 'postulación enviada')
    }
  }

  return finish('blocked', `me pasé de ${MAX_STEPS} pasos sin terminar`)
}
