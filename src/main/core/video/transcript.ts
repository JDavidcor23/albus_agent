/**
 * El transcript de una grabación: parsear, pegar tramos y tirar lo inventado.
 *
 * Dominio puro. No sabe de ffmpeg, de whisper ni de archivos: recibe texto y
 * números, devuelve texto y números. Lo que corre binarios vive en
 * `src/main/video/`.
 *
 * ## Por qué existe el rescate desde el log
 *
 * Whisper escribe los archivos RECIÉN AL TERMINAR. Una corrida de dos horas que
 * se muere a los 32 minutos no deja ni un `.srt` — pero fue imprimiendo cada
 * línea a stdout mientras avanzaba. Medido: de una corrida muerta se
 * recuperaron los 32 minutos que ya había hecho. Por eso `parseWhisperLog`.
 */

export interface Cue {
  /** Segundos desde el arranque del video. */
  start: number
  end: number
  text: string
}

/** Un cue con el volumen medido de su propia ventana de audio. */
export interface MeasuredCue extends Cue {
  /** `null` = no se pudo medir. Ante la duda se CONSERVA. */
  db: number | null
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** `HH:MM:SS,mmm`, el formato de SRT. */
export function stamp(seconds: number): string {
  const t = Math.max(seconds, 0)
  const whole = Math.floor(t)
  return (
    `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:` +
    `${pad(whole % 60)},${pad(Math.round((t - whole) * 1000), 3)}`
  )
}

/** `MM:SS`, para mostrarle a una persona. */
export function shortStamp(seconds: number): string {
  const whole = Math.floor(Math.max(seconds, 0))
  return `${pad(Math.floor(whole / 60))}:${pad(whole % 60)}`
}

function parseStamp(raw: string): number | null {
  const m = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(raw.trim())
  if (m === null) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
}

/**
 * Un `.srt`, corrido `offset` segundos.
 *
 * El offset es lo que permite transcribir por tramos: cada tramo sale con su
 * propia línea de tiempo arrancando en cero, y acá se lo devuelve a la línea de
 * tiempo del video entero.
 */
export function parseSrt(text: string, offset = 0): Cue[] {
  const out: Cue[] = []

  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim() !== '')
    const arrowAt = lines.findIndex((l) => l.includes('-->'))
    if (arrowAt === -1) continue

    const [rawStart, rawEnd] = lines[arrowAt].split('-->')
    const start = parseStamp(rawStart ?? '')
    const end = parseStamp(rawEnd ?? '')
    if (start === null || end === null) continue

    const body = lines.slice(arrowAt + 1).join(' ').trim()
    if (body !== '') out.push({ start: start + offset, end: end + offset, text: body })
  }

  return out
}

/**
 * La salida de CONSOLA de whisper: `[MM:SS.mmm --> MM:SS.mmm]  texto`.
 *
 * Pasada la hora whisper imprime `HH:MM:SS.mmm`, así que el grupo de horas es
 * opcional. Todo lo que no matchee —warnings, barras de progreso— se saltea.
 */
export function parseWhisperLog(text: string, offset = 0): Cue[] {
  const LINE =
    /^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\.(\d{3})\s*-->\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\.(\d{3})\]\s*(.*)$/

  const seconds = (a: string, b: string, c: string | undefined, ms: string): number =>
    (c === undefined
      ? Number(a) * 60 + Number(b)
      : Number(a) * 3600 + Number(b) * 60 + Number(c)) + Number(ms) / 1000

  const out: Cue[] = []
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw.trim())
    if (m === null) continue

    const body = m[9].trim()
    if (body === '') continue

    out.push({
      start: seconds(m[1], m[2], m[3], m[4]) + offset,
      end: seconds(m[5], m[6], m[7], m[8]) + offset,
      text: body
    })
  }

  return out
}

/**
 * Pega lo rescatado de un log con los tramos transcriptos después.
 *
 * El solape se resuelve por tiempo y **manda el tramo**: se reanuda desde el
 * arranque del último cue del log, así que ese cue está en los dos lados. Si
 * ganara el log quedaría cortado a la mitad.
 */
export function mergeCues(head: Cue[], tail: Cue[], resumeAt: number): Cue[] {
  return [...head.filter((c) => c.start < resumeAt), ...tail].sort((a, b) => a.start - b.start)
}

/**
 * Saca los cues que whisper inventó sobre el silencio.
 *
 * ## El problema
 *
 * Si la grabación sigue corriendo después de que la reunión terminó, whisper no
 * escribe silencio: escribe TEXTO. Lo que salió en una grabación real, sobre
 * diez minutos de sala vacía: cues de exactamente un segundo con muletillas
 * ("¿Conoce? / Sí. / Ok. / Ok. / Ahhhh."), "Gracias" cuatro veces, y frases con
 * caracteres de otro alfabeto. Un transcript con texto inventado es PEOR que
 * uno con huecos: el que lo lee no puede distinguir lo real de lo alucinado.
 *
 * ## Por qué el volumen por cue y no `silencedetect`
 *
 * Se probó `silencedetect` global y se lleva puesta el habla baja REAL junto
 * con la basura: descartaba despedidas legítimas por caer en un tramo marcado
 * como silencioso. Midiendo cada cue en su propia ventana la distribución sale
 * bimodal y limpia: habla entre -40 y -20 dB, alucinación de -50 para abajo.
 *
 * El umbral va en el valle entre las dos poblaciones. -46 dB ya se come
 * despedidas reales de gente hablando bajo. De ahí el default.
 *
 * Un cue que no se pudo medir se CONSERVA: perder habla real es peor que dejar
 * pasar una alucinación, porque lo primero no se nota y lo segundo sí.
 */
export const DEFAULT_SILENCE_DB = -50

export function filterHallucinations(
  cues: MeasuredCue[],
  thresholdDb = DEFAULT_SILENCE_DB
): { kept: Cue[]; dropped: MeasuredCue[] } {
  const kept: Cue[] = []
  const dropped: MeasuredCue[] = []

  for (const c of cues) {
    if (c.db !== null && c.db <= thresholdDb) dropped.push(c)
    else kept.push({ start: c.start, end: c.end, text: c.text })
  }

  return { kept, dropped }
}

/** Cuántos cues caen en cada franja de 5 dB. Sirve para elegir el umbral con datos. */
export function levelHistogram(cues: MeasuredCue[]): Array<{ from: number; count: number }> {
  const buckets = new Map<number, number>()

  for (const c of cues) {
    if (c.db === null) continue
    const from = Math.floor(c.db / 5) * 5
    buckets.set(from, (buckets.get(from) ?? 0) + 1)
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([from, count]) => ({ from, count }))
}

export function toSrt(cues: Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`)
    .join('\n')
}

export function toPlainText(cues: Cue[]): string {
  if (cues.length === 0) return ''
  return `${cues.map((c) => `[${stamp(c.start).slice(0, 8)}] ${c.text}`).join('\n')}\n`
}

/** Los cues agrupados por el minuto en el que arrancan. */
export function groupByMinute(cues: Cue[], everySeconds: number): Map<number, Cue[]> {
  const out = new Map<number, Cue[]>()

  for (const c of cues) {
    const slot = Math.floor(c.start / everySeconds)
    const list = out.get(slot)
    if (list === undefined) out.set(slot, [c])
    else list.push(c)
  }

  return out
}
