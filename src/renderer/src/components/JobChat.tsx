import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentStep, HuntProgress, JobsStatus, RankedJobRow } from '../../../shared/ipc'

/**
 * El agente de trabajo como CONVERSACIÓN, no como formulario.
 *
 * Reemplaza al panel de campos y botones. El pedido fue textual: *"la idea es
 * que yo le diga búscame trabajo, haz un barrido, y yo interactuar desde chat
 * con el agente... también le puedo dar feedback, oye ¿me puedes mostrar cómo
 * se hizo la aplicación? pásame el archivo"*.
 *
 * ## Dos decisiones que explican todo lo de abajo
 *
 * **1. Una sola superficie.** No hay panel al lado mostrando el mismo estado:
 * tener el mismo dato en dos lugares es la fuente garantizada de "¿por qué acá
 * dice una cosa y allá otra?". Las vacantes viven como tarjetas DENTRO de la
 * conversación.
 *
 * **2. Cada acción deja su evidencia acá.** La captura del formulario, el PDF
 * que se adjuntó, el link a Notion. Eso es lo que contesta "mostrame cómo se
 * hizo" sin que haya que ir a buscar nada a otra pantalla.
 *
 * **3. Lo que escribís lo resuelve un AGENTE, no un router.** Antes pasaba por
 * `core/jobs/chat.ts` —ocho expresiones regulares— y lo que no encajaba moría
 * en "eso todavía no lo sé contestar": "postulame a todas" falló porque
 * `\bpostula\b` no matchea "postulame". Ahora va a `jobs:agent`, que le da al
 * modelo tus reglas enteras, las herramientas y lo que hay en pantalla, y él
 * decide. Sumar una capacidad es agregar una herramienta, no una frase.
 */

interface Props {
  providerId: string | null
  modelId: string | null
  onError: (m: string | null) => void
}

/** Alimenta la clase CSS `msg-vos` / `msg-agente`: los valores no cambian. */
type Author = 'vos' | 'agente'

interface Attachment {
  label: string
  /** Ruta local o URL. La UI decide cómo abrirla. */
  target: string
  type: 'screenshot' | 'file' | 'link'
}

interface Message {
  id: string
  author: Author
  text: string
  /** Vacantes que se muestran como tarjetas dentro del mensaje. */
  jobs?: RankedJobRow[]
  /**
   * Las que se puntuaron y NO pasaron, con su nota y su motivo.
   *
   * Llegaban por IPC desde siempre y el renderer las tiraba. Sin ellas, "0 de
   * 12" es un veredicto sin apelación: no se puede saber si el filtro está
   * fino o si el buscador trajo cualquier cosa. Con ellas, tres días de
   * diagnóstico se vuelven un vistazo.
   */
  rejected?: RankedJobRow[]
  /** Evidencia: captura, PDF, link a Notion. */
  attachments?: Attachment[]
  /** `true` mientras el agente está trabajando en esto. */
  working?: boolean
}

let counter = 0
const newId = (): string => `m${++counter}`

/**
 * Identidad fija del mensaje de apertura. A propósito no sale de `newId`:
 * ver `place`.
 */
const BACKLOG_MESSAGE = 'backlog'

export function JobChat({ providerId, modelId, onError }: Props): React.JSX.Element {
  const [status, setStatus] = useState<JobsStatus | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  /** Lo que el usuario está VIENDO. "la primera" se resuelve contra esto. */
  const [onScreen, setOnScreen] = useState<RankedJobRow[]>([])

  const endRef = useRef<HTMLDivElement>(null)

  const refreshStatus = useCallback((): void => {
    void window.api.jobsStatus().then((res) => {
      if (res.ok) setStatus(res.data)
    })
  }, [])

  useEffect(refreshStatus, [refreshStatus])

  /*
   * Al abrir, lo pendiente. Sin buscar nada.
   *
   * Antes la app arrancaba vacía y la única forma de volver a ver lo que ya
   * había encontrado era disparar un barrido de seis minutos — scraping y
   * tokens para recuperar una lista que ya estaba escrita en Notion. Pedido
   * textual: *"ya no quiero volver a darle buscar trabajo, quiero que las que
   * no he postulado ahí aparezcan"*.
   */
  useEffect(() => {
    void window.api.jobsBacklog().then((res) => {
      if (!res.ok || res.data.length === 0) return
      setOnScreen(res.data)
      // `place` y no `say`: este mensaje es UNO, corra el efecto las veces que
      // corra. Con `say` salía duplicado por el doble montaje de StrictMode.
      place(BACKLOG_MESSAGE, {
        author: 'agente',
        text: `You have ${res.data.length} unresolved from before. Tell me what to do with them.`,
        jobs: res.data
      })
    })
  }, [])

  // Siempre al pie: en un chat, lo último es lo que importa.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  const say = (m: Omit<Message, 'id'>): string => {
    const id = newId()
    setMessages((prev) => [...prev, { ...m, id }])
    return id
  }

  const update = (id: string, changes: Partial<Message>): void => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...changes } : m)))
  }

  /**
   * Un mensaje con identidad PROPIA: escribirlo dos veces lo pisa en su lugar
   * en vez de dejar dos.
   *
   * Existe por el mensaje de apertura, que se escribe desde un efecto de
   * montaje. React monta dos veces en StrictMode (`main.tsx`), y `say`
   * appendea: el usuario abría la app y leía "Tenés 12 sin resolver de antes"
   * DOS veces, con las mismas doce tarjetas debajo. Se verificó que no venían
   * repetidas de Notion — 12 filas, 12 URLs distintas.
   *
   * Un `useRef` de "ya lo hice" también lo tapaba, pero es un flag: se cae con
   * el próximo remonte, con HMR o con quien mueva el efecto. Acá la
   * idempotencia es del mensaje, no de la corrida que lo escribió — la misma
   * regla que el unique de `extractions` en el main.
   */
  const place = (id: string, m: Omit<Message, 'id'>): void => {
    setMessages((prev) => {
      const at = prev.findIndex((x) => x.id === id)
      if (at === -1) return [...prev, { ...m, id }]
      const next = [...prev]
      next[at] = { ...m, id }
      return next
    })
  }

  /*
   * El progreso se pinta en el ÚLTIMO mensaje del agente, no como mensajes
   * nuevos. Si no, un barrido de doce vacantes deja veinte renglones de
   * "puntuando…" y el resultado queda enterrado arriba.
   */
  const progressRef = useRef<string | null>(null)

  useEffect(() => {
    const off = window.api.onHuntProgress((p: HuntProgress) => {
      if (progressRef.current !== null) {
        update(progressRef.current, { text: `${p.phase}: ${p.detail}`, working: true })
      }
    })
    return off
  }, [])

  /*
   * Lo que el agente dice y hace, mientras lo hace.
   *
   * `say` es un mensaje suyo y se queda en el hilo: es lo que te contó. `tool`
   * y `progress` son ruido de trabajo y se pisan sobre el mismo renglón — doce
   * postulaciones dejarían cien líneas de "armando el CV…" y el resultado
   * enterrado arriba. Es la misma regla que ya usa el barrido.
   */
  useEffect(() => {
    const off = window.api.onAgentStep((step: AgentStep) => {
      if (step.kind === 'say') {
        progressRef.current = null
        if (step.text.trim() !== '') say({ author: 'agente', text: step.text })
        return
      }

      const detail = step.kind === 'tool' ? `${step.text}…` : step.text
      if (progressRef.current === null) {
        progressRef.current = say({ author: 'agente', text: detail, working: true })
      } else {
        update(progressRef.current, { text: detail, working: true })
      }
    })
    return off
  }, [])

  const search = async (queries: string[], location: string | null): Promise<void> => {
    const id = say({ author: 'agente', text: 'buscando…', working: true })
    progressRef.current = id

    try {
      const res = await window.api.jobsHunt({
        /*
         * Vacío = lo que digan las reglas. Y ahora se manda vacío de verdad.
         *
         * El comentario decía esto mismo mientras la línea de abajo mandaba dos
         * roles fijos, así que el `## Qué buscar` del `.md` no se leyó nunca:
         * quien escribía "backend developer" o "AI engineer" en sus reglas
         * seguía recibiendo búsquedas de React. El default vive en el main
         * (`DEFAULT_QUERIES`), que es donde vive el dominio.
         */
        queries,
        location: location ?? '',
        // Sin `maxRank`: el techo lo pone el main. Mandaba 12 fijo y dejaba
        // afuera todo lo que pasara de ahí, sin decirlo.
        saveToNotion: true,
        /*
         * Vacío = que elija el main.
         *
         * Detectar los CLIs tarda hasta 16 segundos, y si escribís antes de
         * que termine, acá todavía no hay ninguno. Mandar `''` daba el error
         * `el CLI "" no está disponible`, que culpaba al usuario de una
         * carrera interna. El main resuelve el primero disponible.
         */
        providerId: providerId ?? '',
        modelId
      })

      progressRef.current = null

      if (!res.ok) {
        update(id, { text: res.error.message, working: false })
        return
      }

      const d = res.data
      setOnScreen(d.qualified)

      // El resumen dice qué NO pasó, no solo qué pasó: "3 de 12" es la
      // información, "3 vacantes" es la mitad. Y lo que quedó SIN mirar es la
      // otra mitad: "califican 2 de 12" con 25 sin puntuar se lee como "solo
      // hay 2", que es exactamente lo contrario de lo que pasó.
      const parts = [`found ${d.found}`]
      if (d.duplicates > 0) parts.push(`${d.duplicates} you already knew`)
      parts.push(`scored ${d.ranked}`, `${d.qualified.length} qualify`)
      if (d.skipped > 0) parts.push(`${d.skipped} left unlooked-at`)

      update(id, {
        text: `${parts.join(' · ')}.`,
        working: false,
        jobs: d.qualified,
        rejected: d.rejected
      })

      if (d.qualified.length === 0) {
        /*
         * El texto lo escribe el MAIN, no acá.
         *
         * Acá había un literal: "Ninguna llegó al piso de 65". Se disparaba con
         * `qualified.length === 0` y nada más, así que afirmaba una causa que
         * el renderer no puede conocer — el cero también sale de un corte duro,
         * de un modelo que falló o de uno que no devolvió esas vacantes. Con la
         * búsqueda rota por "hacé un barrido" el mensaje era técnicamente
         * cierto y perfectamente engañoso, y costó tres días.
         *
         * `report.summary` viaja por IPC desde siempre y sabe cuántos días se
         * miraron y cuántas se descartaron.
         */
        say({ author: 'agente', text: d.summary })
      }
    } catch (error: unknown) {
      progressRef.current = null
      update(id, { text: String(error), working: false })
    }
  }

  const apply = async (job: RankedJobRow): Promise<void> => {
    const id = say({
      author: 'agente',
      text: `armando el CV a medida para ${job.company}…`,
      working: true
    })

    try {
      // El kit primero: postularse con un CV genérico es peor que no hacerlo.
      if (!job.kitReady) {
        const kit = await window.api.jobsKit({
          id: job.id,
          url: job.url,
          company: job.company,
          role: job.title,
          slug: job.slug
        })
        if (!kit.ok) {
          update(id, { text: `no pude armar el CV: ${kit.error.message}`, working: false })
          return
        }
      }

      update(id, { text: `filling in the ${job.company} form…`, working: true })

      const res = await window.api.jobsApply({
        url: job.url,
        company: job.company,
        role: job.title,
        slug: job.slug,
        mode: 'review',
        jobDescription: job.description,
        providerId,
        modelId
      })

      if (!res.ok) {
        update(id, { text: res.error.message, working: false })
        return
      }

      const r = res.data

      /*
       * La evidencia, que es lo que contesta "mostrame cómo se hizo".
       *
       * La captura sale del ÚLTIMO paso: es la foto del formulario ya lleno,
       * no la de la pantalla vacía del principio.
       */
      const attachments: Attachment[] = []
      const last = [...r.steps].reverse().find((s) => s.screenshot !== null)
      if (last?.screenshot != null) {
        attachments.push({ label: 'see the screenshot', target: last.screenshot, type: 'screenshot' })
      }
      if (r.cvFound !== null) {
        attachments.push({ label: 'open the CV', target: r.cvFound, type: 'file' })
      }
      if (r.notionPageId !== null) {
        attachments.push({
          label: 'see in Notion',
          target: `https://www.notion.so/${r.notionPageId.replace(/-/g, '')}`,
          type: 'link'
        })
      }

      const fields = r.steps.reduce((n, s) => n + s.filled, 0)
      const attached = r.uploadedAs.length > 0 ? ` and attached ${r.uploadedAs.join(', ')}` : ''

      const detail =
        r.status === 'filled'
          ? `Filled ${fields} fields${attached}. Stopped before sending — say "send it" if it looks right.`
          : r.status === 'submitted'
            ? `Sent. ${fields} fields${attached}.`
            : r.status === 'needs-login'
              ? 'I am missing your session on that site. Connect it and we try again.'
              : `${r.message} (${r.status})`

      update(id, { text: detail, working: false, attachments })

      if (r.unresolved.length > 0) {
        say({
          author: 'agente',
          text: `I left ${r.unresolved.length} fields empty that I could not answer without making things up: ${r.unresolved.join(', ')}.`
        })
      }
    } catch (error: unknown) {
      update(id, { text: String(error), working: false })
    }
  }

  /*
   * `show` y `sendJob` vivían acá y se fueron con el `switch`.
   *
   * No se perdió nada: mostrar una vacante es lo que el agente ya hace al
   * contestar, la tarjeta tiene su "abrir ↗", y registrar la postulación pasó
   * a ser la herramienta `confirmar_envio`. La diferencia es que ahora no
   * dependen de que el usuario diga la frase exacta que alguien previó.
   */

  const submit = async (): Promise<void> => {
    const text = input.trim()
    if (text === '' || busy) return

    say({ author: 'vos', text })
    setInput('')
    setBusy(true)
    onError(null)

    /*
     * Acá había un `switch` sobre lo que devolvía `interpret()`: ocho ramas,
     * una por comando previsto, y un `default` que pedía disculpas. Cada forma
     * nueva de decir lo mismo era una línea más de regex, y lo que no encajaba
     * moría en "eso todavía no lo sé contestar".
     *
     * Ahora hay una sola llamada. El agente lee tus reglas enteras, ve las
     * herramientas y la pantalla, y decide. Lo que dice mientras trabaja llega
     * por `onAgentStep`, porque un pedido puede tardar minutos.
     */
    try {
      const res = await window.api.jobsAgent({
        text,
        jobs: { screen: onScreen, providerId: providerId ?? '', modelId }
      })

      if (!res.ok) {
        say({ author: 'agente', text: res.error.message })
        return
      }

      /*
       * La lista se re-pinta SOLO si cambió.
       *
       * Acá se appendeaba un mensaje con `text: ''` y las vacantes en CADA vuelta.
       * Consecuencia: el agente contestaba "necesito tu nivel de inglés" y esa
       * pregunta quedaba enterrada bajo doce tarjetas repetidas. Reclamo textual:
       * *"pero el agente solo me sigue mostrando las postulaciones"*. Estaba
       * contestando; no se veía.
       *
       * Si la lista es la misma, lo último que el usuario lee es lo que el agente
       * dijo — que es lo que necesita para poder responderle.
       */
      const before = onScreen.map((j) => j.id).join('|')
      const after = res.data.screen.map((j) => j.id).join('|')

      // El agente pudo buscar, descartar o postular: la pantalla vuelve como
      // quedó. Es la única fuente de verdad; el renderer no la recalcula.
      setOnScreen(res.data.screen)

      if (res.data.screen.length > 0 && after !== before) {
        say({
          author: 'agente',
          // Con texto: un mensaje vacío con tarjetas adentro no dice por qué apareció.
          text: 'This is what is on screen now:',
          jobs: res.data.screen
        })
      }
    } finally {
      progressRef.current = null
      setBusy(false)
    }
  }

  /**
   * El pipeline, sin frase de por medio.
   *
   * No pasa por `jobsChat`: no hay nada que interpretar. El renderer manda
   * `queries: []` y el main resuelve con las reglas del `.md` — que es
   * exactamente lo que el botón promete.
   */
  const runPipeline = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    onError(null)
    try {
      await search([], null)
    } finally {
      setBusy(false)
    }
  }

  const missing: string[] = []
  if (status !== null) {
    if (!status.linkedInSession) missing.push('LinkedIn')
    if (!status.notionReady) missing.push('Notion')
    if (!status.gmailReady) missing.push('Google')
  }

  return (
    <div className="jobchat">
      {/*
        Solo el aviso, sin botón. Conectar se hace en Settings: es de la app y
        no de este agente. Un segundo lugar para hacerlo garantiza que uno de
        los dos quede desactualizado.
      */}
      {missing.length > 0 && (
        <div className="jobchat-barra">
          <span className="job-setup-falta" title={`not connected: ${missing.join(' · ')}`}>
            {missing.length} not connected ({missing.join(' · ')}) — fix it in Settings
          </span>
        </div>
      )}

      <div className="jobchat-hilo">
        {messages.length === 0 && (
          <div className="jobchat-vacio">
            {/*
              Un botón, no frases de ejemplo.

              Acá había dos sugerencias clickeables —"buscame trabajo, hacé un
              barrido"— arriba de una nota que decía que los criterios salen de
              las reglas. Se contradecían: la nota es cierta, así que pedirle al
              usuario que escriba el rol y la ciudad es pedirle que repita lo
              que ya escribió en su `.md`. Peor: "hacé un barrido" viajaba tal
              cual como término de búsqueda a LinkedIn.

              Lo que se ejecuta acá no cambia según cómo lo escribas. Es un
              botón.
            */}
            <button
              type="button"
              className="jobchat-pipeline"
              onClick={() => void runPipeline()}
              disabled={busy}
            >
              find work
            </button>
            <p className="jobchat-vacio-nota">
              I look for the roles in <strong>your rules</strong> and drop what you ruled out. You
              do not have to type anything — the chat is for whatever comes next.
            </p>
          </div>
        )}

        {messages.map((m) => (
          <article key={m.id} className={`msg msg-${m.author}`}>
            <div className="msg-texto">
              {m.working === true && <span className="msg-latido" />}
              {m.text}
            </div>

            {m.jobs !== undefined && m.jobs.length > 0 && (
              <div className="msg-vacantes">
                {m.jobs.map((v, i) => (
                  <div key={v.id} className="vac">
                    <div className="vac-head">
                      <span className="vac-num">{i + 1}</span>
                      <span className="vac-empresa">{v.company}</span>
                      <span className="vac-score">{v.score}</span>
                    </div>
                    <div className="vac-titulo">{v.title}</div>
                    {v.reason !== '' && <div className="vac-razon">{v.reason}</div>}
                    <div className="vac-acciones">
                      <button type="button" onClick={() => void apply(v)} disabled={busy}>
                        apply
                      </button>
                      <button type="button" onClick={() => void window.api.openExternal(v.url)}>
                        open ↗
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/*
              Las descartadas, con su nota y su motivo.

              Plegadas y no ocultas: son muchas y no son la acción del día, pero
              esconderlas es lo que hacía imposible distinguir "el filtro está
              fino" de "el buscador trajo cualquier cosa". Con esta lista a la
              vista, que la búsqueda estuviera preguntando por "hacé un barrido"
              se veía en el primer renglón.
            */}
            {m.rejected !== undefined && m.rejected.length > 0 && (
              <details className="msg-descartadas">
                <summary>{m.rejected.length} did not clear the floor of 65 — see why</summary>
                <ul>
                  {m.rejected.map((v) => (
                    <li key={v.id}>
                      <span className="desc-score">{v.score}</span>
                      <span className="desc-empresa">{v.company}</span>
                      <span className="desc-titulo">{v.title}</span>
                      <span className="desc-razon">
                        {v.gates.length > 0 && <em>{v.gates.join(' · ')} — </em>}
                        {v.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {m.attachments !== undefined && m.attachments.length > 0 && (
              <div className="msg-adjuntos">
                {m.attachments.map((a) => (
                  <button
                    key={a.target}
                    type="button"
                    className="adjunto"
                    onClick={() => void window.api.openExternal(a.target)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </article>
        ))}

        {/*
          Las sugerencias van DESPUÉS del resultado, no antes.

          Antes de buscar no hay nada que sugerir: el pipeline es un botón. Con
          vacantes en pantalla sí, porque recién ahí existe algo sobre lo que
          actuar — y son las acciones que el agente sabe hacer HOY, no las que
          nos gustaría. Un chip que no ejecuta nada es una promesa rota, que es
          justo lo que este panel viene arrastrando.
        */}
        {onScreen.length > 0 && !busy && (
          /*
            Estos chips ESCRIBEN en el campo, y lo que se escribe viaja al
            agente del main. Ahí el prompt del sistema está en español, pero lo
            interpreta un modelo: entiende inglés igual. Distinto es el chat de
            pendientes, que lo parsea una regex española — ver `core/tasks/ask.ts`.
          */
          <div className="jobchat-sugerencias">
            <button type="button" onClick={() => setInput('apply to 1')}>
              apply to 1
            </button>
            <button type="button" onClick={() => setInput('show me how 1 turned out')}>
              show me how 1 turned out
            </button>
            <button type="button" onClick={() => setInput('drop 1')}>
              drop 1
            </button>
            <button type="button" onClick={() => void runPipeline()}>
              search again
            </button>
          </div>
        )}

        <div ref={endRef} />
      </div>

      <div className="jobchat-entrada">
        <input
          value={input}
          placeholder="write to the agent…"
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
        <button type="button" disabled={busy || input.trim() === ''} onClick={() => void submit()}>
          {busy ? '…' : 'enviar'}
        </button>
      </div>
    </div>
  )
}
