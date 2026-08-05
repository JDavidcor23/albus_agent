import type { CliProviderInfo } from '../../../shared/ipc'

interface Props {
  providers: CliProviderInfo[]
  providerId: string | null
  modelId: string | null
  deshabilitado: boolean
  refrescando: boolean
  cargando: boolean
  onChange: (providerId: string | null, modelId: string | null) => void
  onRefrescar: () => void
}

const COMO: Record<string, string> = {
  seed: 'candidatos sin verificar',
  listed: 'el cli los enumera',
  probed: 'probados uno por uno',
  cached: 'de cache'
}

interface Opcion {
  valor: string | null
  texto: string
}

function Fila({
  opciones,
  activo,
  deshabilitado,
  onPick
}: {
  opciones: Opcion[]
  activo: string | null
  deshabilitado: boolean
  onPick: (valor: string | null) => void
}): React.JSX.Element {
  return (
    <div className="pick-row" role="radiogroup">
      {opciones.map((o, i) => (
        <span key={o.valor ?? 'none'} className="pick-item">
          {i > 0 && <span className="pick-sep">·</span>}
          <button
            type="button"
            role="radio"
            aria-checked={activo === o.valor}
            className={`pick ${activo === o.valor ? 'pick-on' : ''}`}
            disabled={deshabilitado}
            onClick={() => onPick(o.valor)}
          >
            {o.texto}
          </button>
        </span>
      ))}
    </div>
  )
}

/**
 * Muestra qué CLI hay instalados y con cuál correr el escalón 4.
 * Se dibuja como texto y no con controles nativos: un <select> de Windows mete
 * su tipografía y su chevron en una pantalla que no tiene nada nativo.
 */
export function CliPicker({
  providers,
  providerId,
  modelId,
  deshabilitado,
  refrescando,
  cargando,
  onChange,
  onRefrescar
}: Props): React.JSX.Element {
  const actual = providers.find((p) => p.id === providerId) ?? null

  const opcionesProveedor: Opcion[] = providers.map((p) => ({ valor: p.id, texto: p.id }))

  return (
    <div className="cli-picker">
      <div className="cli-label">cli detectado</div>

      <Fila
        opciones={opcionesProveedor}
        activo={providerId}
        deshabilitado={deshabilitado}
        onPick={(v) => {
          const p = providers.find((x) => x.id === v) ?? null
          onChange(v, p?.models[0]?.id ?? null)
        }}
      />

      {actual !== null && actual.models.length > 0 && (
        <Fila
          opciones={actual.models.map((m) => ({ valor: m.id, texto: m.id }))}
          activo={modelId ?? actual.models[0].id}
          deshabilitado={deshabilitado}
          onPick={(v) => onChange(actual.id, v)}
        />
      )}

      {actual !== null && (
        <p className="cli-hint">
          {actual.models.length} modelos · {COMO[actual.method] ?? actual.method} ·{' '}
          {actual.cliVersion}
        </p>
      )}

      <p className="cli-hint">
        {cargando
          ? 'buscando cli…'
          : providers.length === 0
            ? 'ningún CLI en el PATH'
            : 'se usa solo en lo que QR, OCR y patrones no resolvieron'}
      </p>

      <button
        type="button"
        className="pick cli-refresh"
        disabled={deshabilitado || refrescando}
        onClick={onRefrescar}
      >
        {refrescando ? 'probando cada modelo…' : 'verificar modelos'}
      </button>
    </div>
  )
}
