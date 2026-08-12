import type { ExtractionKind, ResultRow } from '../../../shared/ipc'
import type { PendingRow } from '../App'

interface Props {
  rows: ResultRow[]
  inProgress: PendingRow | null
  processing: boolean
  progress: { done: number; total: number } | null
  onProcess: () => void
  onReprocess: () => void
}

/** No previews: one glyph per kind is enough to tell what each row is. */
const ICON: Record<ExtractionKind, string> = {
  qr: '⬚',
  receipt: '₡',
  profile: '☰',
  document: '▤',
  text: '¶',
  none: '·',
  failed: '✕'
}

const NAME: Record<ExtractionKind, string> = {
  qr: 'qr code',
  receipt: 'receipt',
  profile: 'profile',
  document: 'document',
  text: 'text',
  none: 'no content',
  failed: 'failed'
}

function Row({ row }: { row: ResultRow }): React.JSX.Element {
  return (
    <li className={`feed-row kind-${row.kind}`}>
      <span className="feed-icon" aria-hidden="true">
        {ICON[row.kind]}
      </span>
      <div className="feed-body">
        <div className="feed-head">
          <span className="feed-label">{row.label}</span>
          <span className="feed-kind">{NAME[row.kind]}</span>
        </div>
        {row.summary.length > 0 && <p className="feed-summary">{row.summary}</p>}
      </div>
    </li>
  )
}

/**
 * The extraction cascade and what it produced.
 *
 * The worker controls live here and not in the app rail: they drive this view
 * and nothing else. They render ABOVE the early return for the empty state —
 * an empty archive is exactly when you need the button that fills it.
 */
export function ResultsFeed({
  rows,
  inProgress,
  processing,
  progress,
  onProcess,
  onReprocess
}: Props): React.JSX.Element {
  const empty = rows.length === 0 && inProgress === null
  const pct =
    progress !== null && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div className="feed-wrap">
      <div className="feed-bar">
        <button type="button" className="btn-brass" onClick={onProcess} disabled={processing}>
          {processing ? 'processing…' : 'process batch'}
        </button>
        <button type="button" className="btn-ghost" onClick={onReprocess} disabled={processing}>
          reprocess everything
        </button>

        {processing && progress !== null && (
          <div className="progress-block">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="progress-meta">
              {progress.done} / {progress.total}
            </div>
            <p className="processing-hint">
              OCR looks at every image carefully. Several seconds per file.
            </p>
          </div>
        )}
      </div>

      {empty && !processing ? (
        <div className="idle-state">
          <div className="idle-icon">🕮</div>
          <p className="idle-text">
            The archive is quiet. Hit <strong>process batch</strong> to run the cascade over
            the pending notes.
          </p>
        </div>
      ) : (
        <ul className="feed">
          {inProgress !== null && (
            <li className="feed-row feed-row-active">
              <span className="feed-spinner" aria-hidden="true" />
              <div className="feed-body">
                <div className="feed-head">
                  <span className="feed-label">{inProgress.label}</span>
                  <span className="feed-kind">reading…</span>
                </div>
              </div>
            </li>
          )}

          {rows.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </ul>
      )}
    </div>
  )
}
