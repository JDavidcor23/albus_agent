import type { CliProviderInfo } from '../../../shared/ipc'
import { CliPicker } from './CliPicker'

interface Props {
  procesando: boolean
  providers: CliProviderInfo[]
  providerId: string | null
  modelId: string | null
  onCliChange: (providerId: string | null, modelId: string | null) => void
  refrescandoCli: boolean
  cargandoCli: boolean
  onRefrescarCli: () => void
  progreso: { hechos: number; total: number } | null
  total: number
  onProcesar: () => void
  onReprocesar: () => void
}

export function LeftPanel({
  procesando,
  providers,
  providerId,
  modelId,
  onCliChange,
  refrescandoCli,
  cargandoCli,
  onRefrescarCli,
  progreso,
  total,
  onProcesar,
  onReprocesar
}: Props): React.JSX.Element {
  const pct =
    progreso !== null && progreso.total > 0
      ? Math.round((progreso.hechos / progreso.total) * 100)
      : 0

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
          deshabilitado={procesando}
          refrescando={refrescandoCli}
          cargando={cargandoCli}
          onChange={onCliChange}
          onRefrescar={onRefrescarCli}
        />

        <button type="button" className="btn-brass" onClick={onProcesar} disabled={procesando}>
          {procesando ? 'procesando…' : 'procesar lote'}
        </button>

        <button
          type="button"
          className="btn-ghost"
          onClick={onReprocesar}
          disabled={procesando}
        >
          reprocesar todo
        </button>

        {procesando && progreso !== null && (
          <div className="progress-block">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="progress-meta">
              {progreso.hechos} / {progreso.total}
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
