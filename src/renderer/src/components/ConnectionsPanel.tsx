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
  onCambio: () => void
  onError: (m: string | null) => void
}

export function ConnectionsPanel({ onCambio, onError }: Props): React.JSX.Element {
  const [conexiones, setConexiones] = useState<ConnectionInfo[]>([])
  const [cargando, setCargando] = useState(true)
  const [ocupado, setOcupado] = useState<string | null>(null)
  const [borradores, setBorradores] = useState<Record<string, string>>({})
  const [aviso, setAviso] = useState<string | null>(null)
  /** Los pasos de cada servicio, en orden. Se limpian al reintentar. */
  const [pasos, setPasos] = useState<Record<string, ConnectionStepRow[]>>({})

  // Los pasos llegan por evento, no por la respuesta del invoke: esa no vuelve
  // hasta que todo terminó. La desuscripción es obligatoria — sin ella el
  // StrictMode de React monta el handler dos veces y todo sale duplicado.
  useEffect(() => {
    return window.api.onConnectionStep((p) => {
      setPasos((prev) => ({ ...prev, [p.id]: [...(prev[p.id] ?? []), p] }))
    })
  }, [])

  const cargar = useCallback((): void => {
    void window.api.listConnections().then((res) => {
      setCargando(false)
      if (res.ok) setConexiones(res.data)
      else onError(res.error.message)
    })
  }, [onError])

  useEffect(cargar, [cargar])

  const aplicar = (lista: ConnectionInfo[], mensaje: string): void => {
    setConexiones(lista)
    setAviso(mensaje)
    onCambio()
  }

  const conectarNavegador = async (c: ConnectionInfo): Promise<void> => {
    onError(null)
    setAviso(null)
    // Los pasos del intento anterior se van: mezclarlos con los nuevos hace
    // que el usuario lea como actual un error que ya no está pasando.
    setPasos((p) => ({ ...p, [c.id]: [] }))
    setOcupado(c.id)
    try {
      const res = await window.api.connectWithBrowser(c.id)
      if (res.ok) aplicar(res.data.conexiones, res.data.mensaje)
      else onError(res.error.message)
    } finally {
      setOcupado(null)
    }
  }

  const guardarToken = async (c: ConnectionInfo): Promise<void> => {
    const token = (borradores[c.id] ?? '').trim()
    if (token.length < 8) {
      onError('ese token es muy corto')
      return
    }

    onError(null)
    setAviso(null)
    setOcupado(c.id)
    try {
      const res = await window.api.connectWithToken(c.id, token)
      if (res.ok) {
        // El campo se vacía apenas se guarda: no queda el secreto colgado en
        // el estado de React ni visible en pantalla.
        setBorradores((p) => ({ ...p, [c.id]: '' }))
        aplicar(res.data.conexiones, res.data.mensaje)
      } else {
        onError(res.error.message)
      }
    } finally {
      setOcupado(null)
    }
  }

  const desconectar = async (c: ConnectionInfo): Promise<void> => {
    setOcupado(c.id)
    try {
      const res = await window.api.disconnect(c.id)
      if (res.ok) aplicar(res.data.conexiones, `${c.nombre} desconectado`)
      else onError(res.error.message)
    } finally {
      setOcupado(null)
    }
  }

  if (cargando) return <p className="cli-hint">cargando conexiones…</p>

  /*
    Una tarjeta por CUENTA, no por mecanismo.
    Google salía dos veces —el token de API y la sesión del navegador— y para
    quien mira es una sola cuenta con dos permisos. Se agrupan conservando el
    orden en que el main los declaró: ese orden es intencional.
  */
  const grupos: { grupo: string; nombre: string; miembros: ConnectionInfo[] }[] = []
  for (const c of conexiones) {
    const ya = grupos.find((g) => g.grupo === c.grupo)
    if (ya === undefined) grupos.push({ grupo: c.grupo, nombre: c.nombre, miembros: [c] })
    else ya.miembros.push(c)
  }

  return (
    <div className="conexiones">
      {aviso !== null && <p className="conexion-aviso">{aviso}</p>}

      {grupos.map((g) => (
        <div key={g.grupo} className="conexion-grupo">
          {g.miembros.length > 1 && (
            <div className="conexion-grupo-head">
              <span
                className={`conexion-punto ${
                  g.miembros.every((m) => m.conectado) ? 'conexion-punto-on' : ''
                }`}
              />
              <span className="conexion-nombre">{g.nombre}</span>
              <span className="conexion-grupo-cuenta">
                {g.miembros.filter((m) => m.conectado).length}/{g.miembros.length} permisos
              </span>
            </div>
          )}

          {g.miembros.map((c) => (
        <div
          key={c.id}
          className={`conexion ${c.conectado ? 'conexion-on' : ''} ${
            g.miembros.length > 1 ? 'conexion-hija' : ''
          }`}
        >
          <div className="conexion-head">
            {g.miembros.length === 1 && (
              <span className={`conexion-punto ${c.conectado ? 'conexion-punto-on' : ''}`} />
            )}
            <span className="conexion-nombre">
              {g.miembros.length > 1 ? c.capacidad : c.nombre}
            </span>
            {/*
              De dónde sale la credencial. No es un detalle de implementación:
              es la diferencia entre arreglar algo en diez segundos y no
              entender por qué la app usa un token que ya cambiaste.
            */}
            {c.conectado && c.origen !== 'ninguno' && (
              <span className="conexion-origen">
                {c.origen === 'yml' ? 'albus.yml' : c.origen === 'env' ? 'desde .env' : 'guardado'}
              </span>
            )}
            {c.conectado && (
              <button
                type="button"
                className="conexion-quitar"
                disabled={ocupado === c.id || c.origen === 'env'}
                title={c.origen === 'env' ? 'está en el .env: sacalo de ahí' : ''}
                onClick={() => void desconectar(c)}
              >
                desconectar
              </button>
            )}
          </div>

          <p className="conexion-para">{c.paraQue}</p>
          {!c.conectado && c.detalle !== '' && <p className="conexion-detalle">{c.detalle}</p>}
          {c.conectado && c.detalle !== '' && <p className="conexion-detalle">{c.detalle}</p>}

          {!c.conectado && (
            <>
              {/*
                La vía por navegador es SIEMPRE la principal: se abre una
                ventana, entrás con tu usuario y clave, y Albus hace el resto.
                Pegar un token es la red de contención para cuando el servicio
                cambie su pantalla, no el camino normal.
              */}
              {c.vias.includes('navegador') && (
                <div className="conexion-acciones">
                  <button
                    type="button"
                    className="btn-conectar"
                    disabled={ocupado === c.id}
                    onClick={() => void conectarNavegador(c)}
                  >
                    {ocupado === c.id ? 'abriendo el navegador…' : `conectar ${c.nombre}`}
                  </button>
                  <span className="conexion-como">
                    se abre una ventana · entrás vos · el resto lo hace Albus
                  </span>
                </div>
              )}

              {c.vias.includes('token') && (
                <details className="conexion-manual">
                  <summary>
                    {c.vias.includes('navegador')
                      ? 'o pegá el token a mano'
                      : 'pegá el token'}
                  </summary>
                  <div className="conexion-acciones">
                    <button
                      type="button"
                      className="btn-ghost conexion-donde"
                      onClick={() => void window.api.openTokenPage(c.id)}
                    >
                      abrir dónde está ↗
                    </button>
                    <input
                      className="job-input conexion-input"
                      type="password"
                      placeholder="pegá el token acá"
                      value={borradores[c.id] ?? ''}
                      onChange={(e) => setBorradores((p) => ({ ...p, [c.id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void guardarToken(c)
                      }}
                    />
                    <button
                      type="button"
                      className="btn-conectar"
                      disabled={ocupado === c.id || (borradores[c.id] ?? '').trim().length < 8}
                      onClick={() => void guardarToken(c)}
                    >
                      guardar
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
          {(pasos[c.id]?.length ?? 0) > 0 && (
            <ol className="conexion-pasos">
              {pasos[c.id].map((p, i) => (
                <li key={i} className={p.ok ? 'paso-ok' : 'paso-falla'}>
                  <span className="paso-marca">{p.ok ? '✓' : '✕'}</span>
                  <div className="paso-cuerpo">
                    <span className="paso-nombre">{p.paso}</span>
                    {p.detalle !== '' && <span className="paso-detalle">{p.detalle}</span>}
                    {/*
                      La captura viene como data: — no como ruta. El CSP del
                      renderer es `img-src 'self' data:` y un file:// se
                      bloquea sin decir por qué.
                    */}
                    {p.captura !== undefined && (
                      <img className="paso-captura" src={p.captura} alt={`pantalla: ${p.paso}`} />
                    )}
                  </div>
                </li>
              ))}
              {ocupado === c.id && (
                <li className="paso-corriendo">
                  <span className="paso-marca">·</span>
                  <div className="paso-cuerpo">
                    <span className="paso-nombre">trabajando…</span>
                  </div>
                </li>
              )}
            </ol>
          )}

          {!c.cifradoDisponible && c.vias.includes('token') && (
            <p className="conexion-detalle">
              este sistema no ofrece cifrado: el token queda en texto plano en albus.yml
            </p>
          )}
        </div>
          ))}
        </div>
      ))}
    </div>
  )
}
