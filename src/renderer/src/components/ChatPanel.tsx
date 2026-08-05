import { useEffect, useRef, useState } from 'react'
import { esUrlAbrible, type TaskDetail, type TaskRow } from '../../../shared/ipc'
import { urlDeCalendario } from '../../../shared/google-calendar'

/**
 * Los emails y links ya vienen resueltos del main, y el OCR ya viene limpio.
 *
 * Antes este archivo tenía las regex y le pasaba el crudo a un `<pre>`. Dos
 * problemas: el renderer no debería parsear OCR — eso es dominio, y el dominio
 * vive en el main —, y el `<pre>` volcaba la barra de estado del celular del
 * usuario como si fuera contenido.
 */
const NOMBRE_FUENTE: Record<string, string> = {
  qr: 'código QR',
  receipt: 'comprobante',
  profile: 'perfil',
  document: 'documento',
  text: 'captura',
  none: 'sin contenido',
  failed: 'falló'
}

/** Arriba de esto, una nota sin resumen se muestra recortada con "ver todo". */
const LARGO_COMODO = 320

const RE_URL_EN_TEXTO = /https?:\/\/[^\s<>"')\]]+/g

/**
 * Cuánto de una URL se muestra.
 *
 * La nota real traía un link de LinkedIn de 300 caracteres — un wrapper
 * `/safety/go/?url=…` con el destino codificado y un hash gigante. Pintado entero
 * tapaba la nota; y aunque se pueda cortar por CSS, seis renglones de hash no le
 * dicen nada a nadie. El completo queda en el `title` del elemento.
 */
function recortarUrl(url: string): string {
  return url.length > 62 ? `${url.slice(0, 62)}…` : url
}

/**
 * El texto de una nota con sus URLs clickeables.
 *
 * Hasta ahora el body se pintaba como texto plano, así que un link había que
 * seleccionarlo y copiarlo a mano. Las URLs se detectan sobre el texto y solo se
 * vuelven botón las que el allowlist del main va a aceptar — el resto queda como
 * texto seleccionable, porque un botón que falla al clickearlo es peor que un
 * texto que se copia.
 */
function ConLinks({
  texto,
  onAbrir
}: {
  texto: string
  onAbrir: (url: string) => void
}): React.JSX.Element {
  const partes: React.ReactNode[] = []
  let cursor = 0

  for (const m of texto.matchAll(RE_URL_EN_TEXTO)) {
    const desde = m.index
    if (desde === undefined) continue

    if (desde > cursor) partes.push(texto.slice(cursor, desde))

    const url = m[0]
    partes.push(
      esUrlAbrible(url) ? (
        <button
          key={desde}
          type="button"
          className="task-link-inline"
          title={url}
          onClick={() => onAbrir(url)}
        >
          {recortarUrl(url)}
        </button>
      ) : (
        <span key={desde} className="task-url-plana" title={url}>
          {recortarUrl(url)}
        </span>
      )
    )

    cursor = desde + url.length
  }

  if (cursor < texto.length) partes.push(texto.slice(cursor))

  return <>{partes}</>
}

function plural(n: number, singular: string, plural_: string): string {
  return `${n} ${n === 1 ? singular : plural_}`
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

/**
 * Debajo de esto, el pendiente es una lectura del modelo más que de la nota.
 *
 * 0.8 y no otro número: en los datos reales las confianzas caen en 1.00 (reglas),
 * 0.95, 0.90, 0.80 y 0.70. El corte deja marcadas 4 de 20 — las tres vacantes de
 * LinkedIn, donde la nota decía solo "Trabajo", y el evento de cripto.
 */
const CONFIANZA_DUDOSA = 0.8

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
function Origen({ source, confidence }: { source: string; confidence: number }): React.JSX.Element | null {
  if (source.startsWith('regla')) return null
  if (confidence >= CONFIANZA_DUDOSA) return null

  return (
    <span
      className="task-src task-src-dudoso"
      title="La IA dedujo este pendiente de lo que guardaste, no de algo que escribiste. Revisalo."
    >
      deducido
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
function Nota({
  body,
  summary,
  onAbrir
}: {
  body: string
  summary: string | null
  onAbrir: (url: string) => void
}): React.JSX.Element {
  const [abierto, setAbierto] = useState(false)

  const resumida = summary !== null && summary.length < body.length
  const larga = body.length > LARGO_COMODO
  const hayMas = resumida || larga

  const visible = abierto || !hayMas ? body : resumida ? summary! : `${body.slice(0, LARGO_COMODO)}…`

  return (
    <div className="task-block">
      <span className="task-block-label">
        {resumida && !abierto ? 'lo que escribiste, en corto' : 'lo que escribiste'}
      </span>
      <p className="task-note">
        <ConLinks texto={visible} onAbrir={onAbrir} />
      </p>
      {hayMas && (
        <button type="button" className="task-toggle" onClick={() => setAbierto(!abierto)}>
          {abierto ? 'ver en corto ▴' : `ver la nota completa (${body.length} caracteres) ▾`}
        </button>
      )}
    </div>
  )
}

/** Un bloque por TIPO de captura, no por archivo. */
function Fuente({
  fuente,
  onAbrir
}: {
  fuente: TaskDetail['sources'][number]
  onAbrir: (url: string) => void
}): React.JSX.Element {
  const [verCrudo, setVerCrudo] = useState(false)

  return (
    <div className="task-block">
      {/* Sin `drive/<carpeta>`: en qué carpeta de Drive quedó el archivo es
          contabilidad de almacenamiento, no algo que el usuario esté leyendo. */}
      <span className="task-block-label">
        {NOMBRE_FUENTE[fuente.kind] ?? fuente.kind}
        {fuente.captures > 1 && ` · ${plural(fuente.captures, 'captura', 'capturas')}`}
      </span>

      {fuente.text !== null ? (
        <pre className="task-ocr">{fuente.text}</pre>
      ) : (
        <p className="task-vacio">
          {fuente.kind === 'qr'
            ? 'El código no se puede mostrar: está cifrado.'
            : 'El texto de esta captura no se pudo leer. Abrí la imagen original.'}
        </p>
      )}

      <div className="task-links">
        {fuente.driveLinks.map((link, i) => (
          <button key={link} type="button" className="task-link" onClick={() => onAbrir(link)}>
            {fuente.driveLinks.length > 1 ? `abrir la captura ${i + 1} ↗` : 'abrir la original ↗'}
          </button>
        ))}
      </div>

      {/* El crudo queda accesible pero no encima: un heurístico que decide qué es
          basura tiene que poder auditarse, y el usuario tiene que poder
          desconfiar de él. */}
      {fuente.rawText !== null && fuente.rawText !== fuente.text && (
        <>
          <button type="button" className="task-toggle" onClick={() => setVerCrudo(!verCrudo)}>
            {verCrudo ? 'ocultar el texto crudo ▴' : 'ver el texto crudo del OCR ▾'}
          </button>
          {verCrudo && <pre className="task-ocr task-ocr-crudo">{fuente.rawText}</pre>}
        </>
      )}
    </div>
  )
}

function Detalle({
  detalle,
  onAbrir
}: {
  detalle: TaskDetail
  onAbrir: (url: string) => void
}): React.JSX.Element {
  const { emails, urls } = detalle.contacts

  return (
    <div className="task-expand">
      {detalle.noteBody.length > 0 && (
        <Nota body={detalle.noteBody} summary={detalle.noteSummary} onAbrir={onAbrir} />
      )}

      {(emails.length > 0 || urls.length > 0) && (
        <div className="task-block">
          {/* No dice "cómo contactar": el main ya sacó el email del propio dueño,
              pero entre lo que queda puede haber cualquier dirección que apareció
              en una captura. Nombrar las cosas por lo que son. */}
          <span className="task-block-label">emails y links en las capturas</span>
          <div className="task-links">
            {emails.map((e) => (
              <span key={e} className="task-contact">
                {e}
              </span>
            ))}
            {urls.map((u) =>
              // Un botón que el allowlist del main va a rechazar es una promesa
              // que la app no puede cumplir. Si no se puede abrir, es texto.
              esUrlAbrible(u) ? (
                <button key={u} type="button" className="task-link" onClick={() => onAbrir(u)}>
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

      {detalle.sources.map((s) => (
        <Fuente key={s.kind} fuente={s} onAbrir={onAbrir} />
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

          {/* Antes de "hecho" y "no va" a propósito: agendar es construir algo con
              el pendiente, cerrarlo es terminarlo. Las acciones terminales quedan
              últimas y en el lugar donde el usuario ya las tiene aprendidas. */}
          <button
            type="button"
            className="task-btn task-btn-ghost"
            title="Abre Google Calendar con el evento precargado. Vos apretás Guardar."
            onClick={() =>
              onAbrir(
                urlDeCalendario({
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
