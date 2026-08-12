export type View = 'chat' | 'extractions' | 'graph' | 'tasks' | 'settings'

interface Props {
  view: View
  onView: (v: View) => void
  providerId: string | null
  modelId: string | null
  total: number
}

/** The secondary group. Reachable, but visibly lighter than the conversation. */
const SECONDARY: { id: View; label: string }[] = [
  { id: 'extractions', label: 'Extractions' },
  { id: 'graph', label: 'Graph' },
  { id: 'tasks', label: 'Tasks' }
]

/**
 * Identity plus navigation.
 *
 * The conversation is the app; everything else is somewhere you go when you
 * need it. These three stay in the rail on purpose — the logic that would
 * offer them from inside the conversation is a separate project, and without
 * it they would simply be unreachable.
 */
export function Rail({ view, onView, providerId, modelId, total }: Props): React.JSX.Element {
  return (
    <aside className="panel-left">
      <div>
        <h1 className="brand-title">Albus</h1>
        <div className="brand-subtitle">your agents, one conversation</div>

        <nav className="rail-nav">
          <button
            type="button"
            data-view="chat"
            className={`rail-item rail-item-main ${view === 'chat' ? 'rail-item-on' : ''}`}
            onClick={() => onView('chat')}
          >
            Chat
          </button>

          <div className="rail-group">
            {SECONDARY.map((s) => (
              <button
                key={s.id}
                type="button"
                data-view={s.id}
                className={`rail-item ${view === s.id ? 'rail-item-on' : ''}`}
                onClick={() => onView(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </nav>
      </div>

      <div className="rail-foot">
        {/*
          The active engine, read-only. It is configured in Settings, but you
          should not have to open Settings just to know what is answering.
        */}
        <button
          type="button"
          data-view="settings"
          className={`rail-item rail-status ${view === 'settings' ? 'rail-item-on' : ''}`}
          onClick={() => onView('settings')}
        >
          <span className="rail-status-line">{providerId ?? 'no CLI'}</span>
          <span className="rail-status-sub">{modelId ?? '—'}</span>
          <span className="rail-status-gear">Settings</span>
        </button>

        <div className="footer-meta">
          {total > 0 ? `${total} extracted` : 'albus agent // local worker'}
        </div>
      </div>
    </aside>
  )
}
