/**
 * El dominio de Udemy, sin navegador y sin disco.
 *
 *   npx tsx scripts/check-udemy.ts
 *
 * Lo que se prueba acá es lo que decide si el modulo sirve: que una fila del
 * curriculum se lea bien, que el nombre de carpeta ordene, que una cue
 * repetida no entre dos veces y que el detector marque SOLO lo que hay que
 * capturar. Nada de esto necesita Electron, sesion de Udemy ni red — y por eso
 * corre en un segundo y se puede correr siempre.
 *
 * `check-video.ts` hace lo mismo un nivel mas abajo. El cableado con el
 * navegador se prueba aparte, contra una leccion real.
 */
import {
  lectureSlug,
  parseLectureText,
  parseSectionText,
  pendingLectures,
  sectionSlug,
  toLectures,
  type Lecture
} from '../src/main/core/udemy/curriculum'
import { dedupeCues, parseCue, toMarkdown } from '../src/main/core/udemy/transcript'
import { MAX_SHOTS, findShots } from '../src/main/core/udemy/deictic'
import { CourseMetaSchema, sortLectures } from '../src/main/core/udemy/library'
import { classifyItem, hasDuration, shouldCapture } from '../src/main/core/udemy/items'
import {
  changeRatio,
  isSlideChange,
  pickChanges,
  sampleTimes
} from '../src/main/core/udemy/frames'

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

/* ── 1. curriculum: leer una fila del panel de contenido ───────────────────── */

console.log('\n── curriculum: filas, numeros y nombres de carpeta\n')

const simple = parseLectureText('51. EBS Overview')
check('numero y titulo se separan', simple.index === 51 && simple.title === 'EBS Overview')

const conDuracion = parseLectureText('53. EBS Hands On\n6min')
check(
  'la duracion en otra linea no se cuela en el titulo',
  conDuracion.title === 'EBS Hands On',
  JSON.stringify(conDuracion.title)
)

const conBasura = parseLectureText('  52.   About EBS Multi-Attach   \n  1min  ')
check('los espacios de sobra se limpian', conBasura.title === 'About EBS Multi-Attach')

const sinNumero = parseLectureText('Quiz 3: EC2 Storage')
check(
  'una fila sin numero no rompe: index 0 y titulo entero',
  sinNumero.index === 0 && sinNumero.title === 'Quiz 3: EC2 Storage'
)

/*
 * El padding a tres digitos NO es cosmetico. Sin el, el explorador de archivos
 * y `readdirSync` ordenan alfabeticamente y la leccion 100 queda ANTES de la
 * 51. El curso tiene mas de 300 lecciones, asi que el caso llega seguro.
 */
check('el slug paddea a 3 digitos', lectureSlug(51, 'EBS Overview') === '051-ebs-overview')
check('y 100 ordena despues de 51', lectureSlug(100, 'x') > lectureSlug(51, 'x'))

check(
  'los acentos y simbolos salen del slug',
  lectureSlug(7, 'IAM & Policies: ¿Qué son?') === '007-iam-policies-que-son',
  lectureSlug(7, 'IAM & Policies: ¿Qué son?')
)

check(
  'un titulo que queda vacio no produce un slug colgado',
  lectureSlug(12, '!!!') === '012-leccion',
  lectureSlug(12, '!!!')
)

check(
  'la seccion paddea a 2',
  sectionSlug(6, 'EC2 Instance Storage') === 's06-ec2-instance-storage'
)

/*
 * Reanudar es el caso REAL: son ~50 lecciones y la corrida se va a cortar.
 * Si al volver empieza de cero, el modulo no sirve.
 */
const lec = (
  index: number,
  title: string,
  completed: boolean,
  kind: Lecture['kind'],
  section = 0
): Lecture => ({
  index,
  title,
  completed,
  slug: lectureSlug(index, title),
  kind,
  section
})

const todas: Lecture[] = [
  lec(51, 'a', true, 'video'),
  lec(52, 'b', true, 'video'),
  lec(53, 'c', false, 'video'),
  lec(54, 'Role Play 1: algo', true, 'roleplay')
]

const faltan = pendingLectures(todas, [lectureSlug(51, 'a')])
check('lo ya bajado no se vuelve a bajar', faltan.length === 1 && faltan[0].index === 52)

check(
  'una leccion sin ver no se baja: todavia no tiene transcript para mi',
  faltan.every((l) => l.completed)
)

check(
  'un role play NO entra en la cola',
  faltan.every((l) => l.kind !== 'roleplay'),
  'filtrarlo aca evita que despues aparezca como "fallo": no fallo, no habia nada'
)

check(
  'un quiz entra aunque no tenga numero de leccion',
  pendingLectures([lec(0, 'Quiz 1: Cloud Computing', true, 'quiz')], []).length === 1
)

/* El pedido real: "bajame la seccion 3, me voy a bañar". */
const porSeccion = [
  lec(6, 'de la 2', true, 'video', 2),
  lec(8, 'Traditional IT Overview', true, 'video', 3),
  lec(9, 'What is Cloud Computing', true, 'video', 3),
  lec(51, 'de la 6', true, 'video', 6)
]

const soloTres = pendingLectures(porSeccion, [], [3])
check(
  'se puede pedir UNA seccion',
  soloTres.length === 2 && soloTres.every((l) => l.section === 3),
  `${soloTres.length} lecciones`
)

check('o varias', pendingLectures(porSeccion, [], [2, 6]).length === 2)
check('sin filtro entran todas', pendingLectures(porSeccion, []).length === 4)

const sec = parseSectionText('Section 3: What is Cloud Computing?')
check(
  'la cabecera de seccion se parsea',
  sec.index === 3 && sec.title === 'What is Cloud Computing?',
  JSON.stringify(sec)
)
check('y en castellano tambien', parseSectionText('Sección 6: EC2').index === 6)

const desdeFilas = toLectures([
  { text: '8. Traditional IT Overview\n6min', completed: true },
  { text: 'Quiz 1: What is Cloud Computing Quiz', completed: true },
  { text: '12. [Important] AWS Console UI Update\n1min', completed: true }
])
check(
  'las filas reales de la Section 3 se clasifican solas',
  desdeFilas.map((l) => l.kind).join(',') === 'video,quiz,nota',
  desdeFilas.map((l) => l.kind).join(',')
)

/* ── 2. transcript: cues a markdown ────────────────────────────────────────── */

console.log('\n── transcript: cues, repetidas y markdown\n')

const conTiempo = parseCue('**01:23** una linea')
check('la cue con tiempo se parte', conTiempo.time === '01:23' && conTiempo.text === 'una linea')

const crudaConTiempo = parseCue('2:05 otra linea')
check('el tiempo pelado tambien', crudaConTiempo.time === '2:05')

const sinTiempo = parseCue('   linea    sin   tiempo  ')
check(
  'sin tiempo la linea igual vale, y se normalizan los espacios',
  sinTiempo.time === '' && sinTiempo.text === 'linea sin tiempo'
)

/*
 * Udemy repite la cue activa mientras el video avanza. Sin esto el markdown
 * sale con la misma frase tres veces y el detector la cuenta tres veces.
 */
const conRepetidas = dedupeCues([
  { time: '00:01', text: 'hola' },
  { time: '00:01', text: 'hola' },
  { time: '00:04', text: 'chau' },
  { time: '00:09', text: 'hola' }
])
check('la repetida PEGADA se descarta', conRepetidas.length === 3)
check(
  'pero la que vuelve mas tarde NO: puede ser que lo haya dicho de nuevo',
  conRepetidas[2].text === 'hola' && conRepetidas[2].time === '00:09'
)

const md = toMarkdown(
  { title: '51. EBS Overview', url: 'https://udemy.com/x#lecture/1', capturedAt: '2026-09-14' },
  [{ time: '00:01', text: 'hola' }]
)
check('el markdown lleva frontmatter', md.startsWith('---\n'))
check('y el titulo como h1', md.includes('# 51. EBS Overview'))
check(
  'y avisa que es PRIVADO: es material pago, no se publica',
  md.includes('PRIVADO'),
  'la marca tiene que estar en el archivo, no solo en el .gitignore'
)

/* ── 3. deictic: donde SI vale una captura ─────────────────────────────────── */

console.log('\n── deictic: cuando el audio deja de bastarse solo\n')

/* La clase 51 real: Maarek lee sus bullets. No hay nada que mirar. */
const bulletsLeidos = findShots([
  { time: '', text: "It's a network drive that you can attach to your instances while they run." },
  { time: '', text: 'EBS volumes allow us to persist data even after the instance is terminated.' },
  { time: '', text: 'So these EBS volumes can only be mounted to one instance at a time.' }
])
check(
  'una clase de bullets leidos no pide NINGUNA captura',
  bulletsLeidos.length === 0,
  'capturar la slide seria guardar el mismo texto dos veces'
)

const conDiagrama = findShots([
  { time: '', text: "So now let's talk about the difference between EBS and EFS." },
  { time: '', text: 'As you can see here, the EBS volume is locked to one availability zone.' },
  { time: '', text: 'And this arrow shows how EFS is mounted across all of them.' },
  { time: '', text: 'Instance Store is physically attached to the host.' }
])
check('los deicticos se detectan', conDiagrama.length > 0, `${conDiagrama.length} momentos`)

check(
  'la TABLA COMPARATIVA gana: es lo que pregunta el examen',
  conDiagrama[0].razones.includes('TABLA COMPARATIVA'),
  conDiagrama[0].razones.join(' · ')
)

check(
  `nunca mas de ${MAX_SHOTS}: con quince capturas no mirás ninguna`,
  findShots(
    Array.from({ length: 20 }, () => ({ time: '', text: 'as you can see here, the diagram' }))
  ).length === MAX_SHOTS
)

check(
  'el contexto viaja con el momento: "as you can see" solo no dice QUE mirar',
  conDiagrama.every((s) => s.contexto.length > s.cue.text.length - 1)
)

/* ── 4. library: el meta.json del curso ────────────────────────────────────── */

console.log('\n── library: meta.json y orden\n')

const vacio = CourseMetaSchema.safeParse({})
check(
  'un meta.json vacio NO tira: viene del disco del usuario',
  vacio.success,
  'todo campo tiene default'
)

const editadoAMano = CourseMetaSchema.safeParse({ courseTitle: 'AWS CCP', lectures: 'cuatro' })
check(
  'un campo con el tipo cambiado a mano tampoco tira',
  editadoAMano.success && editadoAMano.data.lectures === 0
)

const ordenadas = sortLectures([
  { index: 100, slug: 'x' },
  { index: 51, slug: 'y' },
  { index: 0, slug: 'z' }
])
check('las lecciones ordenan por numero, no alfabeticamente', ordenadas[0].index === 0)
check('y 51 va antes que 100', ordenadas[1].index === 51 && ordenadas[2].index === 100)

/* ── 5. items: no todo lo que esta en el indice es una clase ───────────────── */

console.log('\n── items: video, nota, quiz y role play\n')

/* Los cuatro salieron de una captura real de la Section 3 del curso. */
check('una clase de video es video', classifyItem('Traditional IT Overview', true) === 'video')

check(
  'una nota se reconoce por el titulo',
  classifyItem('[Important] AWS Console UI Update', true) === 'nota'
)

check(
  'un quiz NO es una clase',
  classifyItem('Quiz 1: What is Cloud Computing Quiz', false) === 'quiz',
  'tratarlo como video falla con "no pude leer el transcript", que suena a DOM roto'
)

check(
  'un role play tampoco',
  classifyItem('Role Play 1: Explaining AWS Cloud Concepts to Non-Technical', false) === 'roleplay'
)

check('la duracion se ve en el texto completo', hasDuration('8. Traditional IT Overview\n6min'))
check('y en el formato largo', hasDuration('5. Curso\n1hr 23min'))
check('un quiz no declara duracion', !hasDuration('Quiz 1: What is Cloud Computing Quiz'))

check(
  'del quiz se captura la pantalla pero no se busca transcript',
  shouldCapture('quiz').screens && !shouldCapture('quiz').transcript,
  'es lo mas parecido al examen que hay en el curso: vale mas que tres clases'
)

check(
  'del role play no se baja nada: es una charla, no hay texto fijo',
  !shouldCapture('roleplay').screens && !shouldCapture('roleplay').transcript
)

/* ── 6. frames: una captura por slide, ni una mas ──────────────────────────── */

console.log('\n── frames: cuando cambio la slide\n')

/** Firma de 100 celdas con las primeras `changed` en 100 y el resto en 0. */
const sig = (changed: number): number[] =>
  Array.from({ length: 100 }, (_, i) => (i < changed ? 100 : 0))

check('dos frames iguales no cambiaron', changeRatio(sig(0), sig(0)) === 0)
check('medio cuadro distinto es cambio total-ish', changeRatio(sig(0), sig(50)) === 0.5)

check(
  'firmas de distinto largo cuentan como cambio total',
  changeRatio([1, 2, 3], [1, 2]) === 1,
  'devolver un numero chico seria decir "no cambio" sobre algo que no se pudo medir'
)

check('una firma vacia tambien', changeRatio([], []) === 1)

check('un cambio chico NO es slide nueva', !isSlideChange(sig(0), sig(5)))
check('uno grande si', isSlideChange(sig(0), sig(20)))

check(
  'el primer frame entra SIEMPRE: no hay con que compararlo',
  pickChanges([sig(0), sig(1)])[0] === 0
)

/*
 * El fade. Cada paso cambia 5% —por debajo del umbral— pero el principio y el
 * final cambian 10%. Comparando de a pares vecinos no se detecta NUNCA; contra
 * la ultima GUARDADA, si.
 */
const fade = pickChanges([sig(0), sig(5), sig(10)])
check(
  'un fade lento se detecta: se compara contra la ultima GUARDADA, no contra la anterior',
  fade.length === 2 && fade[1] === 2,
  JSON.stringify(fade)
)

check('sin firmas no hay capturas', pickChanges([]).length === 0)

check('los momentos se muestrean parejo', JSON.stringify(sampleTimes(20, 5)) === '[0,5,10,15]')
check('un video sin duracion no se muestrea', sampleTimes(0, 5).length === 0)
check('ni con un intervalo invalido', sampleTimes(300, 0).length === 0)

/*
 * El numero que motivo todo esto: una clase de 6:29 cada 5 segundos son 78
 * muestras. De esas, las que se GUARDAN son solo las que cambiaron.
 */
check(
  'una clase de 6:29 da 78 muestras — por eso no se guardan todas',
  sampleTimes(6 * 60 + 29, 5).length === 78,
  `${sampleTimes(6 * 60 + 29, 5).length} muestras`
)

/* ── final ─────────────────────────────────────────────────────────────────── */

console.log(`\n${failures === 0 ? 'todo verde' : `${failures} en rojo`}\n`)
process.exit(failures === 0 ? 0 : 1)
