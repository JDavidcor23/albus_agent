interface ErrorBannerProps {
  message: string
}

/**
 * Shows IPC execution errors.
 *
 * When the failure is a missing Supabase env var it unfolds guided help — that
 * one is not a bug, it is setup the user has not done yet, and the message
 * alone does not say where to go.
 */
export function ErrorBanner({ message }: ErrorBannerProps): React.JSX.Element {
  /*
   * The variable NAMES are what identify this failure, and those are never
   * translated. The prose checks are a fallback and cover both languages,
   * because a message written before the switch can still be on screen.
   */
  const lower = message.toLowerCase()
  const isEnvError =
    message.includes('SUPABASE_URL') ||
    message.includes('SUPABASE_SERVICE_ROLE_KEY') ||
    lower.includes('environment variable') ||
    lower.includes('variables de entorno') ||
    lower.includes('missing env')

  return (
    <div className="error-banner">
      <div className="error-title">
        <span>⚠</span> the batch failed
      </div>
      <div className="error-message">{message}</div>

      {isEnvError && (
        <div className="env-help-box">
          <div className="env-help-header">One-time setup required (.env):</div>
          <ol className="env-help-list">
            <li>
              Copy <code>.env.example</code> to <code>.env</code> at the root of this project.
            </li>
            <li>
              Open the Supabase dashboard for your <strong>My Notes</strong> project.
            </li>
            <li>
              Go to <strong>Project Settings &gt; API Keys</strong>.
            </li>
            <li>
              Copy the <code>service_role</code> key (Secret Key) into{' '}
              <code>SUPABASE_SERVICE_ROLE_KEY</code>.
            </li>
          </ol>
        </div>
      )}
    </div>
  )
}
