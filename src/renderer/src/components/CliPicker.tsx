import type { CliProviderInfo } from '../../../shared/ipc'

interface Props {
  providers: CliProviderInfo[]
  providerId: string | null
  modelId: string | null
  refreshing: boolean
  loading: boolean
  onChange: (providerId: string | null, modelId: string | null) => void
  onRefresh: () => void
}

/** How the CLI reported its models. Shown so a stale list is explainable. */
const HOW: Record<string, string> = {
  seed: 'unverified candidates',
  listed: 'listed by the CLI',
  probed: 'probed one by one',
  cached: 'from cache'
}

/**
 * Which CLI runs step 4 of the cascade, and with which model.
 *
 * Drawn as text and not with native controls: a Windows <select> drags its own
 * typeface and chevron into a screen that has nothing native in it.
 *
 * The provider list is NOT hardcoded — it is whatever `listCliProviders` found
 * on the PATH. Today that shows one entry because one CLI is installed.
 *
 * Each row carries its own label. Without them this was two lines of
 * dot-separated words and you could not tell the CLI from the model.
 */
export function CliPicker({
  providers,
  providerId,
  modelId,
  refreshing,
  loading,
  onChange,
  onRefresh
}: Props): React.JSX.Element {
  if (loading) return <p className="cli-hint">looking for CLIs…</p>

  if (providers.length === 0) {
    return <p className="cli-hint">no CLI on the PATH — step 4 of the cascade is off</p>
  }

  const current = providers.find((p) => p.id === providerId) ?? null
  const activeModel = modelId ?? current?.models[0]?.id ?? null

  return (
    <div className="cli-picker">
      <div className="cli-field">
        <span className="cli-field-label">CLI</span>
        <div className="cli-field-value" role="radiogroup" aria-label="CLI">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={providerId === p.id}
              className={`pick ${providerId === p.id ? 'pick-on' : ''}`}
              onClick={() => onChange(p.id, p.models[0]?.id ?? null)}
            >
              {p.id}
            </button>
          ))}
        </div>
      </div>

      {current !== null && current.models.length > 0 && (
        <div className="cli-field">
          <span className="cli-field-label">Model</span>
          <div className="cli-field-value" role="radiogroup" aria-label="Model">
            {current.models.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={activeModel === m.id}
                className={`pick ${activeModel === m.id ? 'pick-on' : ''}`}
                onClick={() => onChange(current.id, m.id)}
              >
                {m.id}
              </button>
            ))}
          </div>
        </div>
      )}

      {current !== null && (
        <p className="cli-hint">
          {current.models.length} models · {HOW[current.method] ?? current.method} ·{' '}
          {current.cliVersion}
        </p>
      )}

      <p className="cli-hint">only used for what QR, OCR and patterns could not resolve</p>

      <button type="button" className="pick cli-refresh" disabled={refreshing} onClick={onRefresh}>
        {refreshing ? 'probing every model…' : 'verify models'}
      </button>
    </div>
  )
}
