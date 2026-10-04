import { useCallback, useEffect, useState } from 'react'
import type { AgentInfo, HubAgentEvent, HubReport, HubResultFile, HubRunSummary } from '../../../shared/ipc'
import { HistoryPills } from './external-agent/HistoryPills'
import { RunMenu } from './external-agent/RunMenu'
import { humanDateSmart } from './external-agent/human-date'

/**
 * The generic screen for every agent the hub runs — "option A": the report
 * IS the screen. One component instead of one per agent id: an agent the
 * user installs from a git URL was never compiled into this app, so it
 * cannot have a bespoke screen. Albus stays generic on purpose; it never
 * learns what a given agent IS. See `.claude/docs/agents-hub.md`.
 *
 * Rewritten from a dev-command row + raw file list + scrolling log into:
 * name + last-updated, one primary action, a history of past reports as
 * date pills, and the selected report filling the screen.
 */

const MAX_LOG_LINES = 300

/**
 * Case-insensitive on purpose: the agent's own build step picks the casing of
 * whatever it writes, and Albus does not get to police that — same relaxed
 * matching as the `regex(/\.html$/i)` the main process validates against.
 */
function isHtmlReportPath(path: string): boolean {
  return /\.html$/i.test(path)
}

function eventLine(e: HubAgentEvent): string {
  if (e.type === 'log') return e.text
  if (e.type === 'progress') return e.message
  if (e.type === 'error') return e.message
  if (e.type === 'result') return e.message
  return e.question
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
  const [cancelling, setCancelling] = useState(false)
  const [progress, setProgress] = useState<{ message: string; percent?: number } | null>(null)
  const [events, setEvents] = useState<HubAgentEvent[]>([])
  const [summary, setSummary] = useState<HubRunSummary | null>(null)
  const [showLog, setShowLog] = useState(false)

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
    setShowLog(false)
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
  const reports = results.filter((r) => isHtmlReportPath(r.relPath)).slice(0, 5)
  const newestReport = reports[0] ?? null
  const primaryLabel = ext.runLabel !== '' ? ext.runLabel : 'Run'
  const askedQuestion = events.some((e) => e.type === 'question')

  return (
    <div className="external-agent">
      <header className="external-agent-header">
        <div className="external-agent-heading">
          <h3 className="external-agent-name">{agent.name}</h3>
          {newestReport !== null && (
            <span className="external-agent-updated"> · {humanDateSmart(newestReport.modifiedAt)}</span>
          )}
        </div>

        <div className="external-agent-controls">
          <button
            type="button"
            className={`external-agent-pill-primary ${running ? 'external-agent-pill-primary-cancel' : ''}`}
            disabled={running ? cancelling : !agent.available}
            onClick={() => void (running ? cancel() : run('run'))}
          >
            {running ? (cancelling ? 'Cancelling…' : 'Cancel') : primaryLabel}
          </button>

          <RunMenu
            commands={otherCommands}
            busy={running}
            needs={ext.needs}
            schedule={ext.schedule}
            onRunCommand={(c) => void run(c)}
            onOpenResultsFolder={() => void openResultsFolder()}
            onOpenCodeFolder={() => void openCode()}
            onShowLog={() => setShowLog((v) => !v)}
          />
        </div>
      </header>

      {!agent.available && (
        <div className="external-agent-card">
          <p className="external-agent-card-message">
            <strong>Not available:</strong> {agent.reason}
          </p>
        </div>
      )}

      {running && (
        <div className="external-agent-progress-line">
          <span className="external-agent-dot" />
          <span>{progress?.message ?? (watchingExternalRun ? 'Already running…' : 'Starting…')}</span>
          {progress?.percent !== undefined && (
            <span className="external-agent-progress-bar">
              <span className="external-agent-progress-bar-fill" style={{ width: `${progress.percent}%` }} />
            </span>
          )}
        </div>
      )}

      {askedQuestion && (
        <p className="external-agent-question-note">
          The agent asked something — answer it in Rules.
        </p>
      )}

      {summary !== null && (summary.status === 'failed' || summary.status === 'timeout') && (
        <div className="external-agent-card external-agent-card-failed">
          <p className="external-agent-card-message">
            {summary.status === 'timeout' ? 'Timed out' : 'Failed'}
            {summary.message !== '' && ` — ${summary.message}`}
            {summary.exitCode !== null && ` (exit ${summary.exitCode})`}
          </p>
          <button type="button" className="external-agent-card-toggle" onClick={() => setShowLog((v) => !v)}>
            {showLog ? 'hide details' : 'show details'}
          </button>
        </div>
      )}

      {summary !== null && summary.status === 'cancelled' && (
        <p className="external-agent-cancelled">Cancelled.</p>
      )}

      {showLog && events.length > 0 && (
        <ul className="external-agent-log-detail">
          {events.slice(-100).map((e, i) => (
            <li key={i}>{eventLine(e)}</li>
          ))}
        </ul>
      )}

      <HistoryPills reports={reports} selected={reportPath} onSelect={(p) => void loadReport(p)} />

      {reportPath !== null && (
        <button
          type="button"
          className="external-agent-open-link"
          onClick={() => void openResultFile(reportPath)}
        >
          open in browser ↗
        </button>
      )}

      <div className="external-agent-main">
        {(resultsLoading || reportLoading) && (
          <p className="video-empty">{resultsLoading ? 'looking for reports…' : 'loading the report…'}</p>
        )}

        {!resultsLoading && !reportLoading && report !== null && (
          // Empty `sandbox` on purpose: the HTML came from a third-party agent
          // and may contain model-generated text. No `allow-scripts`, no
          // `allow-same-origin`, no `allow-popups` — links render but do not
          // navigate, which is an acceptable tradeoff for a non-interactive
          // preview (see "open in browser" above for anything clickable).
          <iframe
            sandbox=""
            srcDoc={report.html}
            title={`${agent.name} report — ${reportPath ?? ''}`}
            className="external-agent-frame"
          />
        )}

        {!resultsLoading && !reportLoading && report === null && (
          <div className="external-agent-empty">
            <div className="external-agent-empty-title">No reports yet</div>
            <div className="external-agent-empty-sub">Press {primaryLabel} to create the first one.</div>
          </div>
        )}
      </div>
    </div>
  )
}
