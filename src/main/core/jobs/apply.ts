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
  /** La EVIDENCIA de un paso terminado. Llega tarde a propósito: ya pasó. */
  onStep?: (step: ApplyStep) => void
  /**
   * Qué está pasando AHORA. Ruido, no evidencia.
   *
   * `onStep` se emite al final de cada vuelta, después de leer el formulario,
   * llamar al modelo por cada campo, llenar y sacar la captura. Eso son minutos
   * en los que el usuario no ve absolutamente nada y no puede distinguir
   * "trabajando" de "colgado" — reclamo textual: *"le di postular y se quedó
   * ahí, no sé si lo está haciendo o no"*.
   */
  onProgress?: (detail: string) => void
  /**
   * Lo que la página OFRECE, apenas se lee y antes de decidir nada.
   *
   * No es lo mismo que `onStep` —evidencia de lo ya hecho— ni que `onProgress`
   * —ruido para la UI—: esto es el INSUMO de la decisión. Sin él, "no encontré
   * el botón para avanzar" es una afirmación incontestable: no se puede saber
   * si la página no tenía botón, si lo tenía con un texto que `classifyButton`
   * no reconoce, o si el click abrió el ATS en otra pestaña y nunca salimos de
   * LinkedIn. Los tres se ven igual desde afuera —la ventana quieta— y se
   * arreglan distinto.
   *
   * El dominio no imprime nada: recibe la función y la llama. Quien la escribe
   * en una consola es el adaptador (`jobs/apply-runner.ts`).
   */
  onLook?: (form: FormModel) => void
  /**
   * El agente que MIRA la pantalla, para cuando leer el DOM no alcanza.
   *
   * ## Por qué existe
   *
   * Todo lo de arriba es determinista: se lee el formulario, se clasifica cada
   * botón por su texto y se elige uno. Eso funciona DENTRO de un formulario —un
   * Greenhouse tiene "Submit application" y no hay mucho margen— y falla en el
   * paso de LLEGAR a ese formulario, que es una pantalla ajena con la palabra
   * que se le ocurrió a LinkedIn ese trimestre, en el idioma del usuario.
   *
   * Ampliar la lista de palabras es la solución equivocada, y este repositorio ya
   * lo aprendió y lo escribió en `.claude/docs/connections.md`: *"automatizar la
   * UI de un tercero con `clickText(['new integration'])` es apostar a que el
   * botón siga diciendo eso. Se perdió dos veces"*. Ahí la conclusión fue
   * `achieveGoal`: el objetivo se declara en castellano y el modelo mira la
   * página. Este bucle nunca recibió esa conclusión.
   *
   * ## Dónde se corta
   *
   * El agente resuelve NAVEGACIÓN: llegar al formulario. No llena campos —eso
   * son las reglas y `answerByLlm`— y **no envía nada**. Esa frontera no es
   * timidez: `canClick` es determinista porque enviar es irreversible, y un
   * agente con permiso de apretar cualquier cosa la saltearía por definición.
   *
   * Opcional a propósito: sin CLI instalado no hay quien mire, y el bucle sigue
   * andando con lo determinista en vez de fallar.
   */
  navigate?: (goal: string) => Promise<{ ok: boolean; detail: string }>
}

/**
 * El objetivo del agente. En castellano y sin un solo texto de botón adentro.
 *
 * Misma regla que los objetivos de `connections/services.ts`: dice QUÉ tiene que
 * ser verdad al terminar, no qué apretar. "Apretá el botón que dice Solicitar"
 * es código disfrazado de dato — se cae cuando LinkedIn lo renombra, cuando la
 * interfaz está en otro idioma y cuando la empresa usa un ATS que lo llama
 * distinto. "Llegar al formulario" sobrevive a las tres.
 */
const REACH_FORM_GOAL =
  'Llegar al formulario de postulación de esta vacante y dejarlo a la vista. ' +
  'El control que lo abre puede ser un botón o un LINK que lleve al sitio de la ' +
  'empresa, y su texto cambia según el idioma y el sitio: reconocelo por lo que ' +
  'HACE, no por lo que dice. ' +
  'NO envíes ninguna postulación, no confirmes nada y no aceptes ninguna oferta ' +
  'de pago ni de suscripción: tu único objetivo es que el formulario quede ' +
  'abierto para que otro lo complete.'

/**
 * DOS turnos de agente por corrida: uno para llegar, uno para rescatar.
 *
 * El primero se gasta antes de que el bucle toque nada —el agente decide cómo
 * llegar al formulario—. El segundo queda para cuando la lectura determinista se
 * queda sin camino a mitad del flujo, que es un caso distinto y merece otra
 * mirada.
 *
 * No más que eso: `achieveGoal` ya mira-actúa-mira hasta cinco veces adentro, y
 * el bucle exterior da hasta 12 vueltas. Sin este techo una vacante rara costaría
 * sesenta llamadas al modelo.
 */
const MAX_AGENT_TURNS = 2

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

/**
 * El botón para AVANZAR dentro de un formulario que ya estamos llenando.
 *
 * `next` antes que `submit` porque un formulario de varias pantallas tiene los
 * dos y hay que agotar los pasos antes de llegar al final. Y no hay tercera
 * opción: el `apply` que había se fue con la regex `OPEN` — llegar al formulario
 * no es "avanzar", es navegación, y de eso se ocupa el agente.
 */
function pickButton(buttons: FormButton[]): FormButton | null {
  return (
    buttons.find((b) => b.kind === 'next') ?? buttons.find((b) => b.kind === 'submit') ?? null
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

  let agentTurns = 0

  /**
   * El escalón del agente. Se le da un objetivo, no un botón.
   *
   * Devuelve `true` si hizo algo y vale la pena volver a mirar la página. El
   * paso queda registrado como cualquier otro: lo que el agente hizo es
   * evidencia, no un detalle interno.
   */
  const reachFormWithAgent = async (i: number, currentUrl: string): Promise<boolean> => {
    if (deps.navigate === undefined) return false
    if (agentTurns >= MAX_AGENT_TURNS) return false
    agentTurns++

    deps.onProgress?.('leyendo la página no lo encontré — el agente va a mirarla')

    const before = deps.browser.currentUrl()

    let result: { ok: boolean; detail: string }
    try {
      result = await deps.navigate(REACH_FORM_GOAL)
    } catch (error: unknown) {
      // Un agente que explota no puede tirar abajo la postulación: se registra
      // y el bucle termina con lo determinista, igual que sin CLI.
      result = { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }

    /*
     * Lo que decide si vale la pena seguir es SI LA PÁGINA SE MOVIÓ, no si el
     * agente se declaró exitoso.
     *
     * Pasó exactamente esto: el agente clickeó "Solicitar", LinkedIn redirigió a
     * `monks.com/careers/…`, y su paso SIGUIENTE reventó con un TypeError —el
     * inventario corrió mientras el documento nuevo todavía no tenía `body`—. Con
     * eso `achieveGoal` devolvió `ok: false`, el bucle se rindió, y el resultado
     * fue `blocked` sobre la URL de LinkedIn… con la página de Monks y su botón
     * "Apply Now" ya cargada en la ventana.
     *
     * La URL es un hecho; el `ok` del agente es una opinión sobre su último paso.
     * Cuando se contradicen, gana el hecho.
     */
    const after = deps.browser.currentUrl()
    const moved = after !== before

    steps.push({
      index: i,
      url: currentUrl,
      filled: 0,
      skipped: 0,
      unresolved: [],
      screenshot: null,
      action: moved ? `agente: ${result.detail} → ${after}` : `agente: ${result.detail}`
    })
    deps.onStep?.(steps[steps.length - 1])

    if (moved && !result.ok) {
      deps.onProgress?.('el agente falló su último paso pero la página cambió — sigo desde acá')
    }

    return result.ok || moved
  }

  try {
    await deps.browser.open(url)
  } catch (error: unknown) {
    return finish('failed', error instanceof Error ? error.message : String(error))
  }

  /*
   * El agente MIRA la página antes de que el bucle determinista toque nada.
   *
   * Estaba al revés —lo determinista primero y el agente como último recurso— y la
   * corrida contra una vacante de LinkedIn mostró por qué eso no puede funcionar:
   * la página tiene UN `<select>` (el idioma, en el pie) y un botón que dice
   * "Siguiente" (la flecha de un carrusel). Con eso, el bucle se creía en un
   * formulario, gastaba una llamada al modelo para "responder" el selector de
   * idioma, y le apretaba la flecha del carrusel. El agente nunca opinó, porque
   * solo se lo llamaba cuando el camino barato no encontraba NADA que apretar.
   *
   * Es la misma conclusión que `.claude/docs/connections.md` ya había sacado para
   * los servicios: para NAVEGAR una pantalla ajena el agente va primero. Lo
   * determinista es bueno llenando un formulario que ya tenemos delante, y malo
   * decidiendo si lo tenemos delante.
   *
   * Si ya estamos en el formulario, `achieveGoal` mira, contesta `done` y no toca
   * nada: cuesta una llamada y evita todo lo de arriba.
   */
  await reachFormWithAgent(0, url)

  let previous = ''

  for (let i = 0; i < MAX_STEPS; i++) {
    deps.onProgress?.(`paso ${i + 1}: mirando la página`)

    let form: FormModel
    try {
      form = await deps.browser.readForm()
    } catch (error: unknown) {
      return finish('failed', `no se pudo leer el formulario: ${String(error)}`)
    }

    // Lo que vio, antes de decidir. Va acá y no después del `pickButton` para
    // que quede registrado incluso cuando el bucle corta por no haber campos.
    deps.onLook?.(form)

    const current = signature(form)
    const stalled = current === previous
    previous = current

    /*
     * Sin campos: o todavía no llegamos al formulario, o ya terminamos.
     *
     * Acá había una rama que buscaba un botón clasificado `apply` y lo apretaba.
     * Se fue con la regex `OPEN` y con el `ButtonKind` del mismo nombre: abrir la
     * postulación se decidía leyendo el texto del botón, y eso se rompía con cada
     * sitio, cada idioma y cada rediseño. Ahora lo resuelve el agente, más abajo,
     * mirando la pantalla. Es una rama MENOS y un paradigma menos.
     */
    if (form.fields.length === 0) {
      /*
       * Sin campos y sin haber llenado NADA no es "listo": es que nunca
       * llegamos al formulario.
       *
       * Decía `filled` —"campos llenados"— apenas hubiera un paso previo,
       * aunque ese paso fuera solo abrir un botón. Con las vacantes externas
       * pasaba siempre: click en "Apply", LinkedIn abría el ATS en otra
       * pestaña, esta ventana se quedaba en la página vieja sin campos, y el
       * bucle informaba éxito. El usuario recibía "están todos los formularios
       * llenos" con cero postulaciones hechas.
       */
      const filledSomething = steps.some((s) => s.filled > 0)
      if (filledSomething) return finish('filled', 'no quedan campos por llenar')

      // Ni campos que leer ni un botón que el texto delate: es exactamente el
      // caso para el que sirve mirar la pantalla en vez de adivinar strings.
      if (await reachFormWithAgent(i, form.url)) continue

      return finish(
        'blocked',
        steps.length === 0
          ? 'no encontré formulario ni botón de postulación en esa página'
          : `llegué hasta ${form.url} y ahí no hay formulario. ` +
            'Si la postulación es externa, puede haberse abierto fuera de esta ventana.'
      )
    }

    // Lo más caro del bucle: una llamada al modelo por los campos que la regla
    // no supo contestar. Sin este aviso son minutos de pantalla quieta.
    deps.onProgress?.(`respondiendo ${form.fields.length} campos`)

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

    deps.onProgress?.(`llenando ${plan.answers.length} campos`)
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
      /*
       * Sin botón Y sin haber llenado NADA no es "lleno": es que no llegamos al
       * formulario.
       *
       * Es el mismo agujero que ya está tapado unas líneas arriba para el caso
       * sin campos, en la otra salida. Acá seguía abierto, y se disparaba con la
       * vacante externa de LinkedIn: la página tiene UN campo —el selector de
       * idioma del pie— así que el bucle no entraba por la rama de "cero campos",
       * llenaba cero, no encontraba botón de avance, y devolvía `filled`.
       *
       * Y `filled` no es cosmético: deja la ventana abierta esperando un click
       * que no existe, le dice al usuario "frené antes de enviar" sobre un
       * formulario que nunca vio, y escribe la vacante en Notion como si hubiera
       * algo listo. Reportar éxito sin haber hecho nada es el modo de falla más
       * caro que hay, y este archivo ya lo dice en la otra salida.
       */
      const filledSomething = steps.some((s) => s.filled > 0)
      if (!filledSomething) {
        /*
         * Éste es EL caso de la vacante externa de LinkedIn.
         *
         * La página tiene un campo —el selector de idioma del pie— así que no
         * entramos por la rama de "cero campos" de arriba; y el control que abre
         * la postulación es un `<a>` cuyo texto ("Solicitar", "Apply", lo que
         * sea) no tiene por qué estar en ninguna lista nuestra. Antes de
         * declararse bloqueado, el agente mira la pantalla.
         */
        if (await reachFormWithAgent(i, form.url)) continue

        // La URL de AHORA, no la de antes del turno del agente: ver más abajo.
        return finish(
          'blocked',
          `llegué a ${deps.browser.currentUrl()} y no encontré con qué avanzar: ` +
            `${form.buttons.length} botones y ninguno es de postulación`
        )
      }
      return finish('filled', 'campos llenados; no encontré el botón para avanzar')
    }

    if (!canClick(kind, deps.mode)) {
      return finish('filled', explainBlock(kind, deps.mode))
    }

    /*
     * No se avanza un formulario que no se llenó. Es lógica, no una heurística.
     *
     * Si en todos los pasos se llenaron CERO campos, este botón no puede ser el
     * paso siguiente de un formulario: no hay nada que hacer avanzar. En la vacante
     * de LinkedIn era la flecha "Siguiente" de un carrusel, y apretarla terminó en
     * `failed — clickear: no existe el botón` porque el DOM se rehízo debajo.
     *
     * A diferencia de mirar el texto del botón, esto no se rompe con el idioma ni
     * con el rediseño del sitio: la pregunta no es cómo se llama el control, es si
     * hay algo que avanzar.
     */
    const filledAnything = steps.some((s) => s.filled > 0)
    if (!filledAnything) {
      // Un turno más para el agente: puede ser que el formulario esté detrás de un
      // paso que la lectura del DOM no ve.
      if (await reachFormWithAgent(i, form.url)) continue

      /*
       * La URL se pregunta AHORA, no se usa la de `form`.
       *
       * `form.url` es de antes del turno del agente, y el agente navega: el
       * mensaje decía "llegué a linkedin.com/jobs/view/… y no encontré con qué
       * avanzar" con la página de Monks abierta en la ventana. Un error que nombra
       * la página equivocada manda a diagnosticar el lugar equivocado.
       */
      return finish(
        'blocked',
        `en ${deps.browser.currentUrl()} no llené ningún campo, así que no aprieto ` +
          `"${button.label}": no parece un formulario de postulación`
      )
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
