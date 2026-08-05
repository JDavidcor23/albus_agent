import { useEffect, useRef, useState } from 'react'
import type { TaskDetail, TaskRow } from '../../../shared/ipc'

/**
 * Emails y links escondidos en el OCR.
 *
 * Es lo que contesta "¿me postulo por LinkedIn o por email?": si la captura traía
 * un contacto, está enterrado en mil caracteres de texto ruidoso. Sacarlo a la
 * superficie es la diferencia entre un detalle que se lee y uno que se ignora.
 */
const RE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/g
const RE_URL = /https?:\/\/[^\s<>"')\]]+/g

function contactosEn(textos: (string | null)[]): { emails: string[]; urls: string[] } {
  const todo = textos.filter((t): t is string => t !== null).join('\n')
  return {
    emails: [...new Set(todo.match(RE_EMAIL) ?? [])],
    urls: [...new Set(todo.match(RE_URL) ?? [])]
  }
}

const NOMBRE_FUENTE: Record<string, string> = {
  qr: 'código QR',
  receipt: 'comprobante',
  profile: 'perfil',
  document: 'documento',
  text: 'captura',
  none: 'sin contenido',
  failed: 'falló'
}

interface Turno {
  id: number
  de: 'vos' | 'albus'
  texto: string
  tasks: TaskRow[]
}

interface Props {
  onError: (mensaje: string) => void
}

/** Una regla no es una corazonada: se distingue en la tarjeta. */
function Origen({ source, confidence }: { source: string; confidence: number }): React.JSX.Element {
  if (source.startsWith('regla')) {
    return <span className="task-src task-src-regla">regla</span>
  }
  return <span className="task-src">ia · {Math.round(confidence * 100)}%</span>
}

function Detalle({
  detalle,
  onAbrir
}: {
  detalle: TaskDetail
  onAbrir: (url: string) => void
}): React.JSX.Element {
  const { emails, urls } = contactosEn(detalle.sources.map((s) => s.text))

  return (
    <div className="task-expand">
      {detalle.noteBody.length > 0 && (
        <div className="task-block">
          <span className="task-block-label">lo que escribiste</span>
          <p className="task-note">{detalle.noteBody}</p>
        </div>
      )}

      {(emails.length > 0 || urls.length > 0) && (
        <div className="task-block">
          {/* No dice "cómo contactar": entre los emails puede aparecer el del
              propio usuario, leído de su perfil en alguna captura. Prometer un
              canal de contacto y mostrarle su propia dirección es peor que
              nombrar las cosas por lo que son. */}
          <span className="task-block-label">emails y links en las capturas</span>
          <div className="task-links">
            {emails.map((e) => (
              <span key={e} className="task-contact">
                {e}
              </span>
            ))}
            {urls.map((u) => (
              <button key={u} type="button" className="task-link" onClick={() => onAbrir(u)}>
                {u.length > 54 ? `${u.slice(0, 54)}…` : u}
              </button>
            ))}
          </div>
        </div>
      )}

      {detalle.sources.map((s, i) => (
        <div className="task-block" key={`${s.kind}-${i}`}>
          <span className="task-block-label">
            {NOMBRE_FUENTE[s.kind] ?? s.kind}
            {s.driveFolder !== null && ` · drive/${s.driveFolder}`}
          </span>

          {s.text !== null && s.text.trim().length > 0 ? (
            <pre className="task-ocr">{s.text}</pre>
          ) : (
            <p className="task-vacio">no se leyó texto de esta captura</p>
          )}

          {s.driveLink !== null && (
            <button type="button" className="task-link" onClick={() => onAbrir(s.driveLink!)}>
              abrir la captura original ↗
            </button>
          )}
        </div>
      ))}

      {detalle.sources.length === 0 && (
        <p className="task-vacio">Esta nota no tenía capturas: el pendiente salió solo del texto.</p>
      )}
    </div>
  )
}

function Tarjeta({
  task,
  detalle,
  abierta,
  cargando,
  onToggle,
  onCerrar,
  onAbrir
}: {
  task: TaskRow
  detalle: TaskDetail | null
  abierta: boolean
  cargando: boolean
  onToggle: (id: string) => void
  onCerrar: (id: string, status: 'done' | 'dismissed') => void
  onAbrir: (url: string) => void
}): React.JSX.Element {
  return (
    <li className={`task-card ${abierta ? 'task-card-open' : ''}`}>
      <div className="task-row">
        {/* Toda la fila es el disparador; los botones cortan la propagación
            para que "hecho" no despliegue el detalle al mismo tiempo. */}
        <button
          type="button"
          className="task-body"
          aria-expanded={abierta}
          onClick={() => onToggle(task.id)}
        >
          <span className="task-title">{task.title}</span>
          {!abierta && task.detail !== null && task.detail.length > 0 && (
            <span className="task-detail">{task.detail}</span>
          )}
        </button>

        <div className="task-actions" onClick={(e) => e.stopPropagation()}>
          <Origen source={task.source} confidence={task.confidence} />
          <button type="button" className="task-btn" onClick={() => onCerrar(task.id, 'done')}>
            hecho
          </button>
          <button
            type="button"
            className="task-btn task-btn-ghost"
            onClick={() => onCerrar(task.id, 'dismissed')}
          >
            no va
          </button>
        </div>
      </div>

      {abierta && cargando && <p className="task-vacio task-expand">buscando el origen…</p>}
      {abierta && detalle !== null && <Detalle detalle={detalle} onAbrir={onAbrir} />}
    </li>
  )
}

export function ChatPanel({ onError }: Props): React.JSX.Element {
  const [turnos, setTurnos] = useState<Turno[]>([])
  const [texto, setTexto] = useState('')
  const [pensando, setPensando] = useState(false)
  const [abierta, setAbierta] = useState<string | null>(null)
  // Cacheado por id: volver a abrir la misma tarjeta no re-consulta la base.
  const [detalles, setDetalles] = useState<Record<string, TaskDetail>>({})
  const [cargandoDetalle, setCargandoDetalle] = useState<string | null>(null)
  const finRef = useRef<HTMLDivElement>(null)
  const siguienteId = useRef(0)

  const agregar = (de: Turno['de'], texto: string, tasks: TaskRow[] = []): void => {
    setTurnos((prev) => [...prev, { id: siguienteId.current++, de, texto, tasks }])
  }

  // Arranca mostrando los pendientes: si el chat abre vacío, no se entiende
  // para qué sirve ni que ya hay datos adentro.
  useEffect(() => {
    void window.api.listTasks().then((res) => {
      if (!res.ok) {
        onError(res.error.message)
        return
      }
      agregar(
        'albus',
        res.data.length === 0
          ? 'No te queda nada pendiente.'
          : `Tenés ${res.data.length} ${res.data.length === 1 ? 'cosa' : 'cosas'} pendientes:`,
        res.data
      )
    })
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turnos])

  const enviar = async (mensaje: string): Promise<void> => {
    const limpio = mensaje.trim()
    if (limpio.length === 0 || pensando) return

    agregar('vos', limpio)
    setTexto('')
    setPensando(true)

    try {
      const res = await window.api.askTasks(limpio)
      if (!res.ok) {
        onError(res.error.message)
        return
      }
      agregar('albus', res.data.text, res.data.tasks)
    } finally {
      setPensando(false)
    }
  }

  const toggle = async (id: string): Promise<void> => {
    if (abierta === id) {
      setAbierta(null)
      return
    }
    setAbierta(id)

    if (detalles[id] !== undefined) return

    setCargandoDetalle(id)
    try {
      const res = await window.api.taskDetail(id)
      if (!res.ok) {
        onError(res.error.message)
        return
      }
      setDetalles((prev) => ({ ...prev, [id]: res.data }))
    } finally {
      setCargandoDetalle(null)
    }
  }

  const abrirLink = (url: string): void => {
    void window.api.openExternal(url).then((res) => {
      if (!res.ok) onError(res.error.message)
    })
  }

  const cerrar = async (id: string, status: 'done' | 'dismissed'): Promise<void> => {
    const res = await window.api.closeTask(id, status)
    if (!res.ok) {
      onError(res.error.message)
      return
    }
    // Sacar la tarjeta de TODOS los turnos, no solo del último: si aparece
    // repetida más arriba en la conversación, dejarla ahí es mentirle al usuario.
    setTurnos((prev) => prev.map((t) => ({ ...t, tasks: t.tasks.filter((x) => x.id !== id) })))

    const quedan = res.data.length
    agregar(
      'albus',
      `${status === 'done' ? 'Tachado' : 'Descartado'}. ` +
        (quedan === 0 ? 'No te queda nada pendiente.' : `Te quedan ${quedan}.`)
    )
  }

  return (
    <div className="chat">
      <div className="chat-hilo">
        {turnos.map((t) => (
          <div key={t.id} className={`chat-turno chat-${t.de}`}>
            <p className="chat-texto">{t.texto}</p>
            {t.tasks.length > 0 && (
              <ul className="task-list">
                {t.tasks.map((task) => (
                  <Tarjeta
                    key={task.id}
                    task={task}
                    detalle={detalles[task.id] ?? null}
                    abierta={abierta === task.id}
                    cargando={cargandoDetalle === task.id}
                    onToggle={(id) => void toggle(id)}
                    onCerrar={cerrar}
                    onAbrir={abrirLink}
                  />
                ))}
              </ul>
            )}
          </div>
        ))}
        {pensando && (
          <div className="chat-turno chat-albus">
            <p className="chat-texto chat-pensando">…</p>
          </div>
        )}
        <div ref={finRef} />
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault()
          void enviar(texto)
        }}
      >
        <input
          type="text"
          value={texto}
          placeholder="¿qué tengo pendiente?"
          onChange={(e) => setTexto(e.target.value)}
          disabled={pensando}
        />
        <button type="submit" disabled={pensando || texto.trim().length === 0}>
          preguntar
        </button>
      </form>
    </div>
  )
}
