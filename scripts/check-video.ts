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
import { listTranscripts } from '../src/main/video/store'
import {
  TranscriptMetaSchema,
  defaultTitle,
  sortTranscripts,
  titleFor,
  titleFromSlug
} from '../src/main/core/video/library'
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

/* ── 1b. La biblioteca: un transcript tiene NOMBRE ─────────────────────────── */

console.log('\n── biblioteca: titulos y orden\n')

/*
 * El caso que importa: un transcript de ANTES de que `meta.json` existiera.
 *
 * Hay dos en esta máquina. Si el fallback se rompe desaparecen de la lista, y
 * "mi transcript no está" es indistinguible de "se borró". Mismo problema que el
 * manifiesto de `job-search` sin `screen`.
 */
check(
  'un slug con timestamp se lee como fecha y hora',
  titleFromSlug('2026-09-02-10-29-05') === '2026-09-02 10:29:05',
  titleFromSlug('2026-09-02-10-29-05')
)
check('un slug cualquiera se lee sin guiones', titleFromSlug('demo-corta') === 'demo corta')
check(
  'sin meta.json el titulo se DERIVA, no queda vacio',
  titleFor('2026-09-02-10-29-05', null) !== ''
)
check(
  'con meta.json gana lo que escribio el usuario',
  titleFor('2026-09-02-10-29-05', TranscriptMetaSchema.parse({ title: 'Reunión de kickoff' })) ===
    'Reunión de kickoff'
)
/*
 * Un título de espacios NO es un título. Sin este trim, un campo que el usuario
 * dejó con un espacio pisa el nombre derivado y la fila queda visualmente vacía.
 */
check(
  'un titulo de solo espacios cae al derivado',
  titleFor('demo-corta', TranscriptMetaSchema.parse({ title: '   ' })) === 'demo corta'
)
check(
  'el titulo por defecto sale del archivo',
  defaultTitle('2026-09-02 16-04-41.mp4') === '2026-09-02 16:04:41',
  defaultTitle('2026-09-02 16-04-41.mp4')
)

/*
 * `meta.json` es un archivo del USUARIO: lo puede editar a mano y romperlo. Cada
 * campo tiene default para que un archivo a medias no borre el transcript de la
 * lista — es la misma tolerancia que `parseManifest`.
 */
const emptyMeta = TranscriptMetaSchema.safeParse({})
check('un meta.json vacio sigue siendo valido', emptyMeta.success)
const partialMeta = TranscriptMetaSchema.safeParse({ title: 'algo', cues: 'no es un numero' })
check('un campo con el tipo mal SI invalida el archivo', !partialMeta.success)

const ordered = sortTranscripts([
  { id: 'a', createdAt: '2026-09-01T10:00:00.000Z' },
  { id: 'c', createdAt: '' },
  { id: 'b', createdAt: '2026-09-02T10:00:00.000Z' }
])
check(
  'la biblioteca ordena del mas nuevo al mas viejo',
  ordered.map((r) => r.id).join('') === 'bac',
  ordered.map((r) => r.id).join(' → ')
)
// Sin fecha va al final: un string vacío gana toda comparación y los treparía arriba.
check('lo que no tiene fecha va al final', ordered[2].id === 'c')

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

/*
 * Si `job-search` no está, esto se SALTEA en vez de fallar.
 *
 * La semilla la planta `registry.ts` cuando arranca la app, y este script no
 * arranca la app: en un perfil nuevo —una máquina recién configurada, o alguien
 * que corre el verificador antes de abrir Albus una sola vez— el agente
 * legítimamente no existe todavía. Fallar ahí es un gate que grita por una razón
 * ambiental, y un gate que grita en falso es un gate que se empieza a ignorar,
 * justo cuando tapa un fallo de verdad de los que están arriba.
 */
if (jobs === null) {
  console.log('  skip  job-search todavía no está sembrado (la app nunca arrancó en este perfil)')
} else {
  check(
    'el manifiesto viejo de job-search no tiene screen (por eso existe el fallback)',
    jobs.screen === '',
    `screen="${jobs.screen}"`
  )
}

/* ── 2b. La biblioteca, contra el disco de verdad (solo lectura) ───────────── */

console.log('\n── biblioteca: lo que hay guardado acá\n')

/*
 * Solo LEE. Este script no escribe transcripts de prueba en la carpeta del
 * usuario: `paths.ts` cuenta que `check-agents.ts` dejando datos de prueba en
 * `agents/` fue exactamente lo que hizo que una migración se diera por hecha y
 * las reglas del usuario quedaran huérfanas.
 */
const saved = listTranscripts()
check('listar la biblioteca no explota', Array.isArray(saved), `${saved.length} transcript(s)`)
check(
  'ninguna fila quedó sin nombre para mostrar',
  saved.every((r) => r.title.trim() !== ''),
  saved.map((r) => r.title).join(' · ') || '(la carpeta está vacía)'
)
check(
  'toda fila apunta a un srt que existe',
  saved.every((r) => existsSync(r.srtPath))
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
