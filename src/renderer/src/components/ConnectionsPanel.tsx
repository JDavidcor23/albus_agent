import { useCallback, useEffect, useState } from 'react'
import type { ConnectionInfo, ConnectionStepRow } from '../../../shared/ipc'

/**
 * Conectar servicios sin abrir la terminal ni editar archivos.
 *
 * Conectar es un proceso LARGO: se abre un navegador, se navega una SPA ajena,
 * a veces hay que entrar a mano. Por eso la tarjeta muestra cada paso mientras
 * ocurre, con la captura de lo que Albus estaba viendo. Un botón que se queda
 * en "conectando…" dos minutos y después dice "falló" no le sirve a nadie: no
 * se distingue de un cuelgue, y no se puede arreglar lo que no se ve.
 *
 * El token se manda al main y no vuelve nunca. Acá sabemos SI hay, no cuál.
 */

interface Props {
  onChange: () => void
  onError: (m: string | null) => void
}

export function ConnectionsPanel({ onChange, onError }: Props): React.JSX.Element {
  const [connections, setConnections] = useState<ConnectionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  /** Los pasos de cada servicio, en orden. Se limpian al reintentar. */
  const [steps, setSteps] = useState<Record<string, ConnectionStepRow[]>>({})

  // Los pasos llegan por evento, no por la respuesta del invoke: esa no vuelve
  // hasta que todo terminó. La desuscripción es obligatoria — sin ella el
  // StrictMode de React monta el handler dos veces y todo sale duplicado.
  useEffect(() => {
    return window.api.onConnectionStep((p) => {
      setSteps((prev) => ({ ...prev, [p.id]: [...(prev[p.id] ?? []), p] }))
    })
  }, [])

  const load = useCallback((): void => {
    void window.api.listConnections().then((res) => {
      setLoading(false)
      if (res.ok) setConnections(res.data)
      else onError(res.error.message)
    })
  }, [onError])

  useEffect(load, [load])

  const apply = (list: ConnectionInfo[], message: string): void => {
    setConnections(list)
    setNotice(message)
    onChange()
  }

  const connectViaBrowser = async (c: ConnectionInfo): Promise<void> => {
    onError(null)
    setNotice(null)
    // Los pasos del intento anterior se van: mezclarlos con los nuevos hace
    // que el usuario lea como actual un error que ya no está pasando.
    setSteps((p) => ({ ...p, [c.id]: [] }))
    setBusy(c.id)
    try {
      const res = await window.api.connectWithBrowser(c.id)
      if (res.ok) apply(res.data.connections, res.data.message)
      else onError(res.error.message)
    } finally {
      setBusy(null)
    }
  }

  const saveToken = async (c: ConnectionInfo): Promise<void> => {
    const token = (drafts[c.id] ?? '').trim()
    if (token.length < 8) {
      onError('that token is too short')
      return
    }

    onError(null)
    setNotice(null)
    setBusy(c.id)
    try {
      const res = await window.api.connectWithToken(c.id, token)
      if (res.ok) {
        // El campo se vacía apenas se guarda: no queda el secreto colgado en
        // el estado de React ni visible en pantalla.
        setDrafts((p) => ({ ...p, [c.id]: '' }))
        apply(res.data.connections, res.data.message)
      } else {
        onError(res.error.message)
      }
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async (c: ConnectionInfo): Promise<void> => {
    setBusy(c.id)
    try {
      const res = await window.api.disconnect(c.id)
      if (res.ok) apply(res.data.connections, `${c.name} disconnected`)
      else onError(res.error.message)
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <p className="cli-hint">loading connections…</p>

  /*
    Una tarjeta por CUENTA, no por mecanismo.
    Google salía dos veces —el token de API y la sesión del navegador— y para
    quien mira es una sola cuenta con dos permisos. Se agrupan conservando el
    orden en que el main los declaró: ese orden es intencional.
  */
  const groups: { group: string; name: string; members: ConnectionInfo[] }[] = []
  for (const c of connections) {
    const existing = groups.find((g) => g.group === c.group)
    if (existing === undefined) groups.push({ group: c.group, name: c.name, members: [c] })
    else existing.members.push(c)
  }

  return (
    <div className="conexiones">
      {notice !== null && <p className="conexion-aviso">{notice}</p>}

      {groups.map((g) => (
        <div key={g.group} className="conexion-grupo">
          {g.members.length > 1 && (
            <div className="conexion-grupo-head">
              <span
                className={`conexion-punto ${
                  g.members.every((m) => m.connected) ? 'conexion-punto-on' : ''
                }`}
              />
              <span className="conexion-nombre">{g.name}</span>
              <span className="conexion-grupo-cuenta">
                {g.members.filter((m) => m.connected).length}/{g.members.length} permissions
              </span>
            </div>
          )}

          {g.members.map((c) => (
        <div
          key={c.id}
          className={`conexion ${c.connected ? 'conexion-on' : ''} ${
            g.members.length > 1 ? 'conexion-hija' : ''
          }`}
        >
          <div className="conexion-head">
            {g.members.length === 1 && (
              <span className={`conexion-punto ${c.connected ? 'conexion-punto-on' : ''}`} />
            )}
            <span className="conexion-nombre">
              {g.members.length > 1 ? c.capability : c.name}
            </span>
            {/*
              De dónde sale la credencial. No es un detalle de implementación:
              es la diferencia entre arreglar algo en diez segundos y no
              entender por qué la app usa un token que ya cambiaste.
            */}
            {c.connected && c.source !== 'none' && (
              <span className="conexion-origen">
                {c.source === 'yml' ? 'albus.yml' : c.source === 'env' ? 'from .env' : 'saved'}
              </span>
            )}
            {c.connected && (
              <button
                type="button"
                className="conexion-quitar"
                disabled={busy === c.id || c.source === 'env'}
                title={c.source === 'env' ? 'it lives in .env: remove it from there' : ''}
                onClick={() => void disconnect(c)}
              >
                disconnect
              </button>
            )}
          </div>

          <p className="conexion-para">{c.purpose}</p>
          {!c.connected && c.detail !== '' && <p className="conexion-detalle">{c.detail}</p>}
          {c.connected && c.detail !== '' && <p className="conexion-detalle">{c.detail}</p>}

          {!c.connected && (
            <>
              {/*
                La vía por navegador es SIEMPRE la principal: se abre una
                ventana, entrás con tu usuario y clave, y Albus hace el resto.
                Pegar un token es la red de contención para cuando el servicio
                cambie su pantalla, no el camino normal.
              */}
              {c.methods.includes('browser') && (
                <div className="conexion-acciones">
                  <button
                    type="button"
                    className="btn-conectar"
                    disabled={busy === c.id}
                    onClick={() => void connectViaBrowser(c)}
                  >
                    {busy === c.id ? 'opening the browser…' : `connect ${c.name}`}
                  </button>
                  <span className="conexion-como">
                    a window opens · you sign in · Albus does the rest
                  </span>
                </div>
              )}

              {c.methods.includes('token') && (
                <details className="conexion-manual">
                  <summary>
                    {c.methods.includes('browser')
                      ? 'or paste the token by hand'
                      : 'paste the token'}
                  </summary>
                  <div className="conexion-acciones">
                    <button
                      type="button"
                      className="btn-ghost conexion-donde"
                      onClick={() => void window.api.openTokenPage(c.id)}
                    >
                      open where it is ↗
                    </button>
                    <input
                      className="job-input conexion-input"
                      type="password"
                      placeholder="paste the token here"
                      value={drafts[c.id] ?? ''}
                      onChange={(e) => setDrafts((p) => ({ ...p, [c.id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveToken(c)
                      }}
                    />
                    <button
                      type="button"
                      className="btn-conectar"
                      disabled={busy === c.id || (drafts[c.id] ?? '').trim().length < 8}
                      onClick={() => void saveToken(c)}
                    >
                      save
                    </button>
                  </div>
                </details>
              )}
            </>
          )}

          {/*
            El log en vivo. Va DESPUÉS de las acciones y antes del aviso de
            cifrado porque se lee de arriba hacia abajo: primero qué apretar,
            después qué está pasando.
          */}
          {(steps[c.id]?.length ?? 0) > 0 && (
            <ol className="conexion-pasos">
              {steps[c.id].map((p, i) => (
                <li key={i} className={p.ok ? 'paso-ok' : 'paso-falla'}>
                  <span className="paso-marca">{p.ok ? '✓' : '✕'}</span>
                  <div className="paso-cuerpo">
                    <span className="paso-nombre">{p.step}</span>
                    {p.detail !== '' && <span className="paso-detalle">{p.detail}</span>}
                    {/*
                      La captura viene como data: — no como ruta. El CSP del
                      renderer es `img-src 'self' data:` y un file:// se
                      bloquea sin decir por qué.
                    */}
                    {p.screenshot !== undefined && (
                      <img className="paso-captura" src={p.screenshot} alt={`screen: ${p.step}`} />
                    )}
                  </div>
                </li>
              ))}
              {busy === c.id && (
                <li className="paso-corriendo">
                  <span className="paso-marca">·</span>
                  <div className="paso-cuerpo">
                    <span className="paso-nombre">working…</span>
                  </div>
                </li>
              )}
            </ol>
          )}

          {!c.encryptionAvailable && c.methods.includes('token') && (
            <p className="conexion-detalle">
              this system offers no encryption: the token stays in plain text in albus.yml
            </p>
          )}
        </div>
          ))}
        </div>
      ))}
    </div>
  )
}
