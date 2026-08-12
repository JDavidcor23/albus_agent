import type { AgentJobView, ToolResult, ToolSpec } from '../core/jobs/agent'
import type { LlmTier } from '../core/jobs/answers-llm'
import { applyFloor, type RankedJob } from '../core/jobs/rank'
import { hunt } from './hunt'
import { generateKit } from './kit'
import { runApplication, confirmApplied } from './apply-runner'
import { achieveGoal } from '../connections/navigate-llm'
import { openApplication } from './open-application'
import { slugify } from './workspace'
import { markDiscarded, markStatus, listApplications } from '../notion/applications'
import { isNotionConfigured } from '../notion/client'
import { NOTION_STATUSES, type NotionStatus } from '../core/jobs/notion-map'
import { uploadToFolder } from '../drive/upload'
import { readRules } from '../agents/rules'
import { createWorkspaceKitSource } from './workspace'
import { uploadStagingDir } from './apply-runner'

/** El agente dueño del `.md`. De ahí sale la carpeta de Drive del usuario. */
const JOB_SEARCH_ID = 'job-search'

/**
 * Las capacidades de Albus, descritas para que el modelo pueda elegirlas.
 *
 * ## Por qué esto es una lista de datos y no un `switch`
 *
 * Cada herramienta se describe en castellano, igual que se le explicaría a una
 * persona nueva. Eso es lo que el modelo lee para decidir. Sumar una capacidad
 * es agregar una entrada acá y su caso en `runTool` — no tocar el chat, ni
 * inventar frases que el usuario tenga que decir textualmente.
 *
 * ## El reparto
 *
 * `core/jobs/agent.ts` es puro y no sabe qué es Notion. Acá viven las funciones
 * de verdad: red, disco, navegador, CLI. Mismo corte que `navigate-llm.ts`
 * (decide) contra `connection-agent.ts` (ejecuta).
 */

export const JOB_TOOLS: ToolSpec[] = [
  {
    name: 'buscar',
    description:
      'Busca vacantes nuevas en LinkedIn, las puntúa contra el perfil y devuelve las que califican. ' +
      'Si no le pasás roles usa los del archivo de reglas del usuario. Tarda varios minutos.',
    args: {
      roles: 'lista de puestos a buscar, opcional. Vacío = los de las reglas',
      ubicacion: 'país o ciudad, opcional'
    }
  },
  {
    name: 'preparar_cv',
    description:
      'Arma el CV y la carta de presentación a medida para UNA vacante y los compila en PDF. ' +
      'Es lo más lento. No le escribe a nadie: solo genera archivos. ' +
      'Hace falta antes de postularse, y postularse ya lo hace solo si falta.',
    args: { id: 'el id de la vacante, de las que están en pantalla' }
  },
  {
    name: 'postular',
    description:
      'Se postula a UNA vacante: abre la página, llena el formulario y LO ENVÍA. ' +
      'NO arma el CV — si no está compilado, se postula sin adjuntarlo, que es peor que no postularse. ' +
      'Llamá preparar_cv antes si la vacante figura con el CV sin armar. ' +
      'Para postularse a varias, llamala una vez por cada una. ' +
      'Pasá modo="review" SOLO si el usuario pidió revisarla antes de mandar, o si sus reglas lo dicen: ' +
      'eso llena el formulario, NO lo envía y deja la ventana abierta. ' +
      'Ojo: con varias vacantes en "review" quedan varias ventanas abiertas al mismo tiempo.',
    args: {
      id: 'el id de la vacante, de las que están en pantalla',
      modo: '"auto" para enviar (por defecto) o "review" para dejarla lista sin enviar'
    }
  },
  {
    name: 'completar_formulario',
    description:
      'Trabaja sobre el formulario que quedó ABIERTO en la ventana (ver "POSTULACIÓN ABIERTA AHORA MISMO"). ' +
      'Usala cuando el usuario pida rellenar campos que faltaron, responder preguntas del formulario, ' +
      'o corregir algo de esa postulación. El modelo mira la pantalla y actúa: sirve para preguntas ' +
      'que están detrás de un acordeón o de un desplegable, que no se ven como campos hasta abrirlas. ' +
      'NO envía la postulación.',
    args: {
      que_hacer:
        'Qué hay que completar o corregir, en castellano y con el detalle que dio el usuario. ' +
        'Si él pegó las preguntas, pasalas tal cual.'
    }
  },
  {
    name: 'listar_postulaciones',
    description:
      'Trae TODAS las postulaciones anotadas en Notion, con su estado y hace cuántos días son. ' +
      'Usala para resumirle al usuario cómo va, o para encontrar las que quedaron sin respuesta. ' +
      'Los estados posibles son: Backlog, Applying, In process, First contact, Rejected, Descartada.',
    args: {}
  },
  {
    name: 'marcar_estado',
    description:
      'Cambia el estado de una postulación en Notion. Solo estos valores: ' +
      'Backlog, Applying, In process, First contact, Rejected, Descartada. ' +
      'La vacante puede estar en pantalla o no: alcanza con su url.',
    args: {
      url: 'la url de la vacante (la de "post link" en Notion)',
      estado: 'uno de los seis estados'
    }
  },
  {
    name: 'subir_a_drive',
    description:
      'Sube a Google Drive el CV o la carta de una vacante, a la carpeta que el usuario puso en ' +
      'sus reglas. El nombre lo elegís vos: mirá si las reglas dicen algo sobre cómo nombrarlos. ' +
      'Hace falta que el CV ya esté armado.',
    args: {
      id: 'el id de la vacante',
      archivo: '"cv" o "carta"',
      nombre: 'con qué nombre guardarlo (sin la extensión .pdf)'
    }
  },
  {
    name: 'confirmar_envio',
    description:
      'Registra que el usuario YA envió la postulación: la anota en el tracker CSV. ' +
      'Solo cuando él diga que la mandó. "postular" deja el formulario lleno sin enviar, ' +
      'así que el envío real lo hace él con el botón de la página.',
    args: { id: 'el id de la vacante' }
  },
  {
    name: 'descartar',
    description:
      'Descarta una vacante para siempre: la saca de la lista y la marca "Descartada" en Notion, ' +
      'así no vuelve a aparecer en los próximos barridos. Usala cuando el usuario diga que no le interesa.',
    args: { id: 'el id de la vacante' }
  }
]

export interface ToolDeps {
  llm: LlmTier
  /** Lo que el usuario ve ahora. El runner lo mantiene entre vueltas. */
  screen: RankedJob[]
  /** Qué vacantes ya tienen el kit compilado, por id. */
  kitReady: Set<string>
  onProgress?: (phase: string, detail: string) => void
  /**
   * Cuántas veces se intentó ya `completar_formulario` en ESTE pedido.
   *
   * Existe porque el agente no puede VERIFICAR si una respuesta se grabó: vuelve a
   * leer la pantalla, ve la pregunta ahí, y concluye que faltó. Con las preguntas de
   * opción múltiple de Monks eso lo llevó a reintentar **cinco veces** el mismo
   * trabajo — 33 minutos de reloj— antes de rendirse. Cada intento son hasta 14
   * pasos, y cada paso una llamada al modelo.
   *
   * El techo no arregla la causa; corta el desperdicio y hace que el agente le
   * pregunte al usuario en vez de girar. Vive en `deps` porque `deps` es lo único
   * que sobrevive entre vueltas de un mismo pedido.
   */
  formAttempts?: number
}

/**
 * Dos intentos. El primero hace el trabajo; el segundo cubre un fallo real.
 *
 * Del tercero en adelante ya no es "reintentar": es no poder distinguir hecho de
 * no hecho, y eso no se resuelve repitiendo.
 */
const MAX_FORM_ATTEMPTS = 2

/** La vista que ve el modelo. Sin descripciones largas: solo lo que decide. */
export function toView(jobs: RankedJob[], kitReady: Set<string>): AgentJobView[] {
  return jobs.map((j) => ({
    id: j.id,
    company: j.company,
    title: j.title,
    score: j.score,
    kitReady: kitReady.has(j.id)
  }))
}

function findJob(deps: ToolDeps, args: Record<string, unknown>): RankedJob | string {
  const id = typeof args.id === 'string' ? args.id : ''
  if (id === '') return 'falta el argumento "id"'

  const job = deps.screen.find((j) => j.id === id)
  if (job === undefined) {
    return `no hay ninguna vacante con id "${id}" en pantalla. Las que hay: ${
      deps.screen.map((j) => `${j.id} (${j.company})`).join(', ') || 'ninguna'
    }`
  }
  return job
}

function asStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()]
  return []
}

/**
 * Ejecuta una herramienta. Nunca tira: un fallo es un resultado que el modelo
 * lee y decide qué hacer con él.
 *
 * `result` está escrito para que lo lea el MODELO, no el usuario: dice qué
 * pasó y con qué datos sigue. Lo que ve el usuario sale del campo `say` de la
 * decisión.
 */
export async function runTool(
  tool: string,
  args: Record<string, unknown>,
  deps: ToolDeps
): Promise<ToolResult> {
  switch (tool) {
    case 'buscar': {
      const report = await hunt({
        queries: asStrings(args.roles),
        location: typeof args.ubicacion === 'string' ? args.ubicacion : '',
        avoid: [],
        maxRank: 60,
        saveToNotion: true,
        llm: deps.llm,
        onProgress: deps.onProgress
      })

      deps.screen = report.qualified
      const top = report.qualified
        .slice(0, 10)
        .map((j) => `id=${j.id} ${j.company} "${j.title}" ${j.score}`)
        .join('; ')

      return {
        ok: true,
        screen: toView(report.qualified, deps.kitReady),
        result:
          `encontré ${report.found}, puntué ${report.ranked}, califican ${report.qualified.length}` +
          (report.skipped > 0 ? `, ${report.skipped} quedaron sin mirar` : '') +
          (report.notion.error !== null ? `. Notion falló: ${report.notion.error}` : '') +
          (top !== '' ? `. Son: ${top}` : `. ${report.summary}`)
      }
    }

    case 'preparar_cv': {
      const job = findJob(deps, args)
      if (typeof job === 'string') return { ok: false, result: job }

      const kit = await generateKit({
        url: job.url,
        company: job.company,
        role: job.title,
        slug: slugify(job.company),
        onLine: (line) => deps.onProgress?.('armando el CV', `${job.company}: ${line}`)
      })

      if (!kit.ok) return { ok: false, result: `no pude armar el CV: ${kit.message}` }

      deps.kitReady.add(job.id)
      return {
        ok: true,
        screen: toView(deps.screen, deps.kitReady),
        result: `CV y carta listos para ${job.company}`
      }
    }

    case 'postular': {
      const job = findJob(deps, args)
      if (typeof job === 'string') return { ok: false, result: job }

      /*
       * El modo lo decide el AGENTE, y por defecto ENVÍA.
       *
       * Estaba fijo en `review`: llenaba el formulario, frenaba antes de
       * mandar y dejaba la ventana abierta. Con nueve vacantes eso son nueve
       * pestañas abiertas y cero postulaciones enviadas — el usuario terminaba
       * apretando "enviar" nueve veces a mano, que es exactamente de lo que
       * venía a salvarlo la app. Reclamo textual: *"qué mierda hago para no
       * postularme manualmente"*.
       *
       * Era una decisión mía metida en la máquina. Si el usuario quiere
       * revisar antes, lo escribe en sus reglas y el agente manda "review".
       */
      const mode = args.modo === 'review' ? 'review' : args.modo === 'dry-run' ? 'dry-run' : 'auto'

      const report = await runApplication({
        url: job.url,
        company: job.company,
        role: job.title,
        slug: slugify(job.company),
        mode,
        sector: '',
        fitRating: String(job.score),
        jobDescription: job.description,
        llm: deps.llm,
        onStep: (s) => deps.onProgress?.('postulando', `${job.company}: ${s.action}`),
        onProgress: (detail) => deps.onProgress?.('postulando', `${job.company}: ${detail}`)
      })

      const { status, message, unresolved } = report.outcome
      if (status === 'submitted' || status === 'filled') deps.kitReady.add(job.id)

      return {
        ok: status === 'submitted' || status === 'filled',
        screen: toView(deps.screen, deps.kitReady),
        result:
          `${job.company}: ${status}. ${message}` +
          (report.kit.cv !== null ? ' CV adjuntado.' : ' SIN CV adjunto.') +
          (unresolved.length > 0 ? ` Campos sin responder: ${unresolved.join(', ')}.` : '') +
          (status === 'submitted'
            ? ' ENVIADA. Ya está postulado, no hace falta que él haga nada.'
            : report.windowLeftOpen
              ? ' Quedó llena SIN enviar y la ventana abierta: el usuario tiene que apretar enviar.'
              : '')
      }
    }

    /*
     * Trabajar sobre la ventana que quedó abierta.
     *
     * No reimplementa nada: le pasa un objetivo en castellano a `achieveGoal`, el
     * mismo motor que usa el agente de conexiones y el que ya resuelve "llegar al
     * formulario". Acá el objetivo lo escribe el USUARIO —"rellená estas
     * preguntas"— y el modelo mira la pantalla para cumplirlo.
     *
     * Es lo que hace posible el caso que estaba roto: las preguntas técnicas de
     * Greenhouse viven detrás de un acordeón, así que NO son campos hasta que algo
     * las abre. Ningún lector de DOM las va a ver; hay que abrirlas primero, y eso
     * es mirar y decidir.
     *
     * `maxSteps` alto porque cada pregunta son dos acciones —abrir y escribir— y
     * pueden ser cinco o seis preguntas.
     */
    case 'completar_formulario': {
      const open = openApplication()
      if (open === null) {
        return {
          ok: false,
          result:
            'no hay ninguna postulación abierta en este momento. ' +
            'Se abre una cuando te postulás en modo review y el formulario queda lleno sin enviar.'
        }
      }

      const what = typeof args.que_hacer === 'string' ? args.que_hacer.trim() : ''
      if (what === '') {
        return { ok: false, result: 'falta decir QUÉ completar en el formulario' }
      }

      /*
       * Techo de intentos, y el mensaje le dice al agente qué hacer en su lugar.
       *
       * Sin esto reintentó cinco veces el mismo trabajo sobre las preguntas de
       * Monks —33 minutos— porque no tiene forma de verificar si una respuesta se
       * grabó: relee la pantalla, ve la pregunta, y concluye que faltó. Repetir no
       * lo va a resolver, y el usuario mientras tanto no sabe si está vivo.
       */
      deps.formAttempts = (deps.formAttempts ?? 0) + 1
      if (deps.formAttempts > MAX_FORM_ATTEMPTS) {
        return {
          ok: false,
          result:
            `Ya intenté ${MAX_FORM_ATTEMPTS} veces completar ese formulario y no puedo ` +
            'confirmar si las respuestas se están grabando. NO vuelvas a intentarlo: ' +
            'contale al usuario qué preguntas quedaron, que la ventana está abierta, y ' +
            'pedile que mire la pantalla y te diga qué ve. Terminá el pedido con done: true.'
        }
      }

      open.page.reveal()
      deps.onProgress?.('completando el formulario', `${open.job.company}: ${what.slice(0, 80)}`)

      const goal =
        `Completar lo que falta en el formulario de postulación de ${open.job.company} ` +
        `para el puesto "${open.job.role}", que ya está abierto en esta ventana.\n` +
        `Lo que hay que hacer, en palabras del candidato: ${what}\n` +
        'Varias preguntas pueden estar COLAPSADAS detrás de un acordeón o un desplegable: ' +
        'primero abrilas y después escribí la respuesta. ' +
        'Las respuestas las escribís vos con lo que sabés del candidato por sus reglas y su perfil, ' +
        'sin inventar experiencia que no tenga. ' +
        'NO envíes la postulación, no aprietes Submit ni Enviar: solo dejá el formulario completo.'

      const r = await achieveGoal(
        open.page,
        { goal },
        (prompt) => deps.llm.provider.run(prompt, deps.llm.model),
        {
          maxSteps: 14,
          onAction: (detail, ok) => {
            console.log(`[apply] completar${ok ? '' : ' FALLÓ'}: ${detail}`)
            deps.onProgress?.('completando el formulario', detail)
          }
        }
      )

      return {
        ok: r.ok,
        result:
          `${r.ok ? 'Trabajé' : 'No pude terminar'} sobre el formulario de ${open.job.company}: ${r.detail}. ` +
          'La ventana sigue abierta y SIN enviar.'
      }
    }

    case 'listar_postulaciones': {
      if (!isNotionConfigured()) {
        return { ok: false, result: 'Notion no está conectado, no puedo leer el registro' }
      }

      const rows = await listApplications()
      if (rows.length === 0) return { ok: true, result: 'la base está vacía' }

      // Compacto y completo: el modelo necesita los datos, no una tabla linda.
      const lines = rows
        .map(
          (r) =>
            `${r.company} | ${r.role} | ${r.status} | ` +
            `${r.daysSince === null ? 'sin fecha' : `hace ${r.daysSince} días`} | ${r.url}`
        )
        .join('\n')

      return { ok: true, result: `${rows.length} postulaciones:\n${lines}` }
    }

    case 'marcar_estado': {
      const url = typeof args.url === 'string' ? args.url : ''
      const wanted = typeof args.estado === 'string' ? args.estado : ''

      if (url === '') return { ok: false, result: 'falta el argumento "url"' }

      // La lista es CERRADA. Un estado inventado hace que Notion cree la opción
      // sola y le rompe los filtros al usuario: mejor decir que no existe.
      if (!(NOTION_STATUSES as readonly string[]).includes(wanted)) {
        return {
          ok: false,
          result: `"${wanted}" no es un estado válido. Solo: ${NOTION_STATUSES.join(', ')}`
        }
      }

      if (!isNotionConfigured()) {
        return { ok: false, result: 'Notion no está conectado, no puedo escribir el estado' }
      }

      const done = await markStatus(url, wanted as NotionStatus)
      return done
        ? { ok: true, result: `quedó en "${wanted}"` }
        : { ok: false, result: 'esa url no está en la base de Notion' }
    }

    case 'subir_a_drive': {
      const job = findJob(deps, args)
      if (typeof job === 'string') return { ok: false, result: job }

      const which = args.archivo === 'carta' ? 'carta' : 'cv'
      const kit = await createWorkspaceKitSource(uploadStagingDir()).findKit({
        url: job.url,
        company: job.company,
        role: job.title,
        slug: slugify(job.company)
      })

      const path = which === 'carta' ? kit.cover : kit.cv
      if (path === null) {
        return {
          ok: false,
          result: `no hay ${which} compilada para ${job.company}. Armala antes con preparar_cv.`
        }
      }

      /*
       * La carpeta sale de las REGLAS, no de una constante.
       *
       * Es el link que el usuario pegó en su `.md`. Un id hardcodeado solo
       * funcionaría en una cuenta — el mismo motivo por el que la base de
       * Notion tampoco es una constante.
       */
      const folder = readRules(JOB_SEARCH_ID, '').drive[0]?.id ?? ''
      if (folder === '') {
        return {
          ok: false,
          result:
            'el usuario no puso ninguna carpeta de Drive en sus reglas. ' +
            'Decile que pegue el link de la carpeta en su archivo de reglas.'
        }
      }

      const name = typeof args.nombre === 'string' && args.nombre.trim() !== '' ? args.nombre.trim() : ''
      const up = await uploadToFolder(path, folder, name === '' ? '' : `${name}.pdf`)

      return {
        ok: true,
        result:
          `${up.reused ? 'ya estaba subido' : 'subido'} como "${up.name}"` +
          (up.link !== null ? ` — ${up.link}` : '')
      }
    }

    case 'confirmar_envio': {
      const job = findJob(deps, args)
      if (typeof job === 'string') return { ok: false, result: job }

      await confirmApplied({
        date: new Date().toISOString().slice(0, 10),
        company: job.company,
        sector: '',
        role: job.title,
        roleType: '',
        channel: /linkedin\.com/i.test(job.url) ? 'LinkedIn' : 'Portal',
        status: 'applied',
        contactPerson: '',
        fitRating: String(job.score),
        notes: job.angle,
        cvFile: '',
        coverLetterFile: '',
        source: job.url
      })

      return { ok: true, result: `${job.company} quedó registrada como enviada en el tracker` }
    }

    case 'descartar': {
      const job = findJob(deps, args)
      if (typeof job === 'string') return { ok: false, result: job }

      deps.screen = deps.screen.filter((j) => j.id !== job.id)

      /*
       * Descartar PERSISTE. Sacarla solo de la pantalla la traía de vuelta en
       * el barrido siguiente y había que descartarla otra vez, para siempre —
       * la contracara del bug que hacía desaparecer las buenas: la base no
       * distinguía "la vi" de "la resolví".
       */
      let note = 'solo de la pantalla (Notion no está conectado)'
      if (isNotionConfigured()) {
        try {
          note = (await markDiscarded(job.url))
            ? 'y marcada "Descartada" en Notion: no vuelve a aparecer'
            : 'de la pantalla; en Notion no estaba, así que no había qué marcar'
        } catch (error: unknown) {
          note = `de la pantalla, pero Notion falló: ${String(error)}`
        }
      }

      return {
        ok: true,
        screen: toView(deps.screen, deps.kitReady),
        result: `saqué ${job.company} ${note}`
      }
    }

    default:
      return { ok: false, result: `no existe la herramienta "${tool}"` }
  }
}

/** Reexportado para que el runner arme la vista inicial sin importar rank.ts. */
export { applyFloor }
