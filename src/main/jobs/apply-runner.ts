import { app } from 'electron'
import { join } from 'node:path'
import { runApply, type ApplyDeps, type StagedKit } from '../core/jobs/apply'
import type { LlmTier } from '../core/jobs/answers-llm'
import type { ApplyMode, ApplyOutcome, ApplyStep, JobPosting } from '../core/jobs/types'
import type { TrackerRow } from '../core/jobs/ports'
import { createBrowserPage } from '../browser/page'
import { hasLinkedInSession } from '../browser/session'
import { achieveGoal, type RunModel } from '../connections/navigate-llm'
import { rememberOpenApplication } from './open-application'
import { dedupeKey } from './search'
import { notionStatus, scrubPii, type NotionRow } from '../core/jobs/notion-map'
import { isNotionConfigured } from '../notion/client'
import { upsertApplication } from '../notion/applications'
import { createCsvTracker } from './tracker'
import { createWorkspaceKitSource, loadProfile, slugify } from './workspace'

/**
 * Junta las piezas: perfil, kit compilado, navegador y el bucle del dominio.
 * Es el equivalente de `extraction.ipc` para postulaciones — el lugar donde
 * los adaptadores se enchufan y el dominio sigue sin conocer a ninguno.
 */

export interface ApplyRequest {
  url: string
  company: string
  role: string
  /** Vacío = se deriva de la empresa. */
  slug: string
  mode: ApplyMode
  llm: LlmTier | null
  sector: string
  fitRating: string
  /** Texto de la vacante, para el espejo en Notion. Vacío si no se tiene. */
  jobDescription: string
  onStep?: (step: ApplyStep) => void
  /** Qué está pasando ahora mismo, para que la UI no parezca colgada. */
  onProgress?: (detail: string) => void
}

export interface NotionMirror {
  /** `null` = no se intentó (Notion apagado). */
  pageId: string | null
  created: boolean
  error: string | null
}

export interface ApplyReport {
  outcome: ApplyOutcome
  /** Kit encontrado en el workspace. `null` en cada campo = no había PDF. */
  kit: { cv: string | null; cover: string | null }
  /** Cómo se llamaron los archivos al subirlos. Lo que ve el reclutador. */
  uploadedAs: string[]
  /** La fila que corresponde al tracker. Escrita solo si ya se envió. */
  trackerRow: TrackerRow
  trackerWritten: boolean
  notion: NotionMirror
  /** En modo review la ventana queda abierta esperando el click del usuario. */
  windowLeftOpen: boolean
}

const NO_NOTION: NotionMirror = { pageId: null, created: false, error: null }

/**
 * El espejo en Notion. Nunca tira: la postulación ya pasó, y perder el
 * registro es feo pero perder el resultado por no poder registrarlo es peor.
 */
async function mirrorInNotion(
  req: ApplyRequest,
  outcome: ApplyOutcome,
  fitScore: number | null,
  description: string
): Promise<NotionMirror> {
  if (!isNotionConfigured()) {
    return { pageId: null, created: false, error: 'falta NOTION_TOKEN en .env' }
  }

  const status = notionStatus(outcome.status)
  if (status === null) {
    // Antes que inventar una opción en el select del usuario, no escribimos.
    return { pageId: null, created: false, error: `estado "${outcome.status}" sin mapear` }
  }

  try {
    const profile = await loadProfile()
    const pending =
      outcome.unresolved.length > 0
        ? `Completar a mano: ${outcome.unresolved.slice(0, 6).join('; ')}`
        : outcome.status === 'filled'
          ? 'Formulario lleno esperando tu click de enviar'
          : ''

    const row: NotionRow = {
      company: req.company,
      role: req.role,
      status,
      date: new Date().toISOString().slice(0, 10),
      fitScore,
      postLink: req.url,
      contactUrl: req.url,
      jobDescription: scrubPii(description, profile),
      coverLetter: '',
      nextAction: scrubPii(pending, profile)
    }

    const r = await upsertApplication(row)
    return { pageId: r.pageId, created: r.created, error: null }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[jobs] no se pudo espejar en Notion: ${message}`)
    return { pageId: null, created: false, error: message }
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Un label de formulario puede traer un párrafo. En una consola eso es ruido. */
function short(text: string, max = 56): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean === '') return '(sin texto)'
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

/** Más de esto en una consola no se lee; el total se imprime igual. */
const MAX_LISTED = 25

/**
 * La traza de la postulación en la consola del proceso main.
 *
 * Existe por un reclamo concreto: *"le doy clic en postular y ahí se queda"*.
 * Desde afuera hay por lo menos cuatro causas que se ven IDÉNTICAS —la ventana
 * quieta y un `blocked` al final— y que se arreglan distinto:
 *
 *   1. el ATS quiso abrirse en otra pestaña y su host no está en la allowlist
 *   2. el botón existe pero su texto no cae en ningún `ButtonKind`
 *   3. el formulario está en un iframe que no nos deja ejecutar nada
 *   4. la página pide login antes de mostrar el formulario
 *
 * Esto no elige entre las cuatro: imprime lo que hay para que se vea cuál es.
 * Es la instrumentación de la que habla `.claude/docs/gotchas.md` — primero
 * medir, después tocar.
 *
 * Va a la consola y NO a la UI a propósito: el chat es del usuario, y treinta
 * campos con su `kind` y su selector lo volverían inservible. Y no reemplaza
 * los callbacks del pedido — los envuelve.
 */
function traceHooks(req: ApplyRequest): Pick<ApplyDeps, 'onLook' | 'onStep' | 'onProgress'> {
  return {
    onProgress: (detail: string): void => {
      console.log(`[apply] ${detail}`)
      req.onProgress?.(detail)
    },

    onLook: (form): void => {
      console.log(`[apply] ─── lo que ve en "${short(form.title, 64)}"`)
      console.log(`[apply]     url: ${form.url}`)
      /*
       * DÓNDE miró, no solo qué encontró.
       *
       * "cero campos y cero botones" es incontestable sin este dato: puede ser una
       * página vacía o una raíz mal elegida. Ya fue lo segundo — un diálogo vacío
       * que quedó en el DOM de Monks se eligió como raíz y el lector reportó una
       * página vacía que tenía el formulario de Greenhouse completo.
       */
      console.log(`[apply]     leyó: ${form.inModal ? 'un MODAL abierto' : 'el documento entero'}`)

      if (form.fields.length === 0) {
        console.log('[apply]     campos: NINGUNO')
      } else {
        console.log(`[apply]     campos (${form.fields.length}):  * = obligatorio`)
        for (const f of form.fields.slice(0, MAX_LISTED)) {
          const name = short(f.label !== '' ? f.label : f.name !== '' ? f.name : f.placeholder)
          console.log(`[apply]       · ${f.kind.padEnd(9)} ${f.required ? '*' : ' '} ${name}`)
        }
        if (form.fields.length > MAX_LISTED) {
          console.log(`[apply]       … y ${form.fields.length - MAX_LISTED} más`)
        }
      }

      /*
       * Los botones con su `kind` YA clasificado.
       *
       * Es la línea más importante de toda la traza: el bucle solo aprieta
       * `next`, `submit` o `apply` (ver `pickButton`), así que un botón que
       * dice "Solicitar" y sale como `other` explica el cuelgue por completo —
       * y es invisible en cualquier otro lado.
       */
      if (form.buttons.length === 0) {
        console.log('[apply]     botones: NINGUNO')
      } else {
        /*
         * Los accionables PRIMERO, y no por prolijidad.
         *
         * Desde que `READ_FORM` incluye los `<a>`, una página de LinkedIn trae
         * cientos de botones y el corte de la lista escondería justo el único
         * que decide algo. `pickButton` solo elige next/submit/apply: si en esta
         * lista no hay ninguno de esos tres, el cuelgue ya está explicado.
         */
        const actionable = form.buttons.filter((b) => b.kind !== 'other')
        const rest = form.buttons.filter((b) => b.kind === 'other')

        console.log(
          `[apply]     botones (${form.buttons.length}, accionables ${actionable.length}):`
        )
        if (actionable.length === 0) {
          console.log('[apply]       (NINGUNO de postulación — el bucle no tiene qué apretar)')
        }
        for (const b of [...actionable, ...rest].slice(0, MAX_LISTED)) {
          console.log(`[apply]       · [${b.kind.padEnd(6)}] ${short(b.label)}`)
        }
        if (form.buttons.length > MAX_LISTED) {
          console.log(`[apply]       … y ${form.buttons.length - MAX_LISTED} más (todos "other")`)
        }
      }
    },

    onStep: (step): void => {
      const sinResponder =
        step.unresolved.length > 0 ? ` · sin responder: ${step.unresolved.join('; ')}` : ''
      console.log(
        `[apply] paso ${step.index + 1}: ${step.action} ` +
          `(llenó ${step.filled}, salteó ${step.skipped})${sinResponder}`
      )
      req.onStep?.(step)
    }
  }
}

function screenshotDir(slug: string): string {
  return join(app.getPath('userData'), 'job-screenshots', `${today()}_${slug}`)
}

/** Los temporales van al userData de la app, no al workspace del usuario. */
export function uploadStagingDir(): string {
  return join(app.getPath('userData'), 'job-uploads')
}

export async function runApplication(req: ApplyRequest): Promise<ApplyReport> {
  const profile = await loadProfile()
  const slug = req.slug !== '' ? req.slug : slugify(req.company)

  const posting: JobPosting = {
    url: req.url,
    company: req.company,
    role: req.role,
    slug
  }

  // LinkedIn sin sesión devuelve un muro de login y el bucle leería ESE
  // formulario. Cortamos antes, con un mensaje que dice qué hacer.
  if (/linkedin\.com/i.test(req.url) && !(await hasLinkedInSession())) {
    const empty: ApplyOutcome = {
      status: 'needs-login',
      url: req.url,
      mode: req.mode,
      steps: [],
      unresolved: [],
      uploadedAs: [],
      message: 'no hay sesión de LinkedIn en Albus — corré el login una vez desde jobs:login'
    }
    return {
      outcome: empty,
      kit: { cv: null, cover: null },
      uploadedAs: [],
      trackerRow: toTrackerRow(req, posting, null, null, empty),
      trackerWritten: false,
      notion: NO_NOTION,
      windowLeftOpen: false
    }
  }

  const kitSource = createWorkspaceKitSource(uploadStagingDir())
  const found = await kitSource.findKit(posting)

  const staged: StagedKit = {
    cvSource: found.cv,
    cvUpload:
      found.cv !== null ? await kitSource.stageForUpload(found.cv, profile.cvFileBaseName) : null,
    coverSource: found.cover,
    coverUpload:
      found.cover !== null
        ? await kitSource.stageForUpload(found.cover, profile.coverFileBaseName)
        : null
  }

  // En `review` la ventana tiene que quedar visible: el envío lo hace el
  // usuario. En `auto` también se muestra, porque una postulación enviándose
  // sola sin que se vea es exactamente lo que nadie quiere descubrir después.
  const browser = createBrowserPage({ visible: req.mode !== 'dry-run' })

  console.log(`\n[apply] ═══ ${req.company} — ${req.role}  (modo ${req.mode})`)
  console.log(`[apply] ${req.url}`)
  console.log(`[apply] kit: cv=${found.cv ?? 'NO HAY'} · carta=${found.cover ?? 'NO HAY'}`)

  /*
   * El mismo modelo que responde los campos es el que mira la pantalla.
   *
   * Se copia a un `const` local y no se usa `req.llm` adentro del closure porque
   * TypeScript no arrastra el estrechamiento de una propiedad hasta ahí — y una
   * aserción `!` sería una promesa que nadie verifica.
   */
  const tier = req.llm
  const runModel: RunModel | null =
    tier !== null ? (text: string): Promise<string> => tier.provider.run(text, tier.model) : null

  if (runModel === null) {
    console.log('[apply] sin CLI de IA: el agente no puede mirar la pantalla, solo lo determinista')
  }

  let agentShot = 0
  const captureForAgent = async (): Promise<string | null> => {
    try {
      return await browser.screenshot(join(screenshotDir(slug), `agente-${agentShot++}.png`))
    } catch {
      // La captura es un extra para el modelo: el inventario alcanza sin ella.
      return null
    }
  }

  let outcome: ApplyOutcome
  try {
    outcome = await runApply(
      {
        browser,
        profile,
        kit: staged,
        llm: req.llm,
        mode: req.mode,
        screenshotDir: screenshotDir(slug),
        ...traceHooks(req),

        /*
         * El agente de navegación, con el motor que ya existe.
         *
         * `achieveGoal` es el mismo que usa `connections/connection-agent.ts`
         * para entrar a Notion o a Supabase sin que nadie haya escrito los pasos
         * de Notion ni de Supabase. Acá hace el trabajo equivalente: llegar al
         * formulario de una vacante sin que nadie haya escrito el texto del botón
         * de LinkedIn.
         *
         * `undefined` sin CLI, no una función que falle: el dominio ya sabe
         * seguir sin este escalón.
         */
        navigate:
          runModel === null
            ? undefined
            : async (goal: string): Promise<{ ok: boolean; detail: string }> => {
                const r = await achieveGoal(browser, { goal }, runModel, {
                  maxSteps: 5,
                  capture: captureForAgent,
                  onAction: (detail, ok) => {
                    console.log(`[apply] agente${ok ? '' : ' FALLÓ'}: ${detail}`)
                    req.onProgress?.(`el agente ${detail}`)
                  }
                })
                return { ok: r.ok, detail: r.detail }
              }
      },
      posting,
      req.url
    )
  } catch (error: unknown) {
    // El bucle ya atrapa lo suyo; esto es el cinturón por si el adaptador
    // explota antes de entrar. Un fallo no puede dejar la ventana colgada.
    const message = error instanceof Error ? error.message : String(error)
    outcome = {
      status: 'failed',
      url: req.url,
      mode: req.mode,
      steps: [],
      unresolved: [],
      uploadedAs: [],
      message
    }
  }

  console.log(`[apply] ═══ resultado: ${outcome.status} — ${outcome.message}`)

  /*
   * Los popups denegados, ACÁ y no solo cuando pasan.
   *
   * Cuando la vacante es externa y el ATS no está en la allowlist, el bloqueo
   * ocurre minutos antes del veredicto: en la consola queda a treinta líneas de
   * distancia del `blocked`, y nadie relaciona las dos cosas. Repetirlo al lado
   * del resultado es lo que convierte dos hechos sueltos en una explicación.
   */
  const blocked = browser.blockedPopups()
  if (blocked.length > 0) {
    console.warn(`[apply] ATENCIÓN: se denegaron ${blocked.length} popup(s) durante esta corrida.`)
    for (const url of blocked) console.warn(`[apply]   · ${url}`)
    console.warn('[apply]   Si alguno es el ATS de la empresa, ESA es la causa del resultado:')
    console.warn('[apply]   su host tiene que estar en APPLICABLE_HOSTS (src/shared/ipc.ts).')
  }

  const leaveOpen = outcome.status === 'filled' && req.mode === 'review'
  if (leaveOpen) {
    browser.reveal()

    /*
     * Y se GUARDA el handle. Sin esto la ventana quedaba viva e inalcanzable.
     *
     * `browser` es una const local: al retornar, nadie se quedaba con ella. El
     * usuario pedía "sí manda, pero rellena estos datos" y no había a qué
     * pedírselo; y el agente preguntaba "¿cuál es el id de la vacante donde estás
     * rellenando el formulario?" porque su contexto no tenía forma de saber que
     * había una abierta. Ver `open-application.ts`.
     */
    rememberOpenApplication({
      job: { id: dedupeKey(req.url), company: req.company, role: req.role, url: req.url },
      page: browser,
      window: browser.window,
      unresolved: outcome.unresolved
    })
  } else {
    await browser.close()
  }

  const row = toTrackerRow(req, posting, staged.cvSource, staged.coverSource, outcome)

  let trackerWritten = false
  if (outcome.status === 'submitted') {
    try {
      await createCsvTracker().append(row)
      trackerWritten = true
    } catch (error: unknown) {
      // No perdemos la postulación por no poder escribir el CSV. Se reporta.
      console.warn(`[jobs] no se pudo escribir el tracker: ${String(error)}`)
    }
  }

  // Notion se espeja SIEMPRE que la corrida haya llegado a algo, no solo
  // cuando se envió: una vacante llena esperando tu click también es estado
  // que querés ver en el tablero.
  const notion =
    outcome.status === 'failed'
      ? NO_NOTION
      : await mirrorInNotion(req, outcome, numberOrNull(req.fitRating), req.jobDescription)

  return {
    outcome,
    kit: found,
    uploadedAs: outcome.uploadedAs,
    trackerRow: row,
    trackerWritten,
    notion,
    windowLeftOpen: leaveOpen
  }
}

function numberOrNull(value: string): number | null {
  const n = Number(value)
  return value.trim() !== '' && Number.isFinite(n) ? n : null
}

/** Se registra lo que pasó, no lo que uno querría que hubiera pasado. */
function toTrackerRow(
  req: ApplyRequest,
  posting: JobPosting,
  cv: string | null,
  cover: string | null,
  outcome: ApplyOutcome
): TrackerRow {
  const pending =
    outcome.unresolved.length > 0
      ? ` | sin responder: ${outcome.unresolved.slice(0, 6).join('; ')}`
      : ''

  const relative = (p: string | null): string =>
    p === null ? '' : p.replace(/\\/g, '/').split('/').slice(-2).join('/')

  return {
    date: today(),
    company: req.company,
    sector: req.sector,
    role: req.role,
    roleType: '',
    channel: /linkedin\.com/i.test(req.url) ? 'LinkedIn' : 'Portal',
    status: outcome.status === 'submitted' ? 'applied' : outcome.status,
    contactPerson: '',
    fitRating: req.fitRating,
    notes: `${today()}: Albus (${outcome.mode}) — ${outcome.message}${pending}`,
    cvFile: relative(cv),
    coverLetterFile: relative(cover),
    source: posting.url
  }
}

/** Para cerrar el círculo cuando el envío lo hizo el usuario en modo review. */
export async function confirmApplied(row: TrackerRow): Promise<void> {
  await createCsvTracker().append({ ...row, status: 'applied' })
}
