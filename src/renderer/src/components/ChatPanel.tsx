import { useEffect, useRef, useState } from 'react'
import { isOpenableUrl, type TaskDetail, type TaskRow } from '../../../shared/ipc'
import { calendarUrl } from '../../../shared/google-calendar'

/**
 * Los emails y links ya vienen resueltos del main, y el OCR ya viene limpio.
 *
 * Antes este archivo tenía las regex y le pasaba el crudo a un `<pre>`. Dos
 * problemas: el renderer no debería parsear OCR — eso es dominio, y el dominio
 * vive en el main —, y el `<pre>` volcaba la barra de estado del celular del
 * usuario como si fuera contenido.
 */
const SOURCE_NAME: Record<string, string> = {
  qr: 'QR code',
  receipt: 'receipt',
  profile: 'profile',
  document: 'document',
  text: 'screenshot',
  none: 'no content',
  failed: 'failed'
}

/** Arriba de esto, una nota sin resumen se muestra recortada con "ver todo". */
const COMFORTABLE_LENGTH = 320

const RE_URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/g

/**
 * Cuánto de una URL se muestra.
 *
 * La nota real traía un link de LinkedIn de 300 caracteres — un wrapper
 * `/safety/go/?url=…` con el destino codificado y un hash gigante. Pintado entero
 * tapaba la nota; y aunque se pueda cortar por CSS, seis renglones de hash no le
 * dicen nada a nadie. El completo queda en el `title` del elemento.
 */
function truncateUrl(url: string): string {
  return url.length > 62 ? `${url.slice(0, 62)}…` : url
}

/**
 * Una URL dentro del texto de una nota, con su botón de copiar.
 *
 * El botón de copiar va en TODAS, incluso en las que no se pueden abrir — es el
 * caso que lo motivó: "los links de LinkedIn se rompen". Cuando el destino falla,
 * tener el link en el portapapeles es lo único que queda para rescatarlo.
 *
 * Se copia la URL COMPLETA, no la recortada que se muestra. El recorte es para
 * que el párrafo se pueda leer; un link cortado a 62 caracteres no sirve para nada.
 */
function NoteLink({ url, onOpen }: { url: string; onOpen: (u: string) => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sin esto, copiar y cerrar la tarjeta antes de que pase el segundo y medio
  // deja un setState corriendo sobre un componente desmontado.
  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])

  const copy = (): void => {
    void window.api.copyToClipboard(url).then((res) => {
      // No hay banner de error: el "copiado" ES la confirmación. Si no aparece,
      // no se copió, y eso el usuario lo ve sin que nadie se lo explique.
      if (!res.ok) return
      setCopied(true)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <span className="task-url">
      {isOpenableUrl(url) ? (
        <button type="button" className="task-link-inline" title={url} onClick={() => onOpen(url)}>
          {truncateUrl(url)}
        </button>
      ) : (
        <span className="task-url-plana" title={url}>
          {truncateUrl(url)}
        </span>
      )}

      <button
        type="button"
        className="task-copiar"
        title="Copy the full link"
        onClick={copy}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  )
}

/**
 * El texto de una nota con sus URLs clickeables.
 *
 * Hasta ahora el body se pintaba como texto plano, así que un link había que
 * seleccionarlo y copiarlo a mano. Solo se vuelven botón las que el allowlist del
 * main va a aceptar — el resto queda como texto, porque un botón que falla al
 * clickearlo es peor que un texto que se copia.
 */
function WithLinks({
  text,
  onOpen
}: {
  text: string
  onOpen: (url: string) => void
}): React.JSX.Element {
  const parts: React.ReactNode[] = []
  let cursor = 0

  for (const m of text.matchAll(RE_URL_IN_TEXT)) {
    const start = m.index
    if (start === undefined) continue

    if (start > cursor) parts.push(text.slice(cursor, start))
    parts.push(<NoteLink key={start} url={m[0]} onOpen={onOpen} />)
    cursor = start + m[0].length
  }

  if (cursor < text.length) parts.push(text.slice(cursor))

  return <>{parts}</>
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** `from` alimenta la clase CSS `chat-vos` / `chat-albus`: los valores no cambian. */
interface Turn {
  id: number
  from: 'vos' | 'albus'
  text: string
  tasks: TaskRow[]
}

interface Props {
  onError: (message: string) => void
}

/**
 * Debajo de esto, el pendiente es una lectura del modelo más que de la nota.
 *
 * 0.8 y no otro número: en los datos reales las confianzas caen en 1.00 (reglas),
 * 0.95, 0.90, 0.80 y 0.70. El corte deja marcadas 4 de 20 — las tres vacantes de
 * LinkedIn, donde la nota decía solo "Trabajo", y el evento de cripto.
 */
const DOUBTFUL_CONFIDENCE = 0.8

/**
 * Marca SOLO los pendientes dudosos.
 *
 * Antes mostraba `ia · 100%` en cada tarjeta. Ese porcentaje es la confianza que
 * el modelo declara de sí mismo, y el usuario preguntó literalmente qué era —
 * con razón: sobre 20 pendientes había 5 valores distintos y ninguno predecía
 * nada que a él le sirviera. Era información de debug en una pantalla de lectura.
 *
 * Lo que sí importa es saber cuándo un pendiente es una DEDUCCIÓN que puede estar
 * equivocada. Eso se marca donde hay duda, y en ningún otro lado: un indicador
 * que aparece en las 20 tarjetas no distingue nada.
 */
function OriginBadge({
  source,
  confidence
}: {
  source: string
  confidence: number
}): React.JSX.Element | null {
  // `source` is a value the main produces, not copy. It stays in Spanish and so
  // does this comparison — translating one side breaks the badge in silence.
  if (source.startsWith('regla')) return null
  if (confidence >= DOUBTFUL_CONFIDENCE) return null

  return (
    <span
      className="task-src task-src-dudoso"
      title="The AI inferred this from what you saved, not from something you wrote. Check it."
    >
      inferred
    </span>
  )
}

/**
 * Lo que escribiste, empezando por el resumen.
 *
 * Una nota de 2838 caracteres dictada por voz, sin un solo punto, no se relee.
 * Se muestra el resumen y el original queda a un click — disponible, no encima.
 * Sin resumen (nota vieja, o modelo que no lo devolvió) se recorta y se ofrece
 * el mismo botón: nunca se esconde lo que el usuario escribió.
 */
function Note({
  body,
  summary,
  onOpen
}: {
  body: string
  summary: string | null
  onOpen: (url: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  const summarized = summary !== null && summary.length < body.length
  const long = body.length > COMFORTABLE_LENGTH
  const hasMore = summarized || long

  const visible =
    open || !hasMore ? body : summarized ? summary! : `${body.slice(0, COMFORTABLE_LENGTH)}…`

  return (
    <div className="task-block">
      <span className="task-block-label">
        {summarized && !open ? 'what you wrote, in short' : 'what you wrote'}
      </span>
      <p className="task-note">
        <WithLinks text={visible} onOpen={onOpen} />
      </p>
      {hasMore && (
        <button type="button" className="task-toggle" onClick={() => setOpen(!open)}>
          {open ? 'show the short version ▴' : `show the full note (${body.length} characters) ▾`}
        </button>
      )}
    </div>
  )
}

/** Un bloque por TIPO de captura, no por archivo. */
function SourceBlock({
  source,
  onOpen
}: {
  source: TaskDetail['sources'][number]
  onOpen: (url: string) => void
}): React.JSX.Element {
  const [showRaw, setShowRaw] = useState(false)

  return (
    <div className="task-block">
      {/* Sin `drive/<carpeta>`: en qué carpeta de Drive quedó el archivo es
          contabilidad de almacenamiento, no algo que el usuario esté leyendo. */}
      {/* Decir "11 capturas" cuando son fotos era mentir sobre lo que hay. */}
      <span className="task-block-label">
        {SOURCE_NAME[source.kind] ?? source.kind}
        {source.captures > 1 &&
          (source.photos === source.captures
            ? ` · ${plural(source.captures, 'photo', 'photos')}`
            : source.photos > 0
              ? ` · ${source.captures} files (${source.photos} photos)`
              : ` · ${plural(source.captures, 'screenshot', 'screenshots')}`)}
      </span>

      {source.text !== null ? (
        <pre className="task-ocr">{source.text}</pre>
      ) : (
        <p className="task-vacio">
          {source.kind === 'qr'
            ? 'The code cannot be shown: it is encrypted.'
            : source.photos > 0
              ? // Name the cause instead of saying "could not": a photo of a sign
                // is not a failed OCR, it is an OCR that does not apply.
                `${plural(source.photos, 'this is a photo', 'these are photos')}, not screenshots. ` +
                'OCR on a photo is not reliable, so we do not show it. Open them to see what is there.'
              : 'The text in this capture could not be read. Open the original image.'}
        </p>
      )}

      {/* Once links apilados que decían "abrir la captura N ↗" eran once
          renglones para once destinos indistinguibles. Con más de dos se pasan a
          una fila numerada: mismo acceso, un renglón. No se recorta la lista —
          esconder archivos que el usuario guardó no es una simplificación. */}
      {source.driveLinks.length > 2 ? (
        <div className="task-links-fila">
          <span className="task-vacio">
            {plural(source.driveLinks.length, 'file', 'files')} in Drive:
          </span>
          {source.driveLinks.map((link, i) => (
            <button
              key={link}
              type="button"
              className="task-link-num"
              title="Open in Drive"
              onClick={() => onOpen(link)}
            >
              {i + 1}
            </button>
          ))}
        </div>
      ) : (
        <div className="task-links">
          {source.driveLinks.map((link, i) => (
            <button key={link} type="button" className="task-link" onClick={() => onOpen(link)}>
              {source.driveLinks.length > 1 ? `open capture ${i + 1} ↗` : 'open the original ↗'}
            </button>
          ))}
        </div>
      )}

      {/* El crudo queda accesible pero no encima: un heurístico que decide qué es
          basura tiene que poder auditarse, y el usuario tiene que poder
          desconfiar de él. */}
      {source.rawText !== null && source.rawText !== source.text && (
        <>
          <button type="button" className="task-toggle" onClick={() => setShowRaw(!showRaw)}>
            {showRaw ? 'hide the raw text ▴' : 'show the raw OCR text ▾'}
          </button>
          {showRaw && <pre className="task-ocr task-ocr-crudo">{source.rawText}</pre>}
        </>
      )}
    </div>
  )
}

function Detail({
  detail,
  onOpen
}: {
  detail: TaskDetail
  onOpen: (url: string) => void
}): React.JSX.Element {
  const { emails, urls } = detail.contacts

  return (
    <div className="task-expand">
      {detail.noteBody.length > 0 && (
        <Note body={detail.noteBody} summary={detail.noteSummary} onOpen={onOpen} />
      )}

      {(emails.length > 0 || urls.length > 0) && (
        <div className="task-block">
          {/* No dice "cómo contactar": el main ya sacó el email del propio dueño,
              pero entre lo que queda puede haber cualquier dirección que apareció
              en una captura. Nombrar las cosas por lo que son. */}
          <span className="task-block-label">emails and links in the captures</span>
          <div className="task-links">
            {emails.map((e) => (
              <span key={e} className="task-contact">
                {e}
              </span>
            ))}
            {urls.map((u) =>
              // Un botón que el allowlist del main va a rechazar es una promesa
              // que la app no puede cumplir. Si no se puede abrir, es texto.
              isOpenableUrl(u) ? (
                <button key={u} type="button" className="task-link" onClick={() => onOpen(u)}>
                  {u.length > 54 ? `${u.slice(0, 54)}…` : u}
                </button>
              ) : (
                <span key={u} className="task-contact">
                  {u.length > 54 ? `${u.slice(0, 54)}…` : u}
                </span>
              )
            )}
          </div>
        </div>
      )}

      {detail.sources.map((s) => (
        <SourceBlock key={s.kind} source={s} onOpen={onOpen} />
      ))}

      {detail.sources.length === 0 && (
        <p className="task-vacio">This note had no captures: the task came from the text alone.</p>
      )}
    </div>
  )
}

function Card({
  task,
  detail,
  open,
  loading,
  onToggle,
  onClose,
  onOpen
}: {
  task: TaskRow
  detail: TaskDetail | null
  open: boolean
  loading: boolean
  onToggle: (id: string) => void
  onClose: (id: string, status: 'done' | 'dismissed') => void
  onOpen: (url: string) => void
}): React.JSX.Element {
  return (
    <li className={`task-card ${open ? 'task-card-open' : ''}`}>
      <div className="task-row">
        {/* Toda la fila es el disparador; los botones cortan la propagación
            para que "hecho" no despliegue el detalle al mismo tiempo. */}
        <button
          type="button"
          className="task-body"
          aria-expanded={open}
          onClick={() => onToggle(task.id)}
        >
          <span className="task-title">{task.title}</span>
          {!open && task.detail !== null && task.detail.length > 0 && (
            <span className="task-detail">{task.detail}</span>
          )}
        </button>

        <div className="task-actions" onClick={(e) => e.stopPropagation()}>
          <OriginBadge source={task.source} confidence={task.confidence} />

          {/* Antes de "hecho" y "no va" a propósito: agendar es construir algo con
              el pendiente, cerrarlo es terminarlo. Las acciones terminales quedan
              últimas y en el lugar donde el usuario ya las tiene aprendidas. */}
          <button
            type="button"
            className="task-btn task-btn-ghost"
            title="Opens Google Calendar with the event prefilled. You hit Save."
            onClick={() =>
              onOpen(
                calendarUrl({
                  title: task.title,
                  details: task.detail,
                  // Cuando el pendiente tiene fecha, va precargada como evento de
                  // día completo. Es el único lugar donde `dueDate` se usa.
                  date: task.dueDate
                })
              )
            }
          >
            + calendar
          </button>

          <button type="button" className="task-btn" onClick={() => onClose(task.id, 'done')}>
            done
          </button>
          <button
            type="button"
            className="task-btn task-btn-ghost"
            onClick={() => onClose(task.id, 'dismissed')}
          >
            drop it
          </button>
        </div>
      </div>

      {open && loading && <p className="task-vacio task-expand">looking for the source…</p>}
      {open && detail !== null && <Detail detail={detail} onOpen={onOpen} />}
    </li>
  )
}

export function ChatPanel({ onError }: Props): React.JSX.Element {
  const [turns, setTurns] = useState<Turn[]>([])
  const [text, setText] = useState('')
  const [thinking, setThinking] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  // Cacheado por id: volver a abrir la misma tarjeta no re-consulta la base.
  const [details, setDetails] = useState<Record<string, TaskDetail>>({})
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const nextId = useRef(0)

  const add = (from: Turn['from'], text: string, tasks: TaskRow[] = []): void => {
    setTurns((prev) => [...prev, { id: nextId.current++, from, text, tasks }])
  }

  // Arranca mostrando los pendientes: si el chat abre vacío, no se entiende
  // para qué sirve ni que ya hay datos adentro.
  useEffect(() => {
    void window.api.listTasks().then((res) => {
      if (!res.ok) {
        onError(res.error.message)
        return
      }
      add(
        'albus',
        res.data.length === 0
          ? 'Nothing pending.'
          : `You have ${res.data.length} ${res.data.length === 1 ? 'thing' : 'things'} pending:`,
        res.data
      )
    })
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turns])

  const send = async (message: string): Promise<void> => {
    const clean = message.trim()
    if (clean.length === 0 || thinking) return

    add('vos', clean)
    setText('')
    setThinking(true)

    try {
      const res = await window.api.askTasks(clean)
      if (!res.ok) {
        onError(res.error.message)
        return
      }
      add('albus', res.data.text, res.data.tasks)
    } finally {
      setThinking(false)
    }
  }

  const toggle = async (id: string): Promise<void> => {
    if (openId === id) {
      setOpenId(null)
      return
    }
    setOpenId(id)

    if (details[id] !== undefined) return

    setLoadingDetail(id)
    try {
      const res = await window.api.taskDetail(id)
      if (!res.ok) {
        onError(res.error.message)
        return
      }
      setDetails((prev) => ({ ...prev, [id]: res.data }))
    } finally {
      setLoadingDetail(null)
    }
  }

  const openLink = (url: string): void => {
    void window.api.openExternal(url).then((res) => {
      if (!res.ok) onError(res.error.message)
    })
  }

  const close = async (id: string, status: 'done' | 'dismissed'): Promise<void> => {
    const res = await window.api.closeTask(id, status)
    if (!res.ok) {
      onError(res.error.message)
      return
    }
    // Sacar la tarjeta de TODOS los turnos, no solo del último: si aparece
    // repetida más arriba en la conversación, dejarla ahí es mentirle al usuario.
    setTurns((prev) => prev.map((t) => ({ ...t, tasks: t.tasks.filter((x) => x.id !== id) })))

    const left = res.data.length
    add(
      'albus',
      `${status === 'done' ? 'Crossed off' : 'Dropped'}. ` +
        (left === 0 ? 'Nothing pending.' : `${left} left.`)
    )
  }

  return (
    <div className="chat">
      <div className="chat-hilo">
        {turns.map((t) => (
          <div key={t.id} className={`chat-turno chat-${t.from}`}>
            <p className="chat-texto">{t.text}</p>
            {t.tasks.length > 0 && (
              <ul className="task-list">
                {t.tasks.map((task) => (
                  <Card
                    key={task.id}
                    task={task}
                    detail={details[task.id] ?? null}
                    open={openId === task.id}
                    loading={loadingDetail === task.id}
                    onToggle={(id) => void toggle(id)}
                    onClose={close}
                    onOpen={openLink}
                  />
                ))}
              </ul>
            )}
          </div>
        ))}
        {thinking && (
          <div className="chat-turno chat-albus">
            <p className="chat-texto chat-pensando">…</p>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault()
          void send(text)
        }}
      >
        <input
          type="text"
          value={text}
          placeholder="what do I have pending?"
          onChange={(e) => setText(e.target.value)}
          disabled={thinking}
        />
        <button type="submit" disabled={thinking || text.trim().length === 0}>
          ask
        </button>
      </form>
    </div>
  )
}
