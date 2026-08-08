import { useCallback, useEffect, useState } from 'react'
import type { AgentInfo, CliProviderInfo } from '../../../shared/ipc'
import { JobChat } from './JobChat'

/**
 * El contenedor de agentes.
 *
 * Albus no es una app de una sola cosa: es donde viven los agentes del
 * usuario. Hoy hay uno; mañana el de gastos, el de contenido para LinkedIn, el
 * que sea. Por eso esto lee una LISTA del main y busca su componente en un
 * mapa — sumar el próximo es una entrada en `registry.ts` y una acá, sin tocar
 * este archivo ni la navegación.
 *
 * Un agente al que le falta una credencial se pinta igual, apagado y con el
 * motivo. Esconderlo haría que el usuario crea que nunca existió.
 */

/** id del registro → el componente que lo dibuja. */
const PANELES: Record<string, (props: PanelProps) => React.JSX.Element> = {
  // Chat y no formulario: el agente se maneja hablándole. Ver `JobChat.tsx`.
  'job-search': (p) => (
    <JobChat providerId={p.providerId} modelId={p.modelId} onError={p.onError} />
  )
}

export interface PanelProps {
  providerId: string | null
  modelId: string | null
  onError: (mensaje: string | null) => void
}

interface Props extends PanelProps {
  providers: CliProviderInfo[]
}

export function AgentsPanel({ providerId, modelId, onError, providers }: Props): React.JSX.Element {
  const [agentes, setAgentes] = useState<AgentInfo[]>([])
  const [activo, setActivo] = useState<string | null>(null)
  const [cargando, setCargando] = useState(true)
  /** Lo que el usuario está escribiendo, por pregunta. */
  const [borradores, setBorradores] = useState<Record<string, string>>({})
  const [respondiendo, setRespondiendo] = useState<string | null>(null)

  const cargar = useCallback((): void => {
    void window.api.listAgents().then((res) => {
      setCargando(false)
      if (!res.ok) {
        onError(res.error.message)
        return
      }
      setAgentes(res.data)
      // Con un solo agente no tiene sentido hacerlo elegir.
      if (res.data.length === 1) setActivo(res.data[0].id)
    })
  }, [onError])

  useEffect(cargar, [cargar])

  /**
   * Abre el `.md` y RECARGA al volver el foco a la ventana.
   *
   * El usuario edita el archivo afuera, en su editor. Sin recargar, vuelve a
   * la app y sigue viendo "todavía no apunta a ningún lado" sobre un archivo
   * que acaba de completar — y concluye que no funcionó.
   */
  /**
   * Responder escribe una regla, así que la lista se recarga con lo que
   * devuelve el main —no con lo que la UI supone—: la pregunta desaparece y la
   * regla nueva aparece abajo en el mismo instante.
   */
  const responder = async (agenteId: string, preguntaId: string, texto: string): Promise<void> => {
    const limpio = texto.trim()
    if (limpio === '') return

    onError(null)
    setRespondiendo(preguntaId)
    try {
      const res = await window.api.answerAgentQuestion(agenteId, preguntaId, limpio)
      if (res.ok) {
        setAgentes(res.data.agentes)
        setBorradores((p) => ({ ...p, [preguntaId]: '' }))
      } else {
        onError(res.error.message)
      }
    } finally {
      setRespondiendo(null)
    }
  }

  const abrirReglas = async (id: string): Promise<void> => {
    onError(null)
    const res = await window.api.openAgentRules(id)
    if (!res.ok) {
      onError(res.error.message)
      return
    }

    const alVolver = (): void => {
      cargar()
      window.removeEventListener('focus', alVolver)
    }
    window.addEventListener('focus', alVolver)
  }

  if (cargando) {
    return <div className="idle-state"><span className="idle-text">buscando agentes…</span></div>
  }

  if (agentes.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-title">no hay agentes registrados</div>
        <div className="empty-subtitle">se agregan en src/main/agents/registry.ts</div>
      </div>
    )
  }

  const seleccionado = agentes.find((a) => a.id === activo) ?? null
  const Panel = seleccionado !== null ? PANELES[seleccionado.id] : undefined

  return (
    <div className="agentes">
      <div className="agente-grid">
        {agentes.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`agente-card ${activo === a.id ? 'agente-card-on' : ''} ${
              a.disponible ? '' : 'agente-card-off'
            }`}
            onClick={() => setActivo(activo === a.id ? null : a.id)}
          >
            <span className="agente-nombre">{a.nombre}</span>
            <span className="agente-desc">{a.descripcion}</span>
            {a.motivo !== '' && <span className="agente-motivo">{a.motivo}</span>}
          </button>
        ))}
      </div>

      {/*
        Las reglas del agente seleccionado.

        Van acá arriba y no escondidas en un menú: son lo que hace que el
        agente mire TU base y no una constante. Un agente sin reglas escritas
        funciona a medias y el usuario tiene que poder verlo de un vistazo.
      */}
      {/*
        Lo que el agente preguntó. Va ARRIBA de las reglas y no escondido:
        es trabajo esperando al usuario, y cada respuesta se vuelve una regla
        —así que contestar una vez ahorra que vuelva a preguntar para siempre.
      */}
      {seleccionado !== null && seleccionado.reglas.preguntas.length > 0 && (
        <section className="preguntas">
          <header className="preguntas-head">
            <h3 className="preguntas-titulo">
              El agente te preguntó
              <span className="preguntas-cuantas">{seleccionado.reglas.preguntas.length}</span>
            </h3>
            <p className="preguntas-sub">
              tu respuesta queda escrita en las reglas — no vuelve a preguntar
            </p>
          </header>

          {seleccionado.reglas.preguntas.map((q) => (
            <article key={q.id} className="pregunta">
              <p className="pregunta-texto">{q.pregunta}</p>
              {q.contexto !== '' && <p className="pregunta-contexto">{q.contexto}</p>}

              {/* Las sugerencias son atajos, no un select: siempre se puede escribir otra cosa. */}
              {q.opciones.length > 0 && (
                <div className="pregunta-opciones">
                  {q.opciones.map((o) => (
                    <button
                      key={o}
                      type="button"
                      className="pregunta-opcion"
                      disabled={respondiendo === q.id}
                      onClick={() => void responder(seleccionado.id, q.id, o)}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              )}

              <div className="pregunta-responder">
                <input
                  className="pregunta-input"
                  placeholder="escribí tu respuesta…"
                  value={borradores[q.id] ?? ''}
                  disabled={respondiendo === q.id}
                  onChange={(e) => setBorradores((p) => ({ ...p, [q.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (borradores[q.id] ?? '').trim() !== '') {
                      void responder(seleccionado.id, q.id, borradores[q.id])
                    }
                  }}
                />
                <button
                  type="button"
                  className="reglas-editar"
                  disabled={respondiendo === q.id || (borradores[q.id] ?? '').trim() === ''}
                  onClick={() => void responder(seleccionado.id, q.id, borradores[q.id] ?? '')}
                >
                  {respondiendo === q.id ? 'guardando…' : 'responder'}
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      {seleccionado !== null && seleccionado.reglas.soporta && (
        <section className="reglas">
          <header className="reglas-head">
            <div>
              <h3 className="reglas-titulo">Tus reglas</h3>
              <p className="reglas-sub">
                lo que escribas acá lo respeta el agente, aunque nadie lo haya programado
              </p>
            </div>
            <button
              type="button"
              className="reglas-editar"
              onClick={() => void abrirReglas(seleccionado.id)}
            >
              {seleccionado.reglas.existe ? 'editar' : 'escribir las primeras'}
            </button>
          </header>

          {seleccionado.reglas.resumen.length === 0 ? (
            /*
              Vacío con EJEMPLOS, no con una instrucción.
              "Pegá el link de tu base de Notion" hacía creer que las reglas son
              para conectar servicios. Son para decirle qué hacer.
            */
            <div className="reglas-vacio">
              <p>Todavía no le dijiste nada. Podés escribir cosas como:</p>
              <ul>
                <li>cuando me postule a una empresa, guardá el CV en esta carpeta de Drive: …</li>
                <li>nada con Java ni con turnos de noche</li>
                <li>registrá las postulaciones en esta base: …</li>
                <li>si el sueldo no está publicado, igual postulate</li>
              </ul>
            </div>
          ) : (
            <ul className="reglas-lista">
              {seleccionado.reglas.resumen.map((linea, i) => (
                <li key={i}>{linea}</li>
              ))}
            </ul>
          )}

          {/* A dónde llega, como pie: es consecuencia de las reglas, no el tema. */}
          {(seleccionado.reglas.notion.length > 0 || seleccionado.reglas.drive.length > 0) && (
            <footer className="reglas-pie">
              {seleccionado.reglas.notion.length > 0 && (
                <span>
                  escribe en <strong>{seleccionado.reglas.notion[0].etiqueta || 'Notion'}</strong>
                </span>
              )}
              {seleccionado.reglas.drive.length > 0 && (
                <span>
                  archiva en <strong>{seleccionado.reglas.drive[0].etiqueta || 'Drive'}</strong>
                </span>
              )}
            </footer>
          )}
        </section>
      )}

      {seleccionado !== null && Panel !== undefined ? (
        <div className="agente-panel">
          <Panel providerId={providerId} modelId={modelId} onError={onError} />
        </div>
      ) : seleccionado !== null ? (
        <div className="empty-state">
          <div className="empty-title">{seleccionado.nombre} no tiene pantalla todavía</div>
          <div className="empty-subtitle">está en el registro pero le falta el componente</div>
        </div>
      ) : null}

      {providers.length === 0 && (
        <p className="cli-hint">
          no hay ningún CLI detectado — el triage necesita uno para puntuar las vacantes
        </p>
      )}
    </div>
  )
}
