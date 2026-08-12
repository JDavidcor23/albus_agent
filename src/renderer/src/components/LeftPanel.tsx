import type { CliProviderInfo } from '../../../shared/ipc'
import { CliPicker } from './CliPicker'

interface Props {
  processing: boolean
  providers: CliProviderInfo[]
  providerId: string | null
  modelId: string | null
  onCliChange: (providerId: string | null, modelId: string | null) => void
  refreshingCli: boolean
  loadingCli: boolean
  onRefreshCli: () => void
  progress: { done: number; total: number } | null
  total: number
  onProcess: () => void
  onReprocess: () => void
}

export function LeftPanel({
  processing,
  providers,
  providerId,
  modelId,
  onCliChange,
  refreshingCli,
  loadingCli,
  onRefreshCli,
  progress,
  total,
  onProcess,
  onReprocess
}: Props): React.JSX.Element {
  const pct =
    progress !== null && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <aside className="panel-left">
      <div>
        <h1 className="brand-title">Albus</h1>
        <div className="brand-subtitle">archivista // my notes</div>

        <p className="brand-description">
          Leo las notas e imágenes que capturaste y saco de ahí lo accionable: códigos QR,
          comprobantes, contactos y documentos.
        </p>

        <CliPicker
          providers={providers}
          providerId={providerId}
          modelId={modelId}
          refreshing={refreshingCli}
          loading={loadingCli}
          onChange={onCliChange}
          onRefresh={onRefreshCli}
        />

        <button type="button" className="btn-brass" onClick={onProcess} disabled={processing}>
          {processing ? 'procesando…' : 'procesar lote'}
        </button>

        <button
          type="button"
          className="btn-ghost"
          onClick={onReprocess}
          disabled={processing}
        >
          reprocesar todo
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
              El OCR mira cada imagen con calma. Son varios segundos por archivo.
            </p>
          </div>
        )}
      </div>

      <div className="footer-meta">
        {total > 0 ? `${total} extraídos` : 'albus agent // worker local'}
      </div>
    </aside>
  )
}
