import { useCallback, useEffect, useState } from 'react'
import type {
  AgentInfo,
  CliProviderInfo,
  HubInstallReport,
  HubInstallStep
} from '../../../shared/ipc'
import { ExternalAgentPanel } from './ExternalAgentPanel'
import { JobChat } from './JobChat'
import { VideoPanel } from './VideoPanel'

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

/**
 * Nombre de PANTALLA → el componente que la dibuja.
 *
 * Ojo con lo que cambió: antes esto se indexaba por **id de agente**, y eso
 * volvía imposible lo que Albus dice ser. Un agente que el usuario escribiera
 * en su carpeta no podía tener cara nunca, porque su id no estaba en este mapa
 * del código fuente — quedaba en la lista con "no tiene pantalla todavía" para
 * siempre. Sumar un agente seguía siendo editar este archivo y compilar.
 *
 * Ahora el manifiesto ELIGE su pantalla (`"screen": "video"`). Las pantallas
 * siguen siendo código; cuál usar es dato del usuario. Un segundo agente que
 * procese grabaciones se escribe como archivo y no toca este archivo.
 */
const SCREENS: Record<string, (props: PanelProps) => React.JSX.Element> = {
  // Chat y no formulario: el agente se maneja hablándole. Ver `JobChat.tsx`.
  'job-chat': (p) => (
    <JobChat providerId={p.providerId} modelId={p.modelId} onError={p.onError} />
  ),
  /*
   * Formulario y no chat, al revés que el de arriba: un pipeline determinista no
   * tiene nada que conversar. Se elige un archivo y se espera.
   */
  video: (p) => (
    <VideoPanel providerId={p.providerId} modelId={p.modelId} onError={p.onError} agent={p.agent} />
  ),
  /*
   * Every agent the hub discovers, installs and runs shares this ONE screen —
   * see `.claude/docs/agents-hub.md`. An agent-specific component here would
   * mean a user-installed agent can never have a face.
   */
  external: (p) => <ExternalAgentPanel agent={p.agent} onError={p.onError} />
}

/**
 * Los `.agente.json` que ya están en la carpeta del usuario no tienen `screen`:
 * se escribieron antes de que el campo existiera, y una semilla NO sobrescribe
 * un archivo que ya está. Sin este mapa, el agente de trabajo perdía su chat al
 * actualizar la app — su pantalla existe, pero nadie sabría que le corresponde.
 *
 * Es una tabla de compatibilidad, no la forma de sumar agentes: un id nuevo acá
 * es un bug. Se borra cuando ya no queden manifiestos viejos.
 */
const LEGACY_SCREEN_BY_ID: Record<string, string> = { 'job-search': 'job-chat' }

function screenFor(agent: AgentInfo): string {
  if (agent.screen !== '') return agent.screen
  return LEGACY_SCREEN_BY_ID[agent.id] ?? ''
}

export interface PanelProps {
  providerId: string | null
  modelId: string | null
  onError: (message: string | null) => void
  /** The selected agent's own data. Only `'external'` reads it today. */
  agent: AgentInfo
}

interface Props {
  providerId: string | null
  modelId: string | null
  onError: (message: string | null) => void
  providers: CliProviderInfo[]
}

export function AgentsPanel({ providerId, modelId, onError, providers }: Props): React.JSX.Element {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /** Lo que el usuario está escribiendo, por pregunta. */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [answering, setAnswering] = useState<string | null>(null)

  // ── install an external agent ─────────────────────────────────────────
  const [showInstallForm, setShowInstallForm] = useState(false)
  const [installSource, setInstallSource] = useState('')
  const [installLink, setInstallLink] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installSteps, setInstallSteps] = useState<HubInstallStep[]>([])
  const [installReport, setInstallReport] = useState<HubInstallReport | null>(null)

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

  // Returns the unsubscribe: without it StrictMode mounts the handler twice
  // and every step of the install would be logged twice.
  useEffect(() => window.api.onHubInstallStep((step) => setInstallSteps((prev) => [...prev, step])), [])

  const browseAgentFolder = async (): Promise<void> => {
    onError(null)
    const res = await window.api.pickHubAgentFolder()
    if (!res.ok) {
      onError(res.error.message)
      return
    }
    if (res.data !== null) setInstallSource(res.data)
  }

  const installAgent = async (): Promise<void> => {
    const source = installSource.trim()
    if (source === '') return

    onError(null)
    setInstalling(true)
    setInstallSteps([])
    setInstallReport(null)
    try {
      const res = await window.api.installHubAgent(source, installLink)
      if (!res.ok) {
        onError(res.error.message)
        return
      }
      setInstallReport(res.data)
      // The list needs reloading even on failure: a failed `check` still
      // leaves the agent installed, just painted off with the reason.
      load()
      if (res.data.ok && res.data.id !== null) setActive(res.data.id)
    } finally {
      setInstalling(false)
    }
  }

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

  /*
   * The marketplace, minimal: a Git URL or a local folder becomes an agent
   * under `agents-hub/agents/`. It is rendered even with zero agents — that
   * is the one state where installing one matters most.
   */
  const installSection = (
    <div className="hub-install">
      {!showInstallForm ? (
        <button type="button" className="hub-install-toggle" onClick={() => setShowInstallForm(true)}>
          + install agent
        </button>
      ) : (
        <div className="hub-install-form">
          <div className="hub-install-row">
            <input
              className="hub-install-input"
              placeholder="git URL or local folder"
              value={installSource}
              disabled={installing}
              onChange={(e) => setInstallSource(e.target.value)}
            />
            <button
              type="button"
              className="reglas-editar"
              disabled={installing}
              onClick={() => void browseAgentFolder()}
            >
              browse…
            </button>
          </div>

          <label className="hub-install-checkbox">
            <input
              type="checkbox"
              checked={installLink}
              disabled={installing}
              onChange={(e) => setInstallLink(e.target.checked)}
            />
            link instead of copy (develop in place, keeps the agent&apos;s local session)
          </label>

          <div className="hub-install-actions">
            <button
              type="button"
              className="btn-conectar"
              disabled={installing || installSource.trim() === ''}
              onClick={() => void installAgent()}
            >
              {installing ? 'installing…' : 'install'}
            </button>
            <button
              type="button"
              className="reglas-editar"
              disabled={installing}
              onClick={() => {
                setShowInstallForm(false)
                setInstallSteps([])
                setInstallReport(null)
                setInstallSource('')
              }}
            >
              close
            </button>
          </div>

          {installSteps.length > 0 && (
            <ul className="hub-install-steps">
              {installSteps.map((s, i) => (
                <li key={i} className={s.ok ? 'hub-install-step-ok' : 'hub-install-step-fail'}>
                  <span>{s.ok ? '✓' : '✗'}</span> {s.step}
                  {s.detail !== '' && <span className="hub-install-step-detail"> — {s.detail}</span>}
                </li>
              ))}
            </ul>
          )}

          {installReport !== null && (
            <p className={installReport.ok ? 'hub-install-result-ok' : 'hub-install-result-fail'}>
              {installReport.ok
                ? `installed at ${installReport.dir ?? ''}`
                : 'install failed — see the steps above'}
            </p>
          )}
        </div>
      )}

      <button
        type="button"
        className="hub-install-footer"
        onClick={() =>
          void window.api.openAgentsHub().then((r) => {
            if (!r.ok) onError(r.error.message)
          })
        }
      >
        open agents hub folder ↗
      </button>
    </div>
  )

  if (loading) {
    return <div className="idle-state"><span className="idle-text">looking for agents…</span></div>
  }

  if (agents.length === 0) {
    return (
      <div className="agentes">
        <div className="empty-state">
          <div className="empty-title">no agents registered</div>
          <div className="empty-subtitle">
            built-in ones are added in src/main/agents/registry.ts — or install one below
          </div>
        </div>
        {installSection}
      </div>
    )
  }

  const selected = agents.find((a) => a.id === active) ?? null
  const Panel = selected === null ? undefined : SCREENS[screenFor(selected)]

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
            <span className="agente-card-head">
              <span className="agente-nombre">{a.name}</span>
              {a.origin === 'external' && <span className="agente-tag-external">external</span>}
            </span>
            <span className="agente-desc">{a.description}</span>
            {a.reason !== '' && <span className="agente-motivo">{a.reason}</span>}
          </button>
        ))}
      </div>

      {installSection}

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
        // `key` forces a remount on every switch: two external agents share
        // this same component, and without it the second one would open
        // showing the first one's log and results.
        <div className="agente-panel" key={selected.id}>
          <Panel providerId={providerId} modelId={modelId} onError={onError} agent={selected} />
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
