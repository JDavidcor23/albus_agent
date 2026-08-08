import { useCallback, useEffect, useState } from 'react'
import type {
  HuntProgress,
  HuntResult,
  JobApplyResult,
  JobsStatus,
  RankedJobRow
} from '../../../shared/ipc'
import { ConnectionsPanel } from './ConnectionsPanel'

/**
 * El agente de búsqueda de trabajo.
 *
 * ## Lo que se sacó, y por qué
 *
 * **`dry-run` / `review` / `auto`.** Eran los nombres internos del freno de
 * envío puestos en pantalla. "dry-run" no significa nada para nadie que no
 * haya escrito el código. El freno sigue existiendo —es lo que evita que se
 * mande una postulación sin que la mires— pero ahora está adentro de la
 * acción: "postular con IA" llena todo y te muestra el formulario para que
 * aprietes enviar. No es una opción a elegir, es cómo funciona.
 *
 * **"Últimos días".** El usuario tenía razón: si vas a buscar trabajo, buscás
 * trabajo. Cuántos días hay que mirar para juntar un lote decente es problema
 * del programa, no una perilla. Se arranca por lo fresco y se amplía solo.
 *
 * Lo que queda en pantalla es lo único que él realmente decide: qué buscar y
 * dónde.
 */

interface Props {
  providerId: string | null
  modelId: string | null
  onError: (mensaje: string | null) => void
}

const QUERIES_INICIALES = 'frontend developer, react developer, full stack developer'

export function JobAgent({ providerId, modelId, onError }: Props): React.JSX.Element {
  const [status, setStatus] = useState<JobsStatus | null>(null)
  const [verConexiones, setVerConexiones] = useState(false)
  const [queries, setQueries] = useState(QUERIES_INICIALES)
  const [location, setLocation] = useState('Colombia')
  const [buscando, setBuscando] = useState(false)
  const [progreso, setProgreso] = useState<HuntProgress | null>(null)
  const [resultado, setResultado] = useState<HuntResult | null>(null)
  const [ocupada, setOcupada] = useState<string | null>(null)
  const [kitProg, setKitProg] = useState<Record<string, string>>({})
  const [aplicadas, setAplicadas] = useState<Record<string, JobApplyResult>>({})
  const [verDescartadas, setVerDescartadas] = useState(false)

  const refrescarStatus = useCallback((): void => {
    void window.api.jobsStatus().then((res) => {
      if (res.ok) setStatus(res.data)
    })
  }, [])

  useEffect(() => {
    refrescarStatus()
    const offHunt = window.api.onHuntProgress(setProgreso)
    const offKit = window.api.onKitProgress((p) =>
      setKitProg((prev) => ({ ...prev, [p.id]: p.linea }))
    )
    return () => {
      offHunt()
      offKit()
    }
  }, [refrescarStatus])

  const buscar = async (): Promise<void> => {
    if (providerId === null) {
      onError('no hay CLI para puntuar las vacantes')
      return
    }

    onError(null)
    setBuscando(true)
    setResultado(null)
    setProgreso(null)

    try {
      const res = await window.api.jobsHunt({
        queries: queries
          .split(',')
          .map((q) => q.trim())
          .filter((q) => q.length >= 2),
        location,
        maxRank: 12,
        guardarEnNotion: status?.notionReady ?? false,
        providerId,
        modelId
      })

      if (res.ok) setResultado(res.data)
      else onError(res.error.message)
    } finally {
      setBuscando(false)
      setProgreso(null)
    }
  }

  const marcarConKit = (id: string): void =>
    setResultado((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            califican: prev.califican.map((j) => (j.id === id ? { ...j, kitReady: true } : j))
          }
    )

  /**
   * Un solo botón hace el camino entero: si falta el CV lo arma, y después
   * postula. Que el CV exista o no es un detalle del workspace, no algo que
   * el usuario tenga que ir resolviendo paso por paso.
   */
  const postularConIa = async (j: RankedJobRow): Promise<void> => {
    onError(null)
    setOcupada(j.id)

    try {
      if (!j.kitReady) {
        setKitProg((p) => ({ ...p, [j.id]: 'armando tu CV para esta vacante…' }))
        const kit = await window.api.jobsKit({
          id: j.id,
          url: j.url,
          company: j.company,
          role: j.title,
          slug: j.slug
        })

        if (!kit.ok) {
          onError(kit.error.message)
          return
        }
        if (!kit.data.ok) {
          setKitProg((p) => ({ ...p, [j.id]: `no pude armar el CV: ${kit.data.mensaje}` }))
          return
        }
        marcarConKit(j.id)
        setKitProg((p) => ({ ...p, [j.id]: 'CV listo, llenando el formulario…' }))
      }

      const res = await window.api.jobsApply({
        url: j.url,
        company: j.company,
        role: j.title,
        slug: j.slug,
        // El freno vive acá adentro, no en una perilla: se llena todo y se
        // frena antes de enviar, siempre.
        mode: 'review',
        fitRating: String(j.score),
        jobDescription: j.description,
        providerId,
        modelId
      })

      if (res.ok) setAplicadas((prev) => ({ ...prev, [j.id]: res.data }))
      else onError(res.error.message)
    } finally {
      setOcupada(null)
    }
  }

  const faltan = status?.faltantes ?? []

  return (
    <div className="job-agent">
      <div className="job-form">
        <label className="job-field">
          <span className="job-label">qué buscar</span>
          <input
            className="job-input"
            value={queries}
            onChange={(e) => setQueries(e.target.value)}
            placeholder="frontend developer, react developer"
          />
        </label>

        <label className="job-field job-field-corto">
          <span className="job-label">dónde</span>
          <input
            className="job-input"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </label>

        <button
          type="button"
          className="btn-brass"
          disabled={buscando}
          onClick={() => void buscar()}
        >
          {buscando ? 'buscando…' : 'buscame trabajos'}
        </button>

        {/*
          El botón dice SIEMPRE "conexiones".
          Antes cambiaba de nombre según lo que faltara —"conectar (Notion ·
          Google)"— y eso rompe lo único que un botón tiene que hacer: estar
          siempre en el mismo lugar diciendo lo mismo. Lo que falta es ESTADO,
          y el estado va en un contador al lado, no en la etiqueta.
        */}
        <button
          type="button"
          className={`job-conexiones-btn ${faltan.length > 0 ? 'job-conexiones-falta' : ''}`}
          onClick={() => setVerConexiones(!verConexiones)}
          title={faltan.length > 0 ? `sin conectar: ${faltan.join(' · ')}` : 'todo conectado'}
        >
          conexiones
          <span className="job-conexiones-estado">{faltan.length > 0 ? faltan.length : '✓'}</span>
        </button>
      </div>

      {verConexiones && <ConnectionsPanel onCambio={refrescarStatus} onError={onError} />}

      {progreso !== null && (
        <p className="processing-hint">
          {progreso.fase}: {progreso.detalle}
        </p>
      )}

      {resultado !== null && (
        <>
          <div className="job-resumen">
            <span className="job-resumen-num">{resultado.califican.length}</span>
            <span className="job-resumen-txt">{resultado.resumen}</span>
          </div>

          {resultado.notionError !== null && (
            <p className="cli-hint">Notion no se actualizó: {resultado.notionError}</p>
          )}
          {resultado.notionEscritas > 0 && (
            <p className="cli-hint">{resultado.notionEscritas} fila(s) escritas en Notion</p>
          )}

          <div className="job-lista">
            {resultado.califican.map((j) => (
              <JobCard
                key={j.id}
                job={j}
                ocupada={ocupada === j.id}
                bloqueada={ocupada !== null && ocupada !== j.id}
                kitLinea={kitProg[j.id] ?? null}
                resultado={aplicadas[j.id] ?? null}
                onPostular={() => void postularConIa(j)}
              />
            ))}
          </div>

          {resultado.descartadas.length > 0 && (
            <>
              <button
                type="button"
                className="task-toggle"
                onClick={() => setVerDescartadas(!verDescartadas)}
              >
                {verDescartadas ? 'ocultar' : 'ver'} las {resultado.descartadas.length} que
                descarté
              </button>
              {verDescartadas && (
                <div className="job-lista job-lista-tenue">
                  {resultado.descartadas.map((j) => (
                    <div key={j.id} className="job-card job-card-off">
                      <div className="job-card-head">
                        <span className="job-score job-score-bajo">{j.score}</span>
                        <div className="job-card-titulo">
                          <span className="job-titulo">{j.title}</span>
                          <span className="job-empresa">{j.company}</span>
                        </div>
                      </div>
                      <p className="job-razon">
                        {j.gates.length > 0 && (
                          <span className="job-gate">{j.gates.join(' · ')}</span>
                        )}
                        {j.reason}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

/** Cuánto de la descripción se ve antes de tener que expandir. */
const RECORTE_DESC = 420

function JobCard({
  job,
  ocupada,
  bloqueada,
  kitLinea,
  resultado,
  onPostular
}: {
  job: RankedJobRow
  ocupada: boolean
  bloqueada: boolean
  kitLinea: string | null
  resultado: JobApplyResult | null
  onPostular: () => void
}): React.JSX.Element {
  const [abierta, setAbierta] = useState(false)
  const nivel = job.score >= 85 ? 'alto' : job.score >= 75 ? 'medio' : 'justo'

  const desc = job.description.trim()
  const larga = desc.length > RECORTE_DESC
  const visible = abierta || !larga ? desc : `${desc.slice(0, RECORTE_DESC).trimEnd()}…`

  return (
    <div className={`job-card job-card-${nivel}`}>
      <div className="job-card-head">
        <span className="job-score">{job.score}</span>
        <div className="job-card-titulo">
          <span className="job-titulo">{job.title}</span>
          <span className="job-empresa">
            {job.company} · {job.location}
          </span>
        </div>
        <span className="job-fecha">{job.date}</span>
      </div>

      {job.angle !== '' && <p className="job-angulo">{job.angle}</p>}

      {/*
        La descripción se lee acá. Antes había que abrir el navegador para
        saber de qué era la vacante, decidir, y volver.
      */}
      {desc !== '' ? (
        <>
          <p className="job-desc">{visible}</p>
          {larga && (
            <button type="button" className="job-desc-toggle" onClick={() => setAbierta(!abierta)}>
              {abierta ? 'menos' : 'leer la vacante completa'}
            </button>
          )}
        </>
      ) : (
        <p className="job-razon">{job.reason}</p>
      )}

      <div className="job-card-acciones">
        <button
          type="button"
          className="btn-accion btn-accion-fuerte"
          disabled={ocupada || bloqueada}
          onClick={onPostular}
        >
          {ocupada
            ? 'trabajando…'
            : job.kitReady
              ? 'postular con IA'
              : 'postular con IA (arma el CV)'}
        </button>

        <button
          type="button"
          className="btn-secundario"
          onClick={() => void window.api.openExternal(job.url)}
        >
          aplicar yo ↗
        </button>

        {job.kitReady && <span className="job-kit-ok">CV a medida listo</span>}
      </div>

      {kitLinea !== null && <p className="job-kit-linea">{kitLinea}</p>}

      {resultado !== null && (
        <div className="job-resultado">
          <strong className={`job-estado job-estado-${resultado.status}`}>
            {resultado.status === 'filled'
              ? 'formulario lleno'
              : resultado.status === 'submitted'
                ? 'enviada'
                : resultado.status}
          </strong>{' '}
          {resultado.message}
          {resultado.uploadedAs.length > 0 && (
            <div className="cli-hint">adjuntado como: {resultado.uploadedAs.join(', ')}</div>
          )}
          {resultado.unresolved.length > 0 && (
            <div className="cli-hint">
              completá a mano: {resultado.unresolved.slice(0, 5).join('; ')}
            </div>
          )}
          {resultado.notionError !== null && (
            <div className="cli-hint">Notion: {resultado.notionError}</div>
          )}
        </div>
      )}
    </div>
  )
}
