import type { CliProviderInfo } from '../../../shared/ipc'

interface Props {
  providers: CliProviderInfo[]
  providerId: string | null
  modelId: string | null
  disabled: boolean
  refreshing: boolean
  loading: boolean
  onChange: (providerId: string | null, modelId: string | null) => void
  onRefresh: () => void
}

const HOW: Record<string, string> = {
  seed: 'candidatos sin verificar',
  listed: 'el cli los enumera',
  probed: 'probados uno por uno',
  cached: 'de cache'
}

interface Option {
  value: string | null
  text: string
}

function Row({
  options,
  active,
  disabled,
  onPick
}: {
  options: Option[]
  active: string | null
  disabled: boolean
  onPick: (value: string | null) => void
}): React.JSX.Element {
  return (
    <div className="pick-row" role="radiogroup">
      {options.map((o, i) => (
        <span key={o.value ?? 'none'} className="pick-item">
          {i > 0 && <span className="pick-sep">·</span>}
          <button
            type="button"
            role="radio"
            aria-checked={active === o.value}
            className={`pick ${active === o.value ? 'pick-on' : ''}`}
            disabled={disabled}
            onClick={() => onPick(o.value)}
          >
            {o.text}
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
  disabled,
  refreshing,
  loading,
  onChange,
  onRefresh
}: Props): React.JSX.Element {
  const current = providers.find((p) => p.id === providerId) ?? null

  const providerOptions: Option[] = providers.map((p) => ({ value: p.id, text: p.id }))

  return (
    <div className="cli-picker">
      <div className="cli-label">cli detectado</div>

      <Row
        options={providerOptions}
        active={providerId}
        disabled={disabled}
        onPick={(v) => {
          const p = providers.find((x) => x.id === v) ?? null
          onChange(v, p?.models[0]?.id ?? null)
        }}
      />

      {current !== null && current.models.length > 0 && (
        <Row
          options={current.models.map((m) => ({ value: m.id, text: m.id }))}
          active={modelId ?? current.models[0].id}
          disabled={disabled}
          onPick={(v) => onChange(current.id, v)}
        />
      )}

      {current !== null && (
        <p className="cli-hint">
          {current.models.length} modelos · {HOW[current.method] ?? current.method} ·{' '}
          {current.cliVersion}
        </p>
      )}

      <p className="cli-hint">
        {loading
          ? 'buscando cli…'
          : providers.length === 0
            ? 'ningún CLI en el PATH'
            : 'se usa solo en lo que QR, OCR y patrones no resolvieron'}
      </p>

      <button
        type="button"
        className="pick cli-refresh"
        disabled={disabled || refreshing}
        onClick={onRefresh}
      >
        {refreshing ? 'probando cada modelo…' : 'verificar modelos'}
      </button>
    </div>
  )
}
