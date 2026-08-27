import { useEffect, useState } from 'react'
import type { VideoRunSummary, VideoStepEvent } from '../../../shared/ipc'
import type { PanelProps } from './AgentsPanel'

/**
 * El agente de extracción de video.
 *
 * Un formulario y no un chat, al revés que `JobChat`: acá no hay nada que
 * negociar con un modelo. Se elige un archivo, se aprieta y se espera. Lo único
 * que el usuario decide es el modelo y el idioma.
 *
 * La barra de progreso no es adorno. Transcribir una hora de grabación son dos
 * horas de CPU: sin ver que algo avanza, cualquiera cierra la app a los diez
 * minutos convencido de que se colgó.
 */

const MODELS = [
  { id: 'small', label: 'small — recomendado' },
  { id: 'base', label: 'base — el doble de rápido, inventa palabras' },
  { id: 'medium', label: 'medium — mejor, mucho más lento' }
] as const

type Model = (typeof MODELS)[number]['id']

/** Cuánto tarda, en criollo. `small` mide ~2,1x tiempo real en CPU. */
function estimate(stage: VideoStepEvent['stage']): string {
  if (stage === 'transcribe') return 'lo más lento: contá unas dos horas por hora de grabación'
  if (stage === 'extract') return 'una sola pasada por el archivo'
  if (stage === 'filter') return 'midiendo el volumen de cada línea'
  return ''
}

export function VideoPanel({ onError }: PanelProps): React.JSX.Element {
  const [path, setPath] = useState<string | null>(null)
  const [model, setModel] = useState<Model>('small')
  const [language, setLanguage] = useState('Spanish')
  const [step, setStep] = useState<VideoStepEvent | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<VideoRunSummary | null>(null)

  // Devuelve la baja: sin esto el StrictMode deja dos handlers y todo se duplica.
  useEffect(() => window.api.onVideoStep(setStep), [])

  const pick = async (): Promise<void> => {
    onError(null)
    const res = await window.api.pickVideo()
    if (!res.ok) {
      onError(res.error.message)
      return
    }
    // Cancelar deja lo que ya estaba elegido; borrarlo sería castigar el arrepentimiento.
    if (res.data.path !== null) {
      setPath(res.data.path)
      setResult(null)
      setStep(null)
    }
  }

  const run = async (): Promise<void> => {
    if (path === null) return

    onError(null)
    setRunning(true)
    setResult(null)
    try {
      const res = await window.api.runVideo({ path, model, language })
      if (res.ok) setResult(res.data)
      else onError(res.error.message)
    } finally {
      setRunning(false)
      setStep(null)
    }
  }

  const open = async (target: string): Promise<void> => {
    onError(null)
    const res = await window.api.openVideoOutput(target)
    if (!res.ok) onError(res.error.message)
  }

  const fileName = path?.split(/[\\/]/).pop() ?? null

  return (
    <div className="video">
      <div className="video-pick">
        <button type="button" className="reglas-editar" onClick={() => void pick()} disabled={running}>
          {path === null ? 'choose a recording' : 'choose another'}
        </button>
        {fileName !== null && <span className="video-file">{fileName}</span>}
      </div>

      <div className="video-opts">
        <label className="video-opt">
          <span>model</span>
          <select
            value={model}
            disabled={running}
            onChange={(e) => setModel(e.target.value as Model)}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <label className="video-opt">
          <span>language</span>
          <input
            value={language}
            disabled={running}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="Spanish"
          />
        </label>

        <button
          type="button"
          className="reglas-editar"
          disabled={running || path === null}
          onClick={() => void run()}
        >
          {running ? 'working…' : 'process'}
        </button>
      </div>

      {running && (
        <div className="video-progress">
          <div className="video-stage">{step?.label ?? 'starting…'}</div>
          {step !== null && step.total > 0 && (
            <>
              <div className="video-bar">
                <div className="video-bar-fill" style={{ width: `${(step.done / step.total) * 100}%` }} />
              </div>
              <div className="video-count">
                {step.done} / {step.total}
              </div>
            </>
          )}
          {step !== null && estimate(step.stage) !== '' && (
            <div className="video-hint">{estimate(step.stage)}</div>
          )}
        </div>
      )}

      {result !== null && (
        <div className="video-done">
          <p className="video-done-title">
            {result.cues} lines · {result.frames} screenshots
          </p>

          {/*
            Lo descartado se MUESTRA, no se esconde.

            Es la prueba de que el filtro de alucinaciones corrió. Y un cero en
            una grabación larga no quiere decir "salió limpio": quiere decir que
            conviene mirar el umbral.
          */}
          <p className="video-done-sub">
            {result.droppedCues} made-up line{result.droppedCues === 1 ? '' : 's'} dropped —
            whisper writes text over silence, so those are gaps on purpose
          </p>

          {result.failedChunks > 0 && (
            <p className="video-warn">
              {result.failedChunks} chunk{result.failedChunks === 1 ? '' : 's'} failed — the
              transcript has a hole that is NOT silence
            </p>
          )}

          <div className="video-actions">
            <button type="button" className="reglas-editar" onClick={() => void open(result.pagePath)}>
              open the page
            </button>
            <button type="button" className="reglas-editar" onClick={() => void open(result.outDir)}>
              open the folder
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
