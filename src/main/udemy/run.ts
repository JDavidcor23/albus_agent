import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserPort } from '../core/jobs/ports'
import { toLectures, pendingLectures, sectionSlug, type Lecture } from '../core/udemy/curriculum'
import { parseCue, toMarkdown, type Cue } from '../core/udemy/transcript'
import { findShots } from '../core/udemy/deictic'
import { isSlideChange, sampleTimes } from '../core/udemy/frames'
import { shouldCapture } from '../core/udemy/items'
import { CourseMetaSchema } from '../core/udemy/library'
import { readCourseMeta, shotsDir, storedLectures, writeCourseMeta, writeLecture } from './store'
import {
  COURSE_TITLE,
  HIDE_OVERLAYS,
  READ_CURRICULUM,
  READ_TRANSCRIPT,
  VIDEO_DURATION,
  seekDoneScript,
  seekToScript
} from './page-scripts'

/**
 * De un curso de Udemy a una carpeta de transcripts y capturas.
 *
 * ## El orden, y por qué cada paso está donde está
 *
 * 1. Leer el índice — qué lecciones hay y cuáles tienen el tilde de vista.
 * 2. Restar lo ya bajado. **Reanudar es el caso normal**, no el de borde: son
 *    cincuenta lecciones y la corrida se va a cortar.
 * 3. Por cada una: abrir, leer el transcript, guardarlo.
 * 4. Recién ahí decidir las capturas, sobre el texto que ya está en disco.
 *
 * El paso 4 va último a propósito. Capturar mientras se lee obligaría a
 * adivinar qué momento vale antes de tener la clase entera; con el transcript
 * completo, `deictic.ts` compara todos los momentos y elige los tres mejores.
 *
 * ## Una lección que falla NO corta la corrida
 *
 * Es la regla más importante del archivo. Si la lección 23 tiene el panel
 * cerrado o Udemy mete un captcha, las otras 27 tienen que bajar igual. Un
 * pipeline que se cae entero por una fila es un pipeline que en cincuenta
 * lecciones nunca termina.
 */

export type UdemyStage = 'curso' | 'indice' | 'leccion' | 'transcript' | 'captura' | 'listo'

export interface UdemyStepEvent {
  stage: UdemyStage
  label: string
  done: number
  total: number
}

export interface UdemyRunSummary {
  courseSlug: string
  courseTitle: string
  /** Lecciones bajadas en ESTA corrida. */
  lectures: number
  shots: number
  /** Lo que no se pudo, con el porqué. Nunca se esconde. */
  failed: { lecture: string; why: string }[]
}

export interface UdemyRunOptions {
  browser: BrowserPort
  /** La URL del curso o de cualquiera de sus lecciones. */
  courseUrl: string
  /** Tope de lecciones por corrida. 0 = todas las pendientes. */
  limit?: number
  /**
   * Cada cuántos segundos se MUESTREA el video. No es cada cuánto se captura:
   * se guarda solo cuando la imagen cambió.
   *
   * Bajarlo no multiplica las capturas —siguen siendo una por slide— pero sí
   * el tiempo de barrido. Cinco segundos agarra cualquier slide que dure más
   * que eso, y las de este curso duran entre treinta y sesenta.
   */
  everySeconds?: number
  /**
   * Qué secciones bajar. Vacío = todas las pendientes.
   *
   * Es el pedido real —"bajame la sección 3"—, y sin esto un `limit` sobre un
   * curso con seis secciones vistas baja las primeras N del curso entero, que
   * no son las que se pidieron. El que las pidió se entera cuando vuelve.
   */
  sections?: number[]
  onStep?: (step: UdemyStepEvent) => void
}

const SETTLE_MS = 1200
const DEFAULT_EVERY_SECONDS = 5

/**
 * Techo para que la página del curso APAREZCA, que no es lo mismo que cargue.
 *
 * Udemy está detrás de Cloudflare, y Cloudflare contesta la primera visita con
 * su "Just a moment..." mientras decide. Eso son dos navegaciones dentro de la
 * misma URL y varios segundos en los que el documento no es el curso: es un
 * interstitial con dos links. Esperar 1200 ms fijos y leer era leer ESO.
 *
 * Por eso el techo es alto y la espera es por CONDICIÓN. El caso normal no
 * paga los 90 s: en cuanto el índice contesta, sigue.
 */
const CURRICULUM_TIMEOUT_MS = 90_000
const CURRICULUM_POLL_MS = 1000

/**
 * Techo aparte para cuando el que no suelta es Cloudflare.
 *
 * Se midió: con el muro puesto, 90 s no alcanzan y 900 tampoco — no se
 * resuelve solo. Lo que SÍ pasa el challenge es una persona: el login a mano
 * lo atravesó sin una línea de código. La ventana de la corrida ya es visible
 * por otro motivo (el video tiene que renderizar para capturarlo), así que
 * está justo ahí para que alguien haga el click.
 *
 * Por eso no hay trucos de huella acá. Fabricarle interacción al widget sería
 * un bypass: frágil, y una carrera que se pierde en el próximo deploy de ellos.
 * Esto es un click de persona, UNA vez, y después `cf_clearance` queda en la
 * partición y las corridas siguientes entran solas.
 *
 * Diez minutos porque el que corre esto se fue a hacer otra cosa: el costo de
 * esperar de más es una ventana abierta, y el de esperar de menos es tirar la
 * corrida entera a la basura por llegar treinta segundos tarde.
 */
const CHALLENGE_TIMEOUT_MS = 10 * 60_000

interface Curriculum {
  ok: boolean
  rows: { text: string; completed: boolean }[]
  debug?: string[]
}

/** El título con el que Cloudflare sirve su muro, en vez de la página. */
const isChallenge = (title: string): boolean =>
  /just a moment|verifying you are human|attention required|checking your browser/i.test(title)

const pageTitle = async (browser: BrowserPort): Promise<string> =>
  parseResult<{ ok: boolean; title: string }>(
    await browser.runScript(COURSE_TITLE),
    'título del curso'
  ).title

/**
 * Lee el índice reintentando hasta que la página sea la página.
 *
 * Distingue los dos motivos por los que puede no estar, porque mandan a
 * lugares opuestos: si es Cloudflare, no hay nada que arreglar en el código y
 * tocar selectores es perder la tarde; si la página cargó y el índice igual no
 * aparece, ahí sí el DOM cambió.
 */
async function readCurriculumWhenReady(
  browser: BrowserPort,
  step: (stage: UdemyStage, label: string) => void
): Promise<Curriculum> {
  // El techo se decide recién cuando se sabe QUIÉN no contesta: una página de
  // Udemy sin índice se rinde en 90 s, pero un muro de Cloudflare espera a que
  // una persona lo pase. Arranca en el corto y se estira si aparece el muro.
  let deadline = Date.now() + CURRICULUM_TIMEOUT_MS
  let announced = false

  for (;;) {
    const curriculum = parseResult<Curriculum>(await browser.runScript(READ_CURRICULUM), 'índice')
    if (curriculum.ok) {
      if (announced) step('indice', 'verificación pasada, sigo solo')
      return curriculum
    }

    const title = await pageTitle(browser)

    if (isChallenge(title) && !announced) {
      announced = true
      deadline = Date.now() + CHALLENGE_TIMEOUT_MS

      const minutes = Math.round(CHALLENGE_TIMEOUT_MS / 60_000)
      step('indice', 'Cloudflare pide verificar el navegador')
      console.log(
        `\n  ⚠ Cloudflare puso su "Just a moment..." delante del curso.\n` +
          `    Pasá la verificación EN LA VENTANA que está abierta — es un click.\n` +
          `    No hace falta nada más: en cuanto suelte, la corrida sigue sola y\n` +
          `    la cookie queda guardada, así que las próximas entran derecho.\n` +
          `    Espero hasta ${minutes} minutos.\n`
      )
    }

    if (Date.now() >= deadline) {
      throw new Error(
        isChallenge(title)
          ? `Cloudflare no soltó la página y nadie pasó la verificación (sigue en ` +
            `"${title}"). No es el índice ni los selectores: la página que cargó no es ` +
            `el curso. Corré el comando de nuevo con la ventana a la vista y hacé el ` +
            `click; con eso alcanza para todas las corridas que siguen.`
          : `no pude leer el índice en ${Math.round(CURRICULUM_TIMEOUT_MS / 1000)}s. ` +
            `Abrí el panel "Contenido del curso". data-purpose que sí encontré: ` +
            `${(curriculum.debug ?? []).join(', ') || 'ninguno'}`
      )
    }

    await wait(CURRICULUM_POLL_MS)
  }
}

/** El seek no es instantáneo: se pregunta hasta que haya frame, con techo. */
const SEEK_POLL_MS = 120
const SEEK_POLLS = 12

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Los scripts devuelven JSON siempre. Un parseo roto es un DOM que cambió. */
function parseResult<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`${what}: la página no devolvió JSON (¿cambió el DOM?)`)
  }
}

function courseSlugFrom(title: string): string {
  const clean = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return clean === '' ? 'curso' : clean.slice(0, 80)
}

/**
 * Abre el panel de transcripción si está cerrado.
 *
 * No falla si no encuentra el botón: entre lecciones el panel queda abierto, y
 * ahí buscar el botón devuelve nada porque ya está en el estado que queríamos.
 * Quien decide si hay transcript es `READ_TRANSCRIPT`, que es el que mira lo
 * que hay en vez de lo que se esperaba.
 */
async function ensureTranscriptPanel(browser: BrowserPort): Promise<void> {
  try {
    await browser.clickText(['Transcript', 'Transcripción', 'Transcripcion'], false, 2500)
    await wait(SETTLE_MS)
  } catch {
    // Ya estaba abierto, o el botón se llama de otra forma. `READ_TRANSCRIPT` decide.
  }
}

async function readCues(browser: BrowserPort): Promise<Cue[]> {
  const raw = await browser.runScript(READ_TRANSCRIPT)
  const r = parseResult<{ ok: boolean; cues: string[]; debug?: string[] }>(raw, 'transcript')

  if (!r.ok) {
    throw new Error(
      `no pude leer el transcript. Lo que hay en la página: ${(r.debug ?? []).join(' / ') || 'nada'}`
    )
  }

  return r.cues.map(parseCue)
}

/** `0m15s`, para que el nombre del archivo diga de qué momento salió. */
function stamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}m${String(s).padStart(2, '0')}s`
}

/** Salta a un momento y espera a que HAYA imagen ahí. `false` si no llegó. */
async function seekTo(browser: BrowserPort, seconds: number): Promise<boolean> {
  await browser.runScript(seekToScript(seconds))

  for (let i = 0; i < SEEK_POLLS; i++) {
    await wait(SEEK_POLL_MS)
    const r = parseResult<{ ok: boolean }>(
      await browser.runScript(seekDoneScript(seconds)),
      'seek'
    )
    if (r.ok) return true
  }
  return false
}

/**
 * Barre el video y captura UNA vez por slide.
 *
 * ## Por qué no es "cada N segundos"
 *
 * El pedido fue capturar cada cinco. Una clase de 6:29 da 78 muestras, y como
 * las slides duran entre treinta y sesenta segundos, unas setenta son
 * duplicados exactos. Así que se muestrea igual de seguido —la señal hay que
 * buscarla— pero **solo se guarda cuando la imagen cambió**. Ocho capturas en
 * vez de setenta y ocho, y ninguna slide perdida.
 *
 * ## Y por qué no hay que mirar la clase
 *
 * Cada muestra es un `video.currentTime = t`, no reproducción. Los 78 saltos
 * son unos veinte segundos de reloj contra seis minutos de ver el video. Es la
 * diferencia entre bajar cincuenta clases en una tarde o en una semana.
 *
 * Los overlays se tapan UNA vez, antes de empezar: la regla de CSS vive hasta
 * que la página navegue, y volver a inyectarla en cada captura sería pagar
 * setenta y ocho veces por algo que ya está hecho.
 */
async function sweepSlides(
  browser: BrowserPort,
  courseSlug: string,
  lecture: Lecture,
  everySeconds: number,
  onStep: (step: UdemyStepEvent) => void
): Promise<number> {
  const dur = parseResult<{ ok: boolean; duration: number }>(
    await browser.runScript(VIDEO_DURATION),
    'duración del video'
  )
  if (!dur.ok) return 0

  const times = sampleTimes(dur.duration, everySeconds)
  if (times.length === 0) return 0

  await browser.runScript(HIDE_OVERLAYS)

  const dir = shotsDir(courseSlug, lecture.slug)
  mkdirSync(dir, { recursive: true })

  let last: number[] | null = null
  let taken = 0

  for (const [i, t] of times.entries()) {
    onStep({
      stage: 'captura',
      label: `${lecture.title} — barriendo ${stamp(t)} (${taken} slides)`,
      done: i,
      total: times.length
    })

    try {
      if (!(await seekTo(browser, t))) continue

      const signature = await browser.frameSignature()
      // La primera entra siempre: no hay con qué compararla, y descartarla
      // perdería la slide de apertura — la que da el título de la sección.
      if (last !== null && !isSlideChange(last, signature)) continue

      last = signature
      await browser.screenshot(join(dir, `${String(taken + 1).padStart(2, '0')}-${stamp(t)}.jpg`))
      taken++
    } catch (error: unknown) {
      console.warn(`[udemy] muestra ${stamp(t)} de ${lecture.slug}: ${String(error)}`)
    }
  }

  return taken
}

/**
 * La pantalla de un quiz o de una nota: una sola captura, sin barrer.
 *
 * No hay video que recorrer — lo que importa es el texto que está a la vista.
 * Un quiz es lo más parecido al examen que hay en el curso.
 */
async function captureStill(
  browser: BrowserPort,
  courseSlug: string,
  lecture: Lecture
): Promise<number> {
  const dir = shotsDir(courseSlug, lecture.slug)
  mkdirSync(dir, { recursive: true })
  await browser.runScript(HIDE_OVERLAYS)
  await wait(SETTLE_MS)
  await browser.screenshot(join(dir, `01-${lecture.kind}.jpg`))
  return 1
}

export async function runUdemy(options: UdemyRunOptions): Promise<UdemyRunSummary> {
  const {
    browser,
    courseUrl,
    limit = 0,
    everySeconds = DEFAULT_EVERY_SECONDS,
    sections = [],
    onStep
  } = options
  const step = (stage: UdemyStage, label: string, done = 0, total = 0): void =>
    onStep?.({ stage, label, done, total })

  step('curso', 'abriendo el curso')
  await browser.open(courseUrl)
  await wait(SETTLE_MS)

  /*
   * El índice va PRIMERO, y el título después. Es al revés que antes y no es
   * cosmético: mientras Cloudflare muestra su muro, `COURSE_TITLE` devuelve
   * "Just a moment..." — y de ahí salía el slug con el que se nombra la
   * CARPETA del curso. El índice es lo único que prueba que la página cargada
   * sea la de Udemy, así que hasta que conteste no hay título que valga.
   */
  step('indice', 'leyendo el índice del curso')
  const curriculum = await readCurriculumWhenReady(browser, step)

  const courseTitle = await pageTitle(browser)
  const courseSlug = courseSlugFrom(courseTitle)

  const lectures = toLectures(curriculum.rows)
  const already = storedLectures(courseSlug)
  const pending = pendingLectures(lectures, already, sections)
  const todo = limit > 0 ? pending.slice(0, limit) : pending

  /*
   * Pedir una sección que no existe —o que el script no pudo asociar— devuelve
   * cero y se ve igual que "ya estaba todo bajado". Son cosas muy distintas y
   * confundirlas hace perder una tarde, así que se dicen distinto.
   */
  if (sections.length > 0 && pending.length === 0) {
    const vistas = [...new Set(lectures.map((l) => l.section))].sort((a, b) => a - b)
    console.warn(
      `[udemy] la sección ${sections.join(', ')} no dejó nada pendiente. ` +
        `Secciones que sí leí del índice: ${vistas.join(', ') || 'ninguna'}. ` +
        `Si acá sale 0, el script no pudo asociar las cabeceras.`
    )
  }

  const failed: UdemyRunSummary['failed'] = []
  let lecturesDone = 0
  let shotsDone = 0

  for (const [i, lecture] of todo.entries()) {
    step('leccion', `${lecture.index}. ${lecture.title}`, i, todo.length)

    try {
      // Por el texto y no por un selector: el número hace único al título, y
      // "51. EBS Overview" sobrevive a un rediseño que renombre las clases.
      await browser.clickText([`${lecture.index}. ${lecture.title}`, lecture.title], false, 8000)
      await wait(SETTLE_MS)

      const plan = shouldCapture(lecture.kind)

      if (plan.transcript) {
        await ensureTranscriptPanel(browser)
        step('transcript', lecture.title, i, todo.length)
        const cues = await readCues(browser)

        /*
         * Los deícticos ya no deciden QUÉ capturar —de eso se encarga el
         * cambio de slide— sino qué mirar primero. Van al principio del
         * archivo, que es donde se leen antes de meterse en cuatrocientas
         * líneas de transcript.
         */
        const marks = findShots(cues).map(
          (s) => `**${s.razones.join(' · ')}** — "${s.cue.text.slice(0, 110)}"`
        )

        writeLecture(
          courseSlug,
          lecture.slug,
          toMarkdown(
            {
              title: `${lecture.index}. ${lecture.title}`,
              url: browser.currentUrl(),
              capturedAt: new Date().toISOString().slice(0, 10)
            },
            cues,
            marks
          )
        )
        lecturesDone++
      }

      if (plan.screens) {
        shotsDone +=
          lecture.kind === 'quiz'
            ? await captureStill(browser, courseSlug, lecture)
            : await sweepSlides(browser, courseSlug, lecture, everySeconds, (s) => onStep?.(s))
      }
    } catch (error: unknown) {
      // Una lección caída cuesta una lección. Nunca la corrida.
      failed.push({ lecture: `${lecture.index}. ${lecture.title}`, why: String(error) })
      console.warn(`[udemy] ${lecture.slug} falló: ${String(error)}`)
    }
  }

  const prev = readCourseMeta(courseSlug)
  writeCourseMeta(
    courseSlug,
    CourseMetaSchema.parse({
      courseTitle,
      courseUrl,
      createdAt: prev.createdAt === '' ? new Date().toISOString() : prev.createdAt,
      updatedAt: new Date().toISOString(),
      lectures: storedLectures(courseSlug).length,
      shots: prev.shots + shotsDone,
      stored: storedLectures(courseSlug)
    })
  )

  step('listo', `${lecturesDone} lecciones · ${shotsDone} capturas`, todo.length, todo.length)

  return { courseSlug, courseTitle, lectures: lecturesDone, shots: shotsDone, failed }
}

/** Para el check: el slug de sección, que la UI usa para agrupar. */
export { sectionSlug }
