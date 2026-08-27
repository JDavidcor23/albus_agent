/**
 * El pipeline de video, de punta a punta, contra un recorte real.
 *
 * `typecheck` e `ipc:check` no prueban NADA de esto: que ffmpeg esté en el PATH,
 * que whisper arranque, que los tramos se peguen con el offset correcto, que el
 * filtro de alucinaciones mida algo. Eso solo lo prueba correrlo.
 *
 *   npx tsx scripts/check-video.ts <video> [segundos]
 *
 * Usa el modelo `base` a propósito: acá se verifica el CABLEADO, no la calidad
 * del transcript. `base` mide ~1,0x tiempo real contra ~2,1x de `small`.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { cacheDir, videoDir } from '../src/main/paths'
import { listManifests } from '../src/main/agents/manifest'
import { SEEDS } from '../src/main/agents/seeds'
import { ffmpegPath } from '../src/main/video/ffmpeg'
import { whisperPath } from '../src/main/video/whisper'
import { runVideo } from '../src/main/video/run'
import {
  DEFAULT_SILENCE_DB,
  filterHallucinations,
  mergeCues,
  parseSrt,
  parseWhisperLog,
  stamp
} from '../src/main/core/video/transcript'

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

/* ── 1. El dominio puro, sin tocar disco ni binarios ───────────────────────── */

console.log('\n── dominio: parseo, pegado y filtro\n')

const LOG = [
  'FP16 is not supported on CPU; using FP32 instead',
  '[00:00.000 --> 00:04.500]  primera linea',
  '[00:04.500 --> 00:09.000]  segunda linea',
  '  0%|   | 0.00/139M [00:00<?, ?iB/s]'
].join('\n')

const fromLog = parseWhisperLog(LOG)
check('el log de whisper se parsea', fromLog.length === 2, `${fromLog.length} cues`)
check('los warnings y el progreso se saltean', fromLog.every((c) => !c.text.includes('FP16')))

const withOffset = parseWhisperLog('[00:10.000 --> 00:12.000]  tarde', 100)
check('el offset corre el timestamp', withOffset[0]?.start === 110, stamp(withOffset[0]?.start ?? 0))

const overHour = parseWhisperLog('[01:02:03.500 --> 01:02:05.000]  pasada la hora')
check('pasada la hora el formato cambia y se soporta', overHour[0]?.start === 3723.5)

const SRT = '1\n00:00:01,000 --> 00:00:02,000\nhola\n\n2\n00:00:03,000 --> 00:00:04,500\nchau\n'
const fromSrt = parseSrt(SRT)
check('el srt se parsea', fromSrt.length === 2 && fromSrt[1].end === 4.5)

/*
 * El solape: se reanuda desde el ARRANQUE del último cue rescatado, así que ese
 * cue está en los dos lados. Tiene que ganar el tramo, no el log — si ganara el
 * log quedaría cortado a la mitad.
 */
const head = [
  { start: 0, end: 5, text: 'vieja a' },
  { start: 100, end: 105, text: 'vieja cortada' }
]
const tail = [{ start: 100, end: 106, text: 'nueva completa' }]
const merged = mergeCues(head, tail, 100)
check('el solape lo gana el tramo', merged.length === 2 && merged[1].text === 'nueva completa')

const { kept, dropped } = filterHallucinations(
  [
    { start: 0, end: 1, text: 'habla real', db: -37 },
    { start: 1, end: 2, text: 'habla baja pero real', db: -44 },
    { start: 2, end: 3, text: 'Gracias.', db: -62 },
    { start: 3, end: 4, text: 'no se pudo medir', db: null }
  ],
  DEFAULT_SILENCE_DB
)
check('la alucinacion se descarta', dropped.length === 1 && dropped[0].text === 'Gracias.')
check('el habla baja se conserva', kept.some((c) => c.text === 'habla baja pero real'))
check('lo que no se pudo medir se conserva', kept.some((c) => c.text === 'no se pudo medir'))

/* ── 2. El agente vive AFUERA ─────────────────────────────────────────────── */

// `tsx` compila a CJS y ahí no hay top-level await. De ahí el envoltorio.
async function main(): Promise<void> {
console.log('\n── el agente es un archivo del usuario, no código\n')

/*
 * Esta sección es la que prueba la corrección de arquitectura.
 *
 * El agente de video NO está en `seeds.ts`: es un `.agente.json` en la carpeta
 * del usuario. Si alguna vez alguien lo mete de vuelta como semilla, este
 * chequeo sigue pasando pero el de abajo —que no esté en SEEDS— falla.
 */
const manifests = listManifests()
const video = manifests.find((m) => m.id === 'video-extraction') ?? null

check('el agente aparece leyendo la CARPETA', video !== null, `${manifests.length} manifiesto(s)`)
check('no está horneado como semilla', !SEEDS.some((s) => s.id === 'video-extraction'))
check('elige su pantalla por dato', video?.screen === 'video', video?.screen ?? '(vacío)')
check(
  'su necesidad sobrevivió al schema',
  video?.needs.includes('video-tools') === true,
  (video?.needs ?? []).join(', ') || '(ninguna — el enum la descartó)'
)

/*
 * El agente de trabajo sigue teniendo cara. Su `.agente.json` en disco es
 * ANTERIOR al campo `screen`, y una semilla no sobrescribe un archivo que ya
 * está: sin la tabla de compatibilidad del renderer perdía el chat.
 */
const jobs = manifests.find((m) => m.id === 'job-search') ?? null
check(
  'el manifiesto viejo de job-search no tiene screen (por eso existe el fallback)',
  jobs !== null && jobs.screen === '',
  jobs === null ? 'no está' : `screen="${jobs.screen}"`
)

console.log('\n── binarios\n')

const ffmpeg = await ffmpegPath()
const whisper = await whisperPath()
check('ffmpeg en el PATH', ffmpeg !== null, ffmpeg ?? '')
check('whisper en el PATH', whisper !== null, whisper ?? '')

/* ── 3. El pipeline completo, si se pasa un video ─────────────────────────── */

const source = process.argv[2]
const seconds = Number(process.argv[3] ?? 210)

if (source === undefined) {
  console.log('\n(sin video: se saltea el pipeline. Pasá una ruta para correrlo entero.)')
} else if (!existsSync(source)) {
  check('el video existe', false, source)
} else if (ffmpeg === null || whisper === null) {
  console.log('\n(faltan binarios: se saltea el pipeline)')
} else {
  console.log(`\n── pipeline completo sobre ${seconds}s de ${source}\n`)

  const tmpDir = join(cacheDir(), 'video-check')
  mkdirSync(tmpDir, { recursive: true })
  const clip = join(tmpDir, 'check-clip.mp4')

  // `-ss` ANTES de `-i`: seek rápido. Con un archivo grande son segundos, no minutos.
  execFileSync(
    ffmpeg,
    ['-y', '-v', 'error', '-ss', '300', '-t', String(seconds), '-i', source, '-c', 'copy', clip],
    { stdio: 'inherit' }
  )
  check('el recorte se creó', existsSync(clip))

  const seen: string[] = []
  const started = Date.now()
  const result = await runVideo({
    videoPath: clip,
    model: 'base',
    language: 'Spanish',
    onStep: (s) => {
      const tag = `${s.stage}${s.total > 0 ? ` ${s.done}/${s.total}` : ''}`
      if (!seen.includes(s.stage)) seen.push(s.stage)
      process.stdout.write(`\r    ${tag.padEnd(40)}`)
    }
  })
  process.stdout.write('\r'.padEnd(48) + '\r')

  const took = Math.round((Date.now() - started) / 1000)
  console.log(`    (tardó ${took}s para ${seconds}s de video)\n`)

  check('pasó por todas las etapas', seen.length === 7, seen.join(' → '))
  check('salieron cues', result.cues > 0, `${result.cues}`)
  check('salieron capturas', result.frames > 0, `${result.frames}`)
  check('la página existe', existsSync(result.pagePath))
  check('el srt existe', existsSync(result.srtPath))
  check('el txt existe', existsSync(result.textPath))
  check('ningún tramo falló', result.failedChunks === 0, `${result.failedChunks} fallados`)
  check(
    'la duración se leyó bien',
    Math.abs(result.durationSeconds - seconds) < 5,
    `${result.durationSeconds.toFixed(1)}s`
  )
  check(
    'el wav y los tramos se limpiaron',
    !existsSync(join(cacheDir(), 'video', 'check-clip', 'audio.wav'))
  )

  console.log(`\n    salida: ${result.outDir}`)

  rmSync(tmpDir, { recursive: true, force: true })
  rmSync(join(videoDir(), 'check-clip'), { recursive: true, force: true })
}

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? 'VIDEO  todo ✓' : `VIDEO  ${failures} fallo(s)`)
console.log('='.repeat(60) + '\n')

process.exit(failures === 0 ? 0 : 1)
}

void main()
