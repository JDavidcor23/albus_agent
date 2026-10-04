import { useCallback, useEffect, useState } from 'react'
import type { AgentInfo, HubAgentEvent, HubReport, HubResultFile, HubRunSummary } from '../../../shared/ipc'

/**
 * The generic screen for every agent the hub runs.
 *
 * One component instead of one per agent id: an agent the user installs from
 * a git URL was never compiled into this app, so it cannot have a bespoke
 * screen. What it CAN have is a name, a `run`, a results folder and a log —
 * and that is everything this screen shows. See `.claude/docs/agents-hub.md`.
 */

const MAX_LOG_LINES = 300

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`
}

/** An unreadable date renders as a dash: this comes from the agent's own output. */
function humanDate(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleString()
}

/**
 * Case-insensitive on purpose: the agent's own build step picks the casing of
 * whatever it writes, and Albus does not get to police that — same relaxed
 * matching as the `regex(/\.html$/i)` the main process validates against.
 */
function isHtmlReportPath(path: string): boolean {
  return /\.html$/i.test(path)
}

function statusLabel(status: HubRunSummary['status']): string {
  if (status === 'ok') return 'finished'
  if (status === 'failed') return 'failed'
  if (status === 'timeout') return 'timed out'
  return 'cancelled'
}

function logLineClass(type: HubAgentEvent['type']): string {
  if (type === 'error') return 'external-agent-log-error'
  if (type === 'result') return 'external-agent-log-result'
  if (type === 'question') return 'external-agent-log-question'
  if (type === 'progress') return 'external-agent-log-progress'
  return 'external-agent-log-plain'
}

/**
 * A `result` log line, with its "open" button only when there is a file.
 *
 * Split out so `path` narrows to `string` right at the parameter — reading
 * `event.path` straight inside the JSX of the big list loses that narrowing
 * across the click handler's closure, since `event` itself is a union typed
 * by `event.type`.
 */
function ResultLine({
  message,
  path,
  onOpen,
  onView
}: {
  message: string
  path: string | null
  onOpen: (relPath: string) => void
  onView: (relPath: string) => void
}): React.JSX.Element {
  return (
    <span>
      {message}
      {path !== null && (
        <>
          <button type="button" className="external-agent-log-open" onClick={() => onOpen(path)}>
            open
          </button>
          {isHtmlReportPath(path) && (
            <button type="button" className="external-agent-log-open" onClick={() => onView(path)}>
              view
            </button>
          )}
        </>
      )}
    </span>
  )
}

interface Props {
  agent: AgentInfo
  onError: (message: string | null) => void
}

export function ExternalAgentPanel({ agent, onError }: Props): React.JSX.Element {
  const ext = agent.external

  const [running, setRunning] = useState(ext?.running ?? false)
  /**
   * `true` only when the run already in flight on mount is not one WE started
   * from this screen — there is no local promise here that will ever resolve
   * for it. Polling `listAgents` is how we notice it ended, short of a new IPC
   * channel just for this.
   */
  const [watchingExternalRun, setWatchingExternalRun] = useState(ext?.running ?? false)
  const [activeCommand, setActiveCommand] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [progress, setProgress] = useState<{ message: string; percent?: number } | null>(null)
  const [events, setEvents] = useState<HubAgentEvent[]>([])
  const [summary, setSummary] = useState<HubRunSummary | null>(null)
  const [results, setResults] = useState<HubResultFile[]>([])
  const [resultsLoading, setResultsLoading] = useState(true)
  const [report, setReport] = useState<HubReport | null>(null)
  const [reportPath, setReportPath] = useState<string | null>(null)
  const [reportLoading, setReportLoading] = useState(false)

  // Returns the unsubscribe: without it StrictMode mounts the handler twice.
  useEffect(() => {
    return window.api.onHubEvent(({ agentId, event }) => {
      if (agentId !== agent.id) return
      setEvents((prev) => [...prev, event].slice(-MAX_LOG_LINES))
      if (event.type === 'progress') setProgress({ message: event.message, percent: event.percent })
    })
  }, [agent.id])

  const loadReport = useCallback(
    async (relPath: string): Promise<void> => {
      setReportLoading(true)
      try {
        const res = await window.api.readHubReport(agent.id, relPath)
        if (!res.ok) {
          onError(res.error.message)
          return
        }
        setReport(res.data)
        setReportPath(res.data.relPath)
      } finally {
        setReportLoading(false)
      }
    },
    [agent.id, onError]
  )

  const refreshResults = useCallback(async (): Promise<void> => {
    const res = await window.api.listHubResults(agent.id)
    setResultsLoading(false)
    if (!res.ok) {
      onError(res.error.message)
      return
    }
    setResults(res.data)

    // Resync the viewer to the newest report every time results reload: a
    // fresh run may have produced a newer one, and this reuses the three
    // existing reload points below (run completion, window focus, external
    // run polling) instead of adding new ones.
    const latestHtml = res.data.find((r) => isHtmlReportPath(r.relPath))
    if (latestHtml !== undefined) {
      void loadReport(latestHtml.relPath)
    } else {
      setReport(null)
      setReportPath(null)
    }
  }, [agent.id, onError, loadReport])

  useEffect(() => {
    void refreshResults()
  }, [refreshResults])

  /*
   * The user leaves the agent working and switches tabs; the results land on
   * disk while this screen is not focused. Same reasoning as the rules file
   * reload in `AgentsPanel`: coming back to a quiet list reads as "it did
   * nothing" when really it just was not looking.
   */
  useEffect(() => {
    const onFocus = (): void => void refreshResults()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshResults])

  useEffect(() => {
    if (!watchingExternalRun) return undefined
    const id = setInterval(() => {
      void window.api.listAgents().then((res) => {
        if (!res.ok) return
        const fresh = res.data.find((a) => a.id === agent.id)
        if (fresh?.external?.running === false) {
          setWatchingExternalRun(false)
          setRunning(false)
          void refreshResults()
        }
      })
    }, 3000)
    return () => clearInterval(id)
  }, [watchingExternalRun, agent.id, refreshResults])

  const run = async (command: string): Promise<void> => {
    onError(null)
    setSummary(null)
    setEvents([])
    setProgress(null)
    setActiveCommand(command)
    setRunning(true)
    try {
      const res = await window.api.runHubAgent(agent.id, command)
      if (res.ok) {
        setSummary(res.data)
        await refreshResults()
      } else {
        onError(res.error.message)
      }
    } finally {
      setRunning(false)
      setActiveCommand(null)
    }
  }

  const cancel = async (): Promise<void> => {
    onError(null)
    setCancelling(true)
    try {
      const res = await window.api.cancelHubAgent(agent.id)
      if (!res.ok) onError(res.error.message)
    } finally {
      setCancelling(false)
    }
  }

  const openCode = async (): Promise<void> => {
    onError(null)
    const res = await window.api.openHubPath(agent.id, 'code')
    if (!res.ok) onError(res.error.message)
  }

  const openResultsFolder = async (): Promise<void> => {
    onError(null)
    const res = await window.api.openHubPath(agent.id, 'results')
    if (!res.ok) onError(res.error.message)
  }

  const openResultFile = async (relPath: string): Promise<void> => {
    onError(null)
    const res = await window.api.openHubPath(agent.id, 'file', relPath)
    if (!res.ok) onError(res.error.message)
  }

  if (ext === null) {
    return (
      <div className="empty-state">
        <div className="empty-title">{agent.name} has no hub details</div>
        <div className="empty-subtitle">
          this is an external agent without its contract data — reinstall it
        </div>
      </div>
    )
  }

  const otherCommands = ext.commands.filter((c) => c !== 'run')

  return (
    <div className="external-agent">
      <header className="external-agent-head">
        <div>
          <h3 className="external-agent-title">
            {agent.name}
            {ext.version !== '' && <span className="external-agent-version">v{ext.version}</span>}
          </h3>
          <p className="external-agent-desc">{agent.description}</p>
        </div>

        {(ext.needs.length > 0 || ext.schedule !== '') && (
          <div className="external-agent-chips">
            {ext.needs.map((n) => (
              <span key={n} className="external-agent-chip">
                {n}
              </span>
            ))}
            {ext.schedule !== '' && (
              <span
                className="external-agent-chip external-agent-chip-schedule"
                title="scheduled outside Albus"
              >
                {ext.schedule}
              </span>
            )}
          </div>
        )}
      </header>

      {!agent.available && (
        <div className="external-agent-reason">
          <strong>not available:</strong> {agent.reason}
        </div>
      )}

      <div className="external-agent-actions">
        <button
          type="button"
          className="btn-conectar"
          disabled={running || !agent.available}
          onClick={() => void run('run')}
        >
          {running && activeCommand === 'run' ? 'running…' : 'run'}
        </button>

        {otherCommands.map((c) => (
          <button
            key={c}
            type="button"
            className="reglas-editar"
            disabled={running}
            onClick={() => void run(c)}
          >
            {running && activeCommand === c ? `${c}…` : c}
          </button>
        ))}

        {running && (
          <button
            type="button"
            className="reglas-editar"
            disabled={cancelling}
            onClick={() => void cancel()}
          >
            {cancelling ? 'cancelling…' : 'cancel'}
          </button>
        )}

        <button type="button" className="reglas-editar" onClick={() => void openCode()}>
          open code folder
        </button>
        <button type="button" className="reglas-editar" onClick={() => void openResultsFolder()}>
          open results folder
        </button>
      </div>

      {running && (
        <div className="external-agent-progress">
          <div className="external-agent-stage">
            {progress?.message ?? (watchingExternalRun ? 'already running…' : 'starting…')}
          </div>
          {progress?.percent !== undefined && (
            <div className="external-agent-bar">
              <div className="external-agent-bar-fill" style={{ width: `${progress.percent}%` }} />
            </div>
          )}
        </div>
      )}

      {events.length > 0 && (
        <ul className="external-agent-log">
          {events.map((e, i) => (
            <li key={i} className={`external-agent-log-line ${logLineClass(e.type)}`}>
              {e.type === 'log' && <span>{e.text}</span>}
              {e.type === 'progress' && <span>{e.message}</span>}
              {e.type === 'error' && <span>{e.message}</span>}
              {e.type === 'result' && (
                <ResultLine message={e.message} path={e.path} onOpen={openResultFile} onView={loadReport} />
              )}
              {e.type === 'question' && (
                <span>
                  {e.question}
                  <em className="external-agent-log-note"> — added to this agent's questions</em>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {summary !== null && (
        <div className={`external-agent-summary external-agent-summary-${summary.status}`}>
          {statusLabel(summary.status)}
          {summary.message !== '' && ` — ${summary.message}`}
          {summary.exitCode !== null && ` (exit ${summary.exitCode})`}
        </div>
      )}

      {reportPath !== null && (
        <div className="external-agent-report">
          <div className="external-agent-report-head">
            <h4>latest report</h4>
            <div className="external-agent-report-meta">
              <span className="external-agent-report-path">{reportPath}</span>
              {report !== null && <span>{humanDate(report.modifiedAt)}</span>}
              <button
                type="button"
                className="external-agent-log-open"
                onClick={() => void openResultFile(reportPath)}
              >
                open in browser ↗
              </button>
            </div>
          </div>

          {reportLoading && <p className="video-empty">loading the report…</p>}

          {/*
           * Empty `sandbox` on purpose: the HTML came from a third-party agent
           * and may contain model-generated text. No `allow-scripts`, no
           * `allow-same-origin`, no `allow-popups` — links render but do not
           * navigate, which is an acceptable tradeoff for a non-interactive
           * preview (see "open in browser" above for anything clickable).
           */}
          {!reportLoading && report !== null && (
            <iframe
              sandbox=""
              srcDoc={report.html}
              title={`${agent.name} report — ${reportPath}`}
              className="external-agent-report-frame"
            />
          )}
        </div>
      )}

      <div className="external-agent-results">
        <div className="external-agent-results-head">
          <h4>recent results</h4>
          <button type="button" className="reglas-editar" onClick={() => void refreshResults()}>
            refresh
          </button>
        </div>

        {resultsLoading && <p className="video-empty">reading the results folder…</p>}

        {!resultsLoading && results.length === 0 && (
          <p className="video-empty">
            nothing here yet — run the agent and its output lands in this list
          </p>
        )}

        {results.length > 0 && (
          <ul className="external-agent-results-list">
            {results.map((r) => {
              const isHtml = isHtmlReportPath(r.relPath)
              return (
                <li key={r.relPath} className="external-agent-result-row">
                  <button
                    type="button"
                    className="external-agent-result-link"
                    onClick={() => void (isHtml ? loadReport(r.relPath) : openResultFile(r.relPath))}
                  >
                    {r.relPath}
                  </button>
                  <span className="external-agent-result-meta">
                    {humanSize(r.size)} · {humanDate(r.modifiedAt)}
                    {isHtml && (
                      <button
                        type="button"
                        className="external-agent-log-open"
                        onClick={() => void openResultFile(r.relPath)}
                      >
                        open in browser ↗
                      </button>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
