/**
 * Verifica el router de intenciones del chat.
 *
 *   npx tsx scripts/verify-ask.ts
 *
 * Es logica pura: no toca red, base ni CLI. Los pendientes de prueba son los
 * REALES que quedaron en la tabla, no inventados — un matcheo difuso probado
 * contra datos de juguete no prueba nada.
 */
import { interpretar, redactar } from '../src/main/core/tasks/ask'
import type { Task } from '../src/main/core/tasks/types'

let fallas = 0

function check(nombre: string, ok: boolean, detalle = ''): void {
  if (ok) console.log(`PASS  ${nombre}`)
  else {
    console.log(`FAIL  ${nombre} — ${detalle}`)
    fallas++
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

const ABIERTOS: Task[] = [
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
  for (const frase of ['¿qué tengo pendiente?', 'que me falta', 'pendientes', 'mis tareas']) {
    check(`"${frase}" -> pendientes`, interpretar(frase, ABIERTOS).kind === 'pendientes')
  }

  // --- Cerrar con un match claro -------------------------------------------
  const cursos = interpretar('ya hice los cursos de ia', ABIERTOS)
  check(
    '"ya hice los cursos de ia" cierra el correcto',
    cursos.kind === 'cerrar' && cursos.taskId === '1',
    JSON.stringify(cursos)
  )

  const yt = interpretar('no va lo de youtube', ABIERTOS)
  check(
    '"no va lo de youtube" descarta el correcto',
    yt.kind === 'cerrar' && yt.taskId === '2' && yt.comoDismissed,
    JSON.stringify(yt)
  )

  // --- Ambiguo: NO debe cerrar a ciegas ------------------------------------
  // "postularme" matchea dos vacantes. Cerrar la equivocada es peor que
  // preguntar: el usuario creeria que resolvio algo que sigue abierto.
  const vacante = interpretar('ya me postulé', ABIERTOS)
  check(
    '"ya me postulé" (matchea 2 vacantes) pregunta en vez de adivinar',
    vacante.kind === 'ambiguo' && vacante.candidatos.length === 2,
    JSON.stringify(vacante)
  )

  const qr = interpretar('ya usé el qr', ABIERTOS)
  check(
    '"ya usé el qr" (matchea 3) pregunta en vez de adivinar',
    qr.kind === 'ambiguo' && qr.candidatos.length === 3,
    JSON.stringify(qr)
  )

  // --- "listo" a secas no dice QUÉ -----------------------------------------
  const listo = interpretar('listo', ABIERTOS)
  check(
    '"listo" a secas no cierra nada',
    listo.kind === 'ambiguo' && listo.termino === '',
    JSON.stringify(listo)
  )

  // --- Sin coincidencias ----------------------------------------------------
  const nada = interpretar('ya hice el asado', ABIERTOS)
  check(
    '"ya hice el asado" no matchea nada y lo dice',
    nada.kind === 'ambiguo' && nada.candidatos.length === 0,
    JSON.stringify(nada)
  )

  // --- La negación gana: cerrar de más es el peor error posible ------------
  for (const frase of [
    'todavia no hice los cursos de ia',
    'aun no me postulé',
    'no he usado el qr'
  ]) {
    const r = interpretar(frase, ABIERTOS)
    check(`"${frase}" NO cierra nada`, r.kind !== 'cerrar', JSON.stringify(r))
  }

  // --- Fuera de tema --------------------------------------------------------
  check('"hola" -> ayuda', interpretar('hola', ABIERTOS).kind === 'ayuda')
  check('vacío -> ayuda', interpretar('   ', ABIERTOS).kind === 'ayuda')

  // --- Redacción ------------------------------------------------------------
  check(
    'sin pendientes lo dice claro',
    redactar({ kind: 'pendientes' }, []) === 'No te queda nada pendiente.'
  )
  check(
    'cuenta bien en singular',
    redactar({ kind: 'pendientes' }, [ABIERTOS[0]]).includes('1 cosa')
  )

  console.log(fallas === 0 ? '\nTODO OK' : `\n${fallas} FALLAS`)
  process.exit(fallas === 0 ? 0 : 1)
}

main()
