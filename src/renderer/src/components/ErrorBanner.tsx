interface ErrorBannerProps {
  message: string
}

/**
 * Componente para mostrar errores de ejecución de IPC.
 * Si detecta falta de variables de entorno de Supabase, despliega ayuda guiada.
 */
export function ErrorBanner({ message }: ErrorBannerProps): React.JSX.Element {
  // Detecta si el error corresponde a la falta de variables de entorno
  const isEnvError =
    message.includes('SUPABASE_URL') ||
    message.includes('SUPABASE_SERVICE_ROLE_KEY') ||
    message.toLowerCase().includes('variables de entorno') ||
    message.toLowerCase().includes('missing env')

  return (
    <div className="error-banner">
      <div className="error-title">
        <span>⚠</span> error al procesar el lote
      </div>
      <div className="error-message">{message}</div>

      {isEnvError && (
        <div className="env-help-box">
          <div className="env-help-header">Configuración inicial requerida (.env):</div>
          <ol className="env-help-list">
            <li>
              Copiá el archivo <code>.env.example</code> a <code>.env</code> en la raíz de este proyecto.
            </li>
            <li>
              Abrí el dashboard de Supabase de tu proyecto <strong>My Notes</strong>.
            </li>
            <li>
              Navegá a <strong>Project Settings &gt; API Keys</strong>.
            </li>
            <li>
              Copiá la clave <code>service_role</code> (Secret Key) y asignala a <code>SUPABASE_SERVICE_ROLE_KEY</code>.
            </li>
          </ol>
        </div>
      )}
    </div>
  )
}
