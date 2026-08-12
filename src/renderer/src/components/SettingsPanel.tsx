import type { CliProviderInfo } from '../../../shared/ipc'
import { CliPicker } from './CliPicker'
import { ConnectionsPanel } from './ConnectionsPanel'

interface Props {
  providers: CliProviderInfo[]
  providerId: string | null
  modelId: string | null
  refreshing: boolean
  loading: boolean
  onCliChange: (providerId: string | null, modelId: string | null) => void
  onRefreshCli: () => void
  onError: (m: string | null) => void
}

/**
 * App-level configuration.
 *
 * Connections used to live inside the job agent's chat. Google, Drive and
 * Notion belong to Albus, not to one of its agents — buried there, the next
 * agent would have had to grow its own copy of the same panel.
 */
export function SettingsPanel({
  providers,
  providerId,
  modelId,
  refreshing,
  loading,
  onCliChange,
  onRefreshCli,
  onError
}: Props): React.JSX.Element {
  return (
    <div className="settings">
      <section className="settings-block">
        <h2 className="settings-title">Connections</h2>
        <p className="settings-sub">
          A window opens, you sign in, Albus keeps the session. Nothing to set up by hand.
        </p>
        {/*
          Nothing on this screen derives from connection state, so there is
          nothing to refresh when one changes. The job agent re-reads its own
          status when it mounts.
        */}
        <ConnectionsPanel onChange={() => undefined} onError={onError} />
      </section>

      <section className="settings-block">
        <h2 className="settings-title">Engine</h2>
        <p className="settings-sub">
          Which CLI answers when the cheap steps of the cascade come up empty.
        </p>
        <CliPicker
          providers={providers}
          providerId={providerId}
          modelId={modelId}
          refreshing={refreshing}
          loading={loading}
          onChange={onCliChange}
          onRefresh={onRefreshCli}
        />
      </section>
    </div>
  )
}
