import type { HubResultFile } from '../../../../shared/ipc'
import { humanDateSmart } from './human-date'

interface Props {
  /** Already the 5 newest `.html` reports, newest first — see `ExternalAgentPanel`. */
  reports: HubResultFile[]
  selected: string | null
  onSelect: (relPath: string) => void
}

/**
 * The report history, as date pills — never the raw file list with its
 * `.json` siblings and machine timestamps. Renders nothing with 0 or 1
 * report: picking between one thing is not a choice worth showing.
 */
export function HistoryPills({ reports, selected, onSelect }: Props): React.JSX.Element | null {
  if (reports.length <= 1) return null

  return (
    <div className="external-agent-history">
      {reports.map((r) => (
        <button
          key={r.relPath}
          type="button"
          className={`external-agent-history-pill ${
            r.relPath === selected ? 'external-agent-history-pill-selected' : ''
          }`}
          onClick={() => onSelect(r.relPath)}
        >
          {humanDateSmart(r.modifiedAt)}
        </button>
      ))}
    </div>
  )
}
