import type { ExtractionKind, ResultRow } from '../../../shared/ipc'
import type { PendingRow } from '../App'

interface Props {
  rows: ResultRow[]
  inProgress: PendingRow | null
  processing: boolean
}

/** Sin previews: un glifo por tipo alcanza para saber qué es cada fila. */
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
  qr: 'código qr',
  receipt: 'comprobante',
  profile: 'perfil',
  document: 'documento',
  text: 'texto',
  none: 'sin contenido',
  failed: 'falló'
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

export function ResultsFeed({ rows, inProgress, processing }: Props): React.JSX.Element {
  const empty = rows.length === 0 && inProgress === null

  if (empty && !processing) {
    return (
      <div className="idle-state">
        <div className="idle-icon">🕮</div>
        <p className="idle-text">
          El archivo está en calma. Tocá <strong>procesar lote</strong> para correr la
          cascada sobre las notas pendientes.
        </p>
      </div>
    )
  }

  return (
    <ul className="feed">
      {inProgress !== null && (
        <li className="feed-row feed-row-active">
          <span className="feed-spinner" aria-hidden="true" />
          <div className="feed-body">
            <div className="feed-head">
              <span className="feed-label">{inProgress.label}</span>
              <span className="feed-kind">leyendo…</span>
            </div>
          </div>
        </li>
      )}

      {rows.map((row) => (
        <Row key={row.id} row={row} />
      ))}
    </ul>
  )
}
