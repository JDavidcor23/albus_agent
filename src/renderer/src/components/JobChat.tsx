import { useCallback, useEffect, useRef, useState } from 'react'
import type { HuntProgress, JobsStatus, RankedJobRow } from '../../../shared/ipc'
import { ConnectionsPanel } from './ConnectionsPanel'

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
 * Lo que se escribe lo interpreta `core/jobs/chat.ts`, que es puro: un comando
 * como "postulate a la primera" se resuelve con reglas, gratis y al instante.
 * Solo lo que una regla no puede contestar va al modelo.
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
  /** Evidencia: captura, PDF, link a Notion. */
  attachments?: Attachment[]
  /** `true` mientras el agente está trabajando en esto. */
  working?: boolean
}

let counter = 0
const newId = (): string => `m${++counter}`

export function JobChat({ providerId, modelId, onError }: Props): React.JSX.Element {
  const [status, setStatus] = useState<JobsStatus | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [showConnections, setShowConnections] = useState(false)
  /** Lo que el usuario está VIENDO. "la primera" se resuelve contra esto. */
  const [onScreen, setOnScreen] = useState<RankedJobRow[]>([])

  const endRef = useRef<HTMLDivElement>(null)

  const refreshStatus = useCallback((): void => {
    void window.api.jobsStatus().then((res) => {
      if (res.ok) setStatus(res.data)
    })
  }, [])

  useEffect(refreshStatus, [refreshStatus])

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

  const search = async (queries: string[], location: string | null): Promise<void> => {
    const id = say({ author: 'agente', text: 'buscando…', working: true })
    progressRef.current = id

    try {
      const res = await window.api.jobsHunt({
        // Vacío = lo que digan las reglas. El default de acá es la red de
        // contención para quien todavía no escribió ninguna.
        queries: queries.length > 0 ? queries : ['frontend developer', 'react developer'],
        location: location ?? 'Colombia',
        maxRank: 12,
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
      // información, "3 vacantes" es la mitad.
      const parts = [`Encontré ${d.found}`]
      if (d.duplicates > 0) parts.push(`${d.duplicates} ya las conocías`)
      parts.push(`califican ${d.qualified.length} de ${d.ranked}`)

      update(id, {
        text: `${parts.join(' · ')}.`,
        working: false,
        jobs: d.qualified
      })

      if (d.qualified.length === 0) {
        say({
          author: 'agente',
          text:
            'Ninguna llegó al piso de 65. No relleno el lote con fits flojos: es lo que hace que mandes veinte postulaciones y no te contesten ninguna.'
        })
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

      update(id, { text: `llenando el formulario de ${job.company}…`, working: true })

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
        attachments.push({ label: 'ver la captura', target: last.screenshot, type: 'screenshot' })
      }
      if (r.cvFound !== null) {
        attachments.push({ label: 'abrir el CV', target: r.cvFound, type: 'file' })
      }
      if (r.notionPageId !== null) {
        attachments.push({
          label: 'ver en Notion',
          target: `https://www.notion.so/${r.notionPageId.replace(/-/g, '')}`,
          type: 'link'
        })
      }

      const fields = r.steps.reduce((n, s) => n + s.filled, 0)
      const attached = r.uploadedAs.length > 0 ? ` y adjunté ${r.uploadedAs.join(', ')}` : ''

      const detail =
        r.status === 'filled'
          ? `Llené ${fields} campos${attached}. Frené antes de enviar — decime "mandala" si va.`
          : r.status === 'submitted'
            ? `Enviada. ${fields} campos${attached}.`
            : r.status === 'needs-login'
              ? 'Me falta tu sesión en ese sitio. Conectala y volvemos.'
              : `${r.message} (${r.status})`

      update(id, { text: detail, working: false, attachments })

      if (r.unresolved.length > 0) {
        say({
          author: 'agente',
          text: `Dejé vacíos ${r.unresolved.length} campos que no supe contestar sin inventar: ${r.unresolved.join(', ')}.`
        })
      }
    } catch (error: unknown) {
      update(id, { text: String(error), working: false })
    }
  }

  const show = (job: RankedJobRow): void => {
    say({
      author: 'agente',
      text: `${job.company} · ${job.title} — puntaje ${job.score}. ${job.reason}`,
      attachments: [{ label: 'abrir la vacante', target: job.url, type: 'link' }]
    })
  }

  /**
   * Confirmar lo que quedó frenado.
   *
   * Esto es lo que registra la postulación en el tracker — el envío real lo
   * hace el modo `auto` del apply. Se pide explícitamente y no se encadena
   * solo: `review` frena a propósito, y saltearlo desde acá sería devolverle
   * el gatillo automático al agente por la puerta de atrás.
   */
  const sendJob = async (job: RankedJobRow): Promise<void> => {
    const id = say({ author: 'agente', text: `registrando ${job.company}…`, working: true })
    const res = await window.api.jobsConfirm({
      url: job.url,
      company: job.company,
      role: job.title,
      fitRating: String(job.score)
    })
    update(id, {
      text: res.ok ? `Listo, quedó registrada: ${job.company}.` : res.error.message,
      working: false
    })
  }

  const submit = async (): Promise<void> => {
    const text = input.trim()
    if (text === '' || busy) return

    say({ author: 'vos', text })
    setInput('')
    setBusy(true)
    onError(null)

    try {
      const res = await window.api.jobsChat({
        text,
        jobs: onScreen.map((v) => ({
          id: v.id,
          company: v.company,
          title: v.title,
          score: v.score
        }))
      })

      if (!res.ok) {
        say({ author: 'agente', text: res.error.message })
        return
      }

      const intent = res.data
      const findJob = (id: string): RankedJobRow | undefined => onScreen.find((v) => v.id === id)

      switch (intent.kind) {
        case 'search':
          await search(intent.queries, intent.location)
          break
        case 'apply': {
          const j = findJob(intent.id)
          if (j !== undefined) await apply(j)
          break
        }
        case 'show': {
          const j = findJob(intent.id)
          if (j !== undefined) show(j)
          break
        }
        case 'send': {
          const j = findJob(intent.id)
          if (j !== undefined) await sendJob(j)
          break
        }
        case 'discard': {
          const j = findJob(intent.id)
          setOnScreen((prev) => prev.filter((v) => v.id !== intent.id))
          say({ author: 'agente', text: `Listo, saqué ${j?.company ?? 'esa'} de la lista.` })
          break
        }
        case 'ambiguous':
          // No adivinar: postularse a la equivocada no se deshace.
          say({
            author: 'agente',
            text: '¿A cuál? Decime el número o la empresa:',
            jobs: onScreen.filter((v) => intent.candidates.some((c) => c.id === v.id))
          })
          break
        case 'chat':
          say({
            author: 'agente',
            text:
              'Eso todavía no lo sé contestar — me falta la parte que le pregunta al modelo. Por ahora probá: "buscame trabajo", "postulate a la 1", "mostrame la 2".'
          })
          break
        default:
          say({
            author: 'agente',
            text:
              'Puedo: buscar vacantes, postularme a una, mostrarte cómo quedó, enviarla o descartarla. Escribilo como lo dirías.'
          })
      }
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
      <div className="jobchat-barra">
        <button
          type="button"
          className={`job-conexiones-btn ${missing.length > 0 ? 'job-conexiones-falta' : ''}`}
          onClick={() => setShowConnections(!showConnections)}
          title={missing.length > 0 ? `sin conectar: ${missing.join(' · ')}` : 'todo conectado'}
        >
          conexiones
          <span className="job-conexiones-estado">{missing.length > 0 ? missing.length : '✓'}</span>
        </button>
      </div>

      {showConnections && <ConnectionsPanel onChange={refreshStatus} onError={onError} />}

      <div className="jobchat-hilo">
        {messages.length === 0 && (
          <div className="jobchat-vacio">
            <p>Decime qué necesitás. Por ejemplo:</p>
            <ul>
              <li onClick={() => setInput('buscame trabajo, hacé un barrido')}>
                buscame trabajo, hacé un barrido
              </li>
              <li onClick={() => setInput('buscame frontend developer en Colombia')}>
                buscame frontend developer en Colombia
              </li>
            </ul>
            <p className="jobchat-vacio-nota">
              Lo que busco y lo que descarto sale de tus reglas — no hace falta repetirlo acá.
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
                        postular
                      </button>
                      <button type="button" onClick={() => void window.api.openExternal(v.url)}>
                        abrir ↗
                      </button>
                    </div>
                  </div>
                ))}
              </div>
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

        <div ref={endRef} />
      </div>

      <div className="jobchat-entrada">
        <input
          value={input}
          placeholder="escribile al agente…"
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
