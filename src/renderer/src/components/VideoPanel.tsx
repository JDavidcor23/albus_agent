import { useCallback, useEffect, useState } from 'react'
import type { TranscriptEntry, VideoRunSummary, VideoStepEvent } from '../../../shared/ipc'
import type { PanelProps } from './AgentsPanel'

/**
 * The video extraction agent.
 *
 * A form and not a chat, unlike `JobChat`: there is nothing to negotiate with a
 * model here. You pick a file, press, and wait. The only things the user decides
 * are the model, the language and what to call the result.
 *
 * The progress bar is not decoration. Transcribing an hour of recording is hours
 * of CPU: without seeing something move, anyone closes the app after ten minutes
 * convinced it hung.
 *
 * ## Why the library is on this same screen
 *
 * Because a transcript that cannot be found again was not saved, it was only
 * produced. The run form answers "make me one"; the list answers "where are the
 * ones I already made" — and that second question is the one that comes up on
 * every single opening after the first.
 */

const MODELS = [
  { id: 'small', label: 'small — recommended' },
  { id: 'base', label: 'base — twice as fast, makes up words' },
  { id: 'medium', label: 'medium — better, much slower' }
] as const

type Model = (typeof MODELS)[number]['id']

/** How long it takes, in plain words. `small` measures ~1x real time in chunks. */
function estimate(stage: VideoStepEvent['stage']): string {
  if (stage === 'transcribe') return 'the slow part: roughly one minute per minute of recording'
  if (stage === 'extract') return 'a single pass over the file'
  if (stage === 'filter') return 'measuring the volume of every line'
  return ''
}

function humanDuration(seconds: number): string {
  if (seconds <= 0) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * The date, in the viewer's locale.
 *
 * An unreadable `createdAt` renders as a dash rather than `Invalid Date`: this
 * string comes off the user's disk and they are allowed to have hand-edited it.
 */
function humanDate(iso: string): string {
  if (iso === '') return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleString()
}

/**
 * One row of the library, with its title editable in place.
 *
 * Editing happens on the row and not in a modal because renaming is the most
 * frequent thing anyone does here, and it is worth exactly one click.
 */
function TranscriptRow({
  row,
  onRename,
  onOpen
}: {
  row: TranscriptEntry
  onRename: (id: string, title: string) => Promise<void>
  onOpen: (path: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.title)
  const [saving, setSaving] = useState(false)

  /*
   * The draft follows the row while the field is CLOSED.
   *
   * Without the `editing` guard, a refresh of the library mid-edit would throw
   * away what the user is typing. Losing someone's keystrokes to a background
   * reload is the kind of bug people never report and never forgive.
   */
  useEffect(() => {
    if (!editing) setDraft(row.title)
  }, [row.title, editing])

  const commit = async (): Promise<void> => {
    setSaving(true)
    try {
      await onRename(row.id, draft)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className="video-row">
      <div className="video-row-main">
        {editing ? (
          <div className="video-row-edit">
            <input
              autoFocus
              value={draft}
              disabled={saving}
              placeholder="name this transcript"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit()
                if (e.key === 'Escape') {
                  setDraft(row.title)
                  setEditing(false)
                }
              }}
            />
            <button type="button" className="reglas-editar" disabled={saving} onClick={() => void commit()}>
              {saving ? 'saving…' : 'save'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={`video-row-title${row.untitled ? ' video-row-untitled' : ''}`}
            title="rename"
            onClick={() => setEditing(true)}
          >
            {row.title}
          </button>
        )}

        <div className="video-row-meta">
          <span>{humanDate(row.createdAt)}</span>
          <span>{humanDuration(row.durationSeconds)}</span>
          <span>{row.cues} lines</span>
          {row.droppedCues > 0 && <span>{row.droppedCues} dropped</span>}
          {row.frames > 0 && <span>{row.frames} shots</span>}
          {row.model !== '' && <span>{row.model}</span>}
        </div>

        {/*
          The source recording is shown because the title is free text.
          Once someone renames this to "kickoff", the folder name is the only
          thing left tying it to a file on disk — and that is what they will
          search for when they want to re-run it.
        */}
        {row.sourceName !== '' && <div className="video-row-source">{row.sourceName}</div>}
      </div>

      <div className="video-row-actions">
        <button type="button" className="reglas-editar" onClick={() => onOpen(row.pagePath)}>
          page
        </button>
        <button type="button" className="reglas-editar" onClick={() => onOpen(row.textPath)}>
          text
        </button>
        <button type="button" className="reglas-editar" onClick={() => onOpen(row.dir)}>
          folder
        </button>
      </div>
    </li>
  )
}

export function VideoPanel({ onError }: PanelProps): React.JSX.Element {
  const [path, setPath] = useState<string | null>(null)
  const [model, setModel] = useState<Model>('small')
  const [language, setLanguage] = useState('Spanish')
  const [title, setTitle] = useState('')
  const [step, setStep] = useState<VideoStepEvent | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<VideoRunSummary | null>(null)
  const [library, setLibrary] = useState<TranscriptEntry[]>([])
  const [loading, setLoading] = useState(true)

  // Returns the unsubscribe: without it StrictMode leaves two handlers and everything doubles.
  useEffect(() => window.api.onVideoStep(setStep), [])

  const refresh = useCallback(async (): Promise<void> => {
    const res = await window.api.listTranscripts()
    setLoading(false)
    if (!res.ok) {
      onError(res.error.message)
      return
    }
    setLibrary(res.data.transcripts)
  }, [onError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const pick = async (): Promise<void> => {
    onError(null)
    const res = await window.api.pickVideo()
    if (!res.ok) {
      onError(res.error.message)
      return
    }
    // Cancelling keeps whatever was already picked; clearing it would punish second thoughts.
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
      const res = await window.api.runVideo({ path, model, language, title })
      if (res.ok) {
        setResult(res.data)
        // The title field is emptied only on success: a failed run keeps what was typed.
        setTitle('')
        await refresh()
      } else onError(res.error.message)
    } finally {
      setRunning(false)
      setStep(null)
    }
  }

  const rename = async (id: string, next: string): Promise<void> => {
    onError(null)
    const res = await window.api.renameTranscript(id, next)
    if (!res.ok) {
      onError(res.error.message)
      return
    }
    /*
     * Patch the one row instead of re-listing.
     *
     * The main process already returned the updated entry, and re-reading the
     * whole folder to learn one title would also re-sort the list under the
     * user's cursor right after they typed.
     */
    setLibrary((rows) => rows.map((r) => (r.id === res.data.transcript.id ? res.data.transcript : r)))
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
        <label className="video-opt video-opt-title">
          <span>title</span>
          <input
            value={title}
            disabled={running}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="optional — derived from the file name"
          />
        </label>

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
            {result.title} — {result.cues} lines · {result.frames} screenshots
          </p>

          {/*
            Dropped lines are SHOWN, not hidden.

            They are the proof the hallucination filter ran. And a zero on a long
            recording does not mean "came out clean": it means the threshold is
            worth a look.
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

      <div className="video-library">
        <div className="video-library-head">
          <h3>saved transcripts</h3>
          <span className="video-library-count">{library.length}</span>
          <button type="button" className="reglas-editar" onClick={() => void refresh()}>
            refresh
          </button>
        </div>

        {loading && <p className="video-empty">reading the folder…</p>}

        {/*
          An empty library says WHY it is empty.

          "No transcripts" on a first run reads like something is broken. Naming
          the action that fills it turns a dead end into an instruction.
        */}
        {!loading && library.length === 0 && (
          <p className="video-empty">
            nothing here yet — pick a recording above and the transcript lands in this list
          </p>
        )}

        {library.length > 0 && (
          <ul className="video-list">
            {library.map((row) => (
              <TranscriptRow key={row.id} row={row} onRename={rename} onOpen={(p) => void open(p)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
