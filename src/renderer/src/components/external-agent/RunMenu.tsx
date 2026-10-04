import { useEffect, useRef, useState } from 'react'

interface Props {
  /** The agent's declared commands minus `run` — that one already has its own pill. */
  commands: string[]
  /** Disables the "Run <command>" entries while something is already running — folders and the log stay open regardless. */
  busy: boolean
  needs: string[]
  schedule: string
  onRunCommand: (command: string) => void
  onOpenResultsFolder: () => void
  onOpenCodeFolder: () => void
  onShowLog: () => void
}

/**
 * The "⋯" ghost button next to the primary pill, and its popover.
 *
 * Holds every declared command besides `run`, the two folder shortcuts and
 * the last run's log — the dev-command row the old screen put in front of
 * the user by default. `needs`/`schedule` live in its footer as plain text:
 * informative only, never implying a schedule Albus itself runs.
 */
export function RunMenu({
  commands,
  busy,
  needs,
  schedule,
  onRunCommand,
  onOpenResultsFolder,
  onOpenCodeFolder,
  onShowLog
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined

    const onPointerDown = (e: MouseEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const choose = (action: () => void): void => {
    action()
    setOpen(false)
  }

  return (
    <div className="external-agent-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="external-agent-ghost-btn"
        aria-label="more actions"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>

      {open && (
        <div className="external-agent-menu">
          {commands.map((c) => (
            <button
              key={c}
              type="button"
              className="external-agent-menu-item"
              disabled={busy}
              onClick={() => choose(() => onRunCommand(c))}
            >
              Run {c}
            </button>
          ))}

          {commands.length > 0 && <div className="external-agent-menu-sep" />}

          <button type="button" className="external-agent-menu-item" onClick={() => choose(onOpenResultsFolder)}>
            Open results folder
          </button>
          <button type="button" className="external-agent-menu-item" onClick={() => choose(onOpenCodeFolder)}>
            Open code folder
          </button>
          <button type="button" className="external-agent-menu-item" onClick={() => choose(onShowLog)}>
            Show last run log
          </button>

          {(needs.length > 0 || schedule !== '') && (
            <div className="external-agent-menu-footer">
              {needs.length > 0 && <div>needs: {needs.join(', ')}</div>}
              {schedule !== '' && <div>schedule: {schedule} (not run by Albus)</div>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
