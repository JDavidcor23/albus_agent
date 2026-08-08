/**
 * Verifica el router de intenciones del chat.
 *
 *   npx tsx scripts/verify-ask.ts
 *
 * Es logica pura: no toca red, base ni CLI. Los pendientes de prueba son los
 * REALES que quedaron en la tabla, no inventados — un matcheo difuso probado
 * contra datos de juguete no prueba nada.
 */
import { interpret, compose } from '../src/main/core/tasks/ask'
import type { Task } from '../src/main/core/tasks/types'

let failures = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`)
  else {
    console.log(`FAIL  ${name} — ${detail}`)
    failures++
  }
}

function task(id: string, title: string, source = 'cli:agy'): Task {
  return {
    id,
    entryId: 'e',
    title,
    detail: null,
    dueDate: null,
    status: 'open',
    source,
    confidence: 0.9,
    createdAt: '2026-08-02T00:00:00.000Z',
    closedAt: null
  }
}

const OPEN: Task[] = [
  task('1', 'Hacer cursos de IA'),
  task('2', 'Investigar si los vídeos de IA generan plata en YouTube'),
  task('3', 'Postularme a la vacante de Senior Frontend React Developer'),
  task('4', 'Postularme a la vacante de Desarrollador Frontend en Latam'),
  task('5', 'Verificar AWS'),
  task('6', 'Asistir al Cripto Latin Fest 2026'),
  task('7', 'Usar el QR de: https://www.meetup.com/aws-user-group-serverless-colombia/events/', 'regla:qr'),
  task('8', 'Usar el QR de: Código QR del evento de cripto (101v)', 'regla:qr'),
  task('9', 'Usar el QR de: Código QR del evento de cripto (1cp6)', 'regla:qr')
]

function main(): void {
  // --- Listar ---------------------------------------------------------------
  for (const phrase of ['¿qué tengo pendiente?', 'que me falta', 'pendientes', 'mis tareas']) {
    check(`"${phrase}" -> pendientes`, interpret(phrase, OPEN).kind === 'tasks')
  }

  // --- Cerrar con un match claro -------------------------------------------
  const courses = interpret('ya hice los cursos de ia', OPEN)
  check(
    '"ya hice los cursos de ia" cierra el correcto',
    courses.kind === 'close' && courses.taskId === '1',
    JSON.stringify(courses)
  )

  const yt = interpret('no va lo de youtube', OPEN)
  check(
    '"no va lo de youtube" descarta el correcto',
    yt.kind === 'close' && yt.taskId === '2' && yt.asDismissed,
    JSON.stringify(yt)
  )

  // --- Ambiguo: NO debe cerrar a ciegas ------------------------------------
  // "postularme" matchea dos vacantes. Cerrar la equivocada es peor que
  // preguntar: el usuario creeria que resolvio algo que sigue abierto.
  const jobPost = interpret('ya me postulé', OPEN)
  check(
    '"ya me postulé" (matchea 2 vacantes) pregunta en vez de adivinar',
    jobPost.kind === 'ambiguous' && jobPost.candidates.length === 2,
    JSON.stringify(jobPost)
  )

  const qr = interpret('ya usé el qr', OPEN)
  check(
    '"ya usé el qr" (matchea 3) pregunta en vez de adivinar',
    qr.kind === 'ambiguous' && qr.candidates.length === 3,
    JSON.stringify(qr)
  )

  // --- "listo" a secas no dice QUÉ -----------------------------------------
  const done = interpret('listo', OPEN)
  check(
    '"listo" a secas no cierra nada',
    done.kind === 'ambiguous' && done.term === '',
    JSON.stringify(done)
  )

  // --- Sin coincidencias ----------------------------------------------------
  const noMatch = interpret('ya hice el asado', OPEN)
  check(
    '"ya hice el asado" no matchea nada y lo dice',
    noMatch.kind === 'ambiguous' && noMatch.candidates.length === 0,
    JSON.stringify(noMatch)
  )

  // --- La negación gana: cerrar de más es el peor error posible ------------
  for (const phrase of [
    'todavia no hice los cursos de ia',
    'aun no me postulé',
    'no he usado el qr'
  ]) {
    const r = interpret(phrase, OPEN)
    check(`"${phrase}" NO cierra nada`, r.kind !== 'close', JSON.stringify(r))
  }

  // --- Fuera de tema --------------------------------------------------------
  check('"hola" -> ayuda', interpret('hola', OPEN).kind === 'help')
  check('vacío -> ayuda', interpret('   ', OPEN).kind === 'help')

  // --- Redacción ------------------------------------------------------------
  check(
    'sin pendientes lo dice claro',
    compose({ kind: 'tasks' }, []) === 'No te queda nada pendiente.'
  )
  check(
    'cuenta bien en singular',
    compose({ kind: 'tasks' }, [OPEN[0]]).includes('1 cosa')
  )

  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLAS`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
