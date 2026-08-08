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

type Autor = 'vos' | 'agente'

interface Adjunto {
  etiqueta: string
  /** Ruta local o URL. La UI decide cómo abrirla. */
  destino: string
  tipo: 'captura' | 'archivo' | 'link'
}

interface Mensaje {
  id: string
  autor: Autor
  texto: string
  /** Vacantes que se muestran como tarjetas dentro del mensaje. */
  vacantes?: RankedJobRow[]
  /** Evidencia: captura, PDF, link a Notion. */
  adjuntos?: Adjunto[]
  /** `true` mientras el agente está trabajando en esto. */
  trabajando?: boolean
}

let contador = 0
const nuevoId = (): string => `m${++contador}`

export function JobChat({ providerId, modelId, onError }: Props): React.JSX.Element {
  const [status, setStatus] = useState<JobsStatus | null>(null)
  const [mensajes, setMensajes] = useState<Mensaje[]>([])
  const [entrada, setEntrada] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const [verConexiones, setVerConexiones] = useState(false)
  /** Lo que el usuario está VIENDO. "la primera" se resuelve contra esto. */
  const [enPantalla, setEnPantalla] = useState<RankedJobRow[]>([])

  const finRef = useRef<HTMLDivElement>(null)

  const refrescarStatus = useCallback((): void => {
    void window.api.jobsStatus().then((res) => {
      if (res.ok) setStatus(res.data)
    })
  }, [])

  useEffect(refrescarStatus, [refrescarStatus])

  // Siempre al pie: en un chat, lo último es lo que importa.
  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [mensajes])

  const decir = (m: Omit<Mensaje, 'id'>): string => {
    const id = nuevoId()
    setMensajes((prev) => [...prev, { ...m, id }])
    return id
  }

  const actualizar = (id: string, cambios: Partial<Mensaje>): void => {
    setMensajes((prev) => prev.map((m) => (m.id === id ? { ...m, ...cambios } : m)))
  }

  /*
   * El progreso se pinta en el ÚLTIMO mensaje del agente, no como mensajes
   * nuevos. Si no, un barrido de doce vacantes deja veinte renglones de
   * "puntuando…" y el resultado queda enterrado arriba.
   */
  const progresoRef = useRef<string | null>(null)

  useEffect(() => {
    const off = window.api.onHuntProgress((p: HuntProgress) => {
      if (progresoRef.current !== null) {
        actualizar(progresoRef.current, { texto: `${p.fase}: ${p.detalle}`, trabajando: true })
      }
    })
    return off
  }, [])

  const buscar = async (queries: string[], ubicacion: string | null): Promise<void> => {
    const id = decir({ autor: 'agente', texto: 'buscando…', trabajando: true })
    progresoRef.current = id

    try {
      const res = await window.api.jobsHunt({
        // Vacío = lo que digan las reglas. El default de acá es la red de
        // contención para quien todavía no escribió ninguna.
        queries: queries.length > 0 ? queries : ['frontend developer', 'react developer'],
        location: ubicacion ?? 'Colombia',
        maxRank: 12,
        guardarEnNotion: true,
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

      progresoRef.current = null

      if (!res.ok) {
        actualizar(id, { texto: res.error.message, trabajando: false })
        return
      }

      const d = res.data
      setEnPantalla(d.califican)

      // El resumen dice qué NO pasó, no solo qué pasó: "3 de 12" es la
      // información, "3 vacantes" es la mitad.
      const partes = [`Encontré ${d.encontradas}`]
      if (d.repetidas > 0) partes.push(`${d.repetidas} ya las conocías`)
      partes.push(`califican ${d.califican.length} de ${d.rankeadas}`)

      actualizar(id, {
        texto: `${partes.join(' · ')}.`,
        trabajando: false,
        vacantes: d.califican
      })

      if (d.califican.length === 0) {
        decir({
          autor: 'agente',
          texto:
            'Ninguna llegó al piso de 65. No relleno el lote con fits flojos: es lo que hace que mandes veinte postulaciones y no te contesten ninguna.'
        })
      }
    } catch (error: unknown) {
      progresoRef.current = null
      actualizar(id, { texto: String(error), trabajando: false })
    }
  }

  const postular = async (job: RankedJobRow): Promise<void> => {
    const id = decir({
      autor: 'agente',
      texto: `armando el CV a medida para ${job.company}…`,
      trabajando: true
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
          actualizar(id, { texto: `no pude armar el CV: ${kit.error.message}`, trabajando: false })
          return
        }
      }

      actualizar(id, { texto: `llenando el formulario de ${job.company}…`, trabajando: true })

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
        actualizar(id, { texto: res.error.message, trabajando: false })
        return
      }

      const r = res.data

      /*
       * La evidencia, que es lo que contesta "mostrame cómo se hizo".
       *
       * La captura sale del ÚLTIMO paso: es la foto del formulario ya lleno,
       * no la de la pantalla vacía del principio.
       */
      const adjuntos: Adjunto[] = []
      const ultimo = [...r.steps].reverse().find((s) => s.screenshot !== null)
      if (ultimo?.screenshot != null) {
        adjuntos.push({ etiqueta: 'ver la captura', destino: ultimo.screenshot, tipo: 'captura' })
      }
      if (r.cvFound !== null) {
        adjuntos.push({ etiqueta: 'abrir el CV', destino: r.cvFound, tipo: 'archivo' })
      }
      if (r.notionPageId !== null) {
        adjuntos.push({
          etiqueta: 'ver en Notion',
          destino: `https://www.notion.so/${r.notionPageId.replace(/-/g, '')}`,
          tipo: 'link'
        })
      }

      const campos = r.steps.reduce((n, s) => n + s.filled, 0)
      const adjuntado = r.uploadedAs.length > 0 ? ` y adjunté ${r.uploadedAs.join(', ')}` : ''

      const detalle =
        r.status === 'filled'
          ? `Llené ${campos} campos${adjuntado}. Frené antes de enviar — decime "mandala" si va.`
          : r.status === 'submitted'
            ? `Enviada. ${campos} campos${adjuntado}.`
            : r.status === 'needs-login'
              ? 'Me falta tu sesión en ese sitio. Conectala y volvemos.'
              : `${r.message} (${r.status})`

      actualizar(id, { texto: detalle, trabajando: false, adjuntos })

      if (r.unresolved.length > 0) {
        decir({
          autor: 'agente',
          texto: `Dejé vacíos ${r.unresolved.length} campos que no supe contestar sin inventar: ${r.unresolved.join(', ')}.`
        })
      }
    } catch (error: unknown) {
      actualizar(id, { texto: String(error), trabajando: false })
    }
  }

  const mostrar = (job: RankedJobRow): void => {
    decir({
      autor: 'agente',
      texto: `${job.company} · ${job.title} — puntaje ${job.score}. ${job.reason}`,
      adjuntos: [{ etiqueta: 'abrir la vacante', destino: job.url, tipo: 'link' }]
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
  const enviar = async (job: RankedJobRow): Promise<void> => {
    const id = decir({ autor: 'agente', texto: `registrando ${job.company}…`, trabajando: true })
    const res = await window.api.jobsConfirm({
      url: job.url,
      company: job.company,
      role: job.title,
      fitRating: String(job.score)
    })
    actualizar(id, {
      texto: res.ok ? `Listo, quedó registrada: ${job.company}.` : res.error.message,
      trabajando: false
    })
  }

  const mandar = async (): Promise<void> => {
    const texto = entrada.trim()
    if (texto === '' || ocupado) return

    decir({ autor: 'vos', texto })
    setEntrada('')
    setOcupado(true)
    onError(null)

    try {
      const res = await window.api.jobsChat({
        texto,
        vacantes: enPantalla.map((v) => ({
          id: v.id,
          company: v.company,
          title: v.title,
          score: v.score
        }))
      })

      if (!res.ok) {
        decir({ autor: 'agente', texto: res.error.message })
        return
      }

      const intent = res.data
      const buscarJob = (id: string): RankedJobRow | undefined => enPantalla.find((v) => v.id === id)

      switch (intent.kind) {
        case 'buscar':
          await buscar(intent.queries, intent.ubicacion)
          break
        case 'postular': {
          const j = buscarJob(intent.id)
          if (j !== undefined) await postular(j)
          break
        }
        case 'mostrar': {
          const j = buscarJob(intent.id)
          if (j !== undefined) mostrar(j)
          break
        }
        case 'enviar': {
          const j = buscarJob(intent.id)
          if (j !== undefined) await enviar(j)
          break
        }
        case 'descartar': {
          const j = buscarJob(intent.id)
          setEnPantalla((prev) => prev.filter((v) => v.id !== intent.id))
          decir({ autor: 'agente', texto: `Listo, saqué ${j?.company ?? 'esa'} de la lista.` })
          break
        }
        case 'ambiguo':
          // No adivinar: postularse a la equivocada no se deshace.
          decir({
            autor: 'agente',
            texto: '¿A cuál? Decime el número o la empresa:',
            vacantes: enPantalla.filter((v) => intent.candidatas.some((c) => c.id === v.id))
          })
          break
        case 'conversar':
          decir({
            autor: 'agente',
            texto:
              'Eso todavía no lo sé contestar — me falta la parte que le pregunta al modelo. Por ahora probá: "buscame trabajo", "postulate a la 1", "mostrame la 2".'
          })
          break
        default:
          decir({
            autor: 'agente',
            texto:
              'Puedo: buscar vacantes, postularme a una, mostrarte cómo quedó, enviarla o descartarla. Escribilo como lo dirías.'
          })
      }
    } finally {
      setOcupado(false)
    }
  }

  const faltan: string[] = []
  if (status !== null) {
    if (!status.linkedInSession) faltan.push('LinkedIn')
    if (!status.notionReady) faltan.push('Notion')
    if (!status.gmailReady) faltan.push('Google')
  }

  return (
    <div className="jobchat">
      <div className="jobchat-barra">
        <button
          type="button"
          className={`job-conexiones-btn ${faltan.length > 0 ? 'job-conexiones-falta' : ''}`}
          onClick={() => setVerConexiones(!verConexiones)}
          title={faltan.length > 0 ? `sin conectar: ${faltan.join(' · ')}` : 'todo conectado'}
        >
          conexiones
          <span className="job-conexiones-estado">{faltan.length > 0 ? faltan.length : '✓'}</span>
        </button>
      </div>

      {verConexiones && <ConnectionsPanel onCambio={refrescarStatus} onError={onError} />}

      <div className="jobchat-hilo">
        {mensajes.length === 0 && (
          <div className="jobchat-vacio">
            <p>Decime qué necesitás. Por ejemplo:</p>
            <ul>
              <li onClick={() => setEntrada('buscame trabajo, hacé un barrido')}>
                buscame trabajo, hacé un barrido
              </li>
              <li onClick={() => setEntrada('buscame frontend developer en Colombia')}>
                buscame frontend developer en Colombia
              </li>
            </ul>
            <p className="jobchat-vacio-nota">
              Lo que busco y lo que descarto sale de tus reglas — no hace falta repetirlo acá.
            </p>
          </div>
        )}

        {mensajes.map((m) => (
          <article key={m.id} className={`msg msg-${m.autor}`}>
            <div className="msg-texto">
              {m.trabajando === true && <span className="msg-latido" />}
              {m.texto}
            </div>

            {m.vacantes !== undefined && m.vacantes.length > 0 && (
              <div className="msg-vacantes">
                {m.vacantes.map((v, i) => (
                  <div key={v.id} className="vac">
                    <div className="vac-head">
                      <span className="vac-num">{i + 1}</span>
                      <span className="vac-empresa">{v.company}</span>
                      <span className="vac-score">{v.score}</span>
                    </div>
                    <div className="vac-titulo">{v.title}</div>
                    {v.reason !== '' && <div className="vac-razon">{v.reason}</div>}
                    <div className="vac-acciones">
                      <button type="button" onClick={() => void postular(v)} disabled={ocupado}>
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

            {m.adjuntos !== undefined && m.adjuntos.length > 0 && (
              <div className="msg-adjuntos">
                {m.adjuntos.map((a) => (
                  <button
                    key={a.destino}
                    type="button"
                    className="adjunto"
                    onClick={() => void window.api.openExternal(a.destino)}
                  >
                    {a.etiqueta}
                  </button>
                ))}
              </div>
            )}
          </article>
        ))}

        <div ref={finRef} />
      </div>

      <div className="jobchat-entrada">
        <input
          value={entrada}
          placeholder="escribile al agente…"
          disabled={ocupado}
          onChange={(e) => setEntrada(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void mandar()
          }}
        />
        <button type="button" disabled={ocupado || entrada.trim() === ''} onClick={() => void mandar()}>
          {ocupado ? '…' : 'enviar'}
        </button>
      </div>
    </div>
  )
}
