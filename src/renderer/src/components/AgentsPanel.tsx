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
const PANELS: Record<string, (props: PanelProps) => React.JSX.Element> = {
  // Chat y no formulario: el agente se maneja hablándole. Ver `JobChat.tsx`.
  'job-search': (p) => (
    <JobChat providerId={p.providerId} modelId={p.modelId} onError={p.onError} />
  )
}

export interface PanelProps {
  providerId: string | null
  modelId: string | null
  onError: (message: string | null) => void
}

interface Props extends PanelProps {
  providers: CliProviderInfo[]
}

export function AgentsPanel({ providerId, modelId, onError, providers }: Props): React.JSX.Element {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /** Lo que el usuario está escribiendo, por pregunta. */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [answering, setAnswering] = useState<string | null>(null)

  const load = useCallback((): void => {
    void window.api.listAgents().then((res) => {
      setLoading(false)
      if (!res.ok) {
        onError(res.error.message)
        return
      }
      setAgents(res.data)
      // Con un solo agente no tiene sentido hacerlo elegir.
      if (res.data.length === 1) setActive(res.data[0].id)
    })
  }, [onError])

  useEffect(load, [load])

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
  const answer = async (agentId: string, questionId: string, text: string): Promise<void> => {
    const clean = text.trim()
    if (clean === '') return

    onError(null)
    setAnswering(questionId)
    try {
      const res = await window.api.answerAgentQuestion(agentId, questionId, clean)
      if (res.ok) {
        setAgents(res.data.agents)
        setDrafts((p) => ({ ...p, [questionId]: '' }))
      } else {
        onError(res.error.message)
      }
    } finally {
      setAnswering(null)
    }
  }

  const openRules = async (id: string): Promise<void> => {
    onError(null)
    const res = await window.api.openAgentRules(id)
    if (!res.ok) {
      onError(res.error.message)
      return
    }

    const onFocusBack = (): void => {
      load()
      window.removeEventListener('focus', onFocusBack)
    }
    window.addEventListener('focus', onFocusBack)
  }

  if (loading) {
    return <div className="idle-state"><span className="idle-text">looking for agents…</span></div>
  }

  if (agents.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-title">no agents registered</div>
        <div className="empty-subtitle">they are added in src/main/agents/registry.ts</div>
      </div>
    )
  }

  const selected = agents.find((a) => a.id === active) ?? null
  const Panel = selected !== null ? PANELS[selected.id] : undefined

  return (
    <div className="agentes">
      <div className="agente-grid">
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`agente-card ${active === a.id ? 'agente-card-on' : ''} ${
              a.available ? '' : 'agente-card-off'
            }`}
            onClick={() => setActive(active === a.id ? null : a.id)}
          >
            <span className="agente-nombre">{a.name}</span>
            <span className="agente-desc">{a.description}</span>
            {a.reason !== '' && <span className="agente-motivo">{a.reason}</span>}
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
      {selected !== null && selected.rules.questions.length > 0 && (
        <section className="preguntas">
          <header className="preguntas-head">
            <h3 className="preguntas-titulo">
              The agent asked you
              <span className="preguntas-cuantas">{selected.rules.questions.length}</span>
            </h3>
            <p className="preguntas-sub">
              your answer is written into the rules — it will not ask again
            </p>
          </header>

          {selected.rules.questions.map((q) => (
            <article key={q.id} className="pregunta">
              <p className="pregunta-texto">{q.question}</p>
              {q.context !== '' && <p className="pregunta-contexto">{q.context}</p>}

              {/* Las sugerencias son atajos, no un select: siempre se puede escribir otra cosa. */}
              {q.options.length > 0 && (
                <div className="pregunta-opciones">
                  {q.options.map((o) => (
                    <button
                      key={o}
                      type="button"
                      className="pregunta-opcion"
                      disabled={answering === q.id}
                      onClick={() => void answer(selected.id, q.id, o)}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              )}

              <div className="pregunta-responder">
                <input
                  className="pregunta-input"
                  placeholder="type your answer…"
                  value={drafts[q.id] ?? ''}
                  disabled={answering === q.id}
                  onChange={(e) => setDrafts((p) => ({ ...p, [q.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (drafts[q.id] ?? '').trim() !== '') {
                      void answer(selected.id, q.id, drafts[q.id])
                    }
                  }}
                />
                <button
                  type="button"
                  className="reglas-editar"
                  disabled={answering === q.id || (drafts[q.id] ?? '').trim() === ''}
                  onClick={() => void answer(selected.id, q.id, drafts[q.id] ?? '')}
                >
                  {answering === q.id ? 'saving…' : 'answer'}
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      {selected !== null && selected.rules.supported && (
        <section className="reglas">
          <header className="reglas-head">
            <div>
              <h3 className="reglas-titulo">Your rules</h3>
              <p className="reglas-sub">
                whatever you write here the agent respects, even if nobody programmed it
              </p>
            </div>
            <button
              type="button"
              className="reglas-editar"
              onClick={() => void openRules(selected.id)}
            >
              {selected.rules.exists ? 'edit' : 'write the first ones'}
            </button>
          </header>

          {selected.rules.summary.length === 0 ? (
            /*
              Vacío con EJEMPLOS, no con una instrucción.
              "Pegá el link de tu base de Notion" hacía creer que las reglas son
              para conectar servicios. Son para decirle qué hacer.
            */
            <div className="reglas-vacio">
              <p>You have not told it anything yet. You can write things like:</p>
              <ul>
                <li>when I apply to a company, save the CV in this Drive folder: …</li>
                <li>nothing with Java and no night shifts</li>
                <li>log applications in this database: …</li>
                <li>if the salary is not posted, apply anyway</li>
              </ul>
            </div>
          ) : (
            <ul className="reglas-lista">
              {selected.rules.summary.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}

          {/* A dónde llega, como pie: es consecuencia de las reglas, no el tema. */}
          {(selected.rules.notion.length > 0 || selected.rules.drive.length > 0) && (
            <footer className="reglas-pie">
              {selected.rules.notion.length > 0 && (
                <span>
                  writes to <strong>{selected.rules.notion[0].label || 'Notion'}</strong>
                </span>
              )}
              {selected.rules.drive.length > 0 && (
                <span>
                  files into <strong>{selected.rules.drive[0].label || 'Drive'}</strong>
                </span>
              )}
            </footer>
          )}
        </section>
      )}

      {selected !== null && Panel !== undefined ? (
        <div className="agente-panel">
          <Panel providerId={providerId} modelId={modelId} onError={onError} />
        </div>
      ) : selected !== null ? (
        <div className="empty-state">
          <div className="empty-title">{selected.name} has no screen yet</div>
          <div className="empty-subtitle">it is in the registry but its component is missing</div>
        </div>
      ) : null}

      {providers.length === 0 && (
        <p className="cli-hint">
          no CLI detected — triage needs one to score the openings
        </p>
      )}
    </div>
  )
}
