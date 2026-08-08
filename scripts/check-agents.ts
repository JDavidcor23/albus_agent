/**
 * Verificador de lo nuevo: Notion, correo, triage y el registro de agentes.
 *
 *   npx tsx scripts/check-agents.ts
 *
 * Puro: no toca la red, no necesita credenciales. Lo que sí las necesita está
 * en `scripts/check-live.ts`.
 */
import { readFile } from 'node:fs/promises'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { parseProfile } from '../src/main/core/jobs/profile'
import {
  ESTADOS_NOTION,
  estadoNotion,
  propiedadesNotion,
  recortar,
  scrubPii,
  type FilaNotion
} from '../src/main/core/jobs/notion-map'
import {
  buildMime,
  encodeHeader,
  esEmailValido,
  extraerEmailDeVacante,
  toGmailRaw,
  type EmailDraft
} from '../src/main/core/jobs/email'
import { aplicarPiso, PISO_CALIDAD, type RankedJob } from '../src/main/core/jobs/rank'
import { claveDedupe } from '../src/main/jobs/search'

let pasados = 0
let fallados = 0
const fallas: string[] = []

function check(nombre: string, real: unknown, esperado: unknown): void {
  if (JSON.stringify(real) === JSON.stringify(esperado)) {
    pasados++
    console.log(`  ok    ${nombre}`)
  } else {
    fallados++
    const l = `${nombre}\n          esperado ${JSON.stringify(esperado)}\n          real     ${JSON.stringify(real)}`
    fallas.push(l)
    console.log(`  FALLA ${l}`)
  }
}

function seccion(t: string): void {
  console.log(`\n── ${t}`)
}

const PERFIL_PATH = join(
  process.env.JOB_WORKSPACE_DIR ?? 'C:/Users/jdiaz483/Documents/work/dream/ai-job-search',
  'albus-profile.json'
)

function job(p: Partial<RankedJob>): RankedJob {
  return {
    id: p.id ?? '1',
    title: p.title ?? 'Frontend Developer',
    company: p.company ?? 'Example',
    location: p.location ?? 'Remote',
    date: p.date ?? '2026-08-06',
    url: p.url ?? 'https://co.linkedin.com/jobs/view/x-1',
    description: p.description ?? '',
    score: p.score ?? 0,
    gates: p.gates ?? [],
    reason: p.reason ?? '',
    angle: p.angle ?? ''
  }
}

async function main(): Promise<void> {
  const profile = parseProfile(JSON.parse(await readFile(PERFIL_PATH, 'utf8')))

  // ── ASSERT 1 · el select de Notion no se contamina ───────────────────────
  seccion('assert 1 · estado interno → opción que existe en el select')

  check('submitted → Applying', estadoNotion('submitted'), 'Applying')
  check('filled → Backlog (todavía no es postulación)', estadoNotion('filled'), 'Backlog')
  check('ranked → Backlog', estadoNotion('ranked'), 'Backlog')
  check('blocked → Backlog', estadoNotion('blocked'), 'Backlog')
  check('interview → In process', estadoNotion('interview'), 'In process')
  check('rejected → Rejected', estadoNotion('rejected'), 'Rejected')
  check('discarded → Descartada', estadoNotion('discarded'), 'Descartada')
  check('contacted → First contact', estadoNotion('contacted'), 'First contact')
  check('un estado inventado → null, NO una opción nueva', estadoNotion('en-llamas'), null)
  check('vacío → null', estadoNotion(''), null)

  // Todo lo que el mapa devuelve tiene que existir en el select de la base.
  const estadosPosibles = [
    'submitted', 'filled', 'planned', 'ranked', 'blocked', 'failed',
    'needs-login', 'interview', 'rejected', 'discarded', 'contacted'
  ]
  const fuera = estadosPosibles
    .map(estadoNotion)
    .filter((e) => e !== null && !(ESTADOS_NOTION as readonly string[]).includes(e))
  check('ningún estado mapea fuera del select real', fuera, [])

  // ── ASSERT 3 · nada de PII en Notion ─────────────────────────────────────
  seccion('assert 3 · el teléfono y el correo del candidato no viajan')

  check('tacha el email', scrubPii(`escribime a ${profile.email} dale`, profile), 'escribime a [oculto] dale')
  check('tacha el teléfono pelado', scrubPii(`tel ${profile.phone}`, profile), 'tel [oculto]')
  check(
    'tacha el teléfono con espacios',
    scrubPii('llamame al 300 307 3883', profile),
    'llamame al [oculto]'
  )
  check(
    'tacha el teléfono con guiones',
    scrubPii('300-307-3883 es mi celu', profile),
    '[oculto] es mi celu'
  )
  check(
    'tacha con código de país',
    scrubPii(`${profile.phoneCountryCode}${profile.phone}`, profile),
    '[oculto]'
  )
  check(
    'tacha cualquier otro mail que se cuele del OCR',
    scrubPii('mandale a rrhh@empresa.com', profile),
    'mandale a [oculto]'
  )
  check('el texto sin PII no se toca', scrubPii('React, TypeScript, remoto', profile), 'React, TypeScript, remoto')

  const fila: FilaNotion = {
    company: 'Example Corp',
    role: 'Frontend Developer',
    estado: 'Applying',
    fecha: '2026-08-06',
    fitScore: 72,
    postLink: 'https://co.linkedin.com/jobs/view/x-1',
    contactUrl: 'https://co.linkedin.com/jobs/view/x-1',
    jobDescription: 'React y TypeScript',
    coverLetter: '',
    proximaAccion: 'Esperando respuesta'
  }
  const props = propiedadesNotion(fila)
  const serializado = JSON.stringify(props)

  check('el payload no contiene el email del candidato', serializado.includes(profile.email), false)
  check('el payload no contiene el teléfono', serializado.includes(profile.phone), false)
  check('Company va como title', Object.keys(props.Company as object), ['title'])
  check('Status va como select con nombre válido', (props.Status as { select: { name: string } }).select.name, 'Applying')
  check('un rich_text vacío va como array vacío', (props['cover letter'] as { rich_text: unknown[] }).rich_text, [])
  check('recorta a menos de 2000 (límite de Notion)', recortar('x'.repeat(3000)).length <= 1900, true)

  // ── ASSERT 6 · el MIME del correo ────────────────────────────────────────
  seccion('assert 6 · el adjunto llega con el nombre del candidato')

  const pdf = Buffer.from('%PDF-1.4\nfake cv bytes\n%%EOF\n', 'utf8')
  const draft: EmailDraft = {
    fromName: profile.fullName,
    fromEmail: profile.email,
    to: ['jobs@empresa.com'],
    cc: [],
    subject: 'Postulación — Frontend Developer',
    body: 'Hola,\n\nAdjunto mi CV.\n',
    attachments: [
      { filename: 'CV Jorge David Diaz.pdf', mimeType: 'application/pdf', content: new Uint8Array(pdf) }
    ]
  }

  const BOUNDARY = 'albus-test-boundary'
  const mime = buildMime(draft, BOUNDARY)

  check(
    'el Content-Disposition trae el nombre exacto',
    mime.includes('filename="CV Jorge David Diaz.pdf"'),
    true
  )
  check('el asunto con tilde va codificado en RFC 2047', mime.includes('=?UTF-8?B?'), true)
  check(
    'el asunto se decodifica de vuelta al original',
    Buffer.from(
      (mime.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/) ?? ['', ''])[1],
      'base64'
    ).toString('utf8'),
    draft.subject
  )
  check('el ASCII puro no se codifica al pedo', encodeHeader('Frontend Developer'), 'Frontend Developer')
  check('multipart declarado', mime.includes(`multipart/mixed; boundary="${BOUNDARY}"`), true)
  check('cierra el boundary', mime.includes(`--${BOUNDARY}--`), true)
  check('usa CRLF, no LF pelado', mime.includes('\r\n') && !/[^\r]\n/.test(mime), true)

  // Round-trip real: sacar el adjunto del MIME y comparar bytes.
  const partes = mime.split(`--${BOUNDARY}`)
  const parteAdjunto = partes.find((p) => p.includes('CV Jorge David Diaz.pdf')) ?? ''
  const cuerpoB64 = parteAdjunto.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n/g, '').trim()
  const recuperado = Buffer.from(cuerpoB64, 'base64')

  check('los bytes del PDF sobreviven el round-trip', recuperado.equals(pdf), true)
  check('las líneas base64 respetan el corte de 76',
    parteAdjunto.split('\r\n').filter((l) => /^[A-Za-z0-9+/=]+$/.test(l)).every((l) => l.length <= 76),
    true
  )

  const raw = toGmailRaw(mime)
  check('base64url sin caracteres inválidos para la URL', /^[A-Za-z0-9_-]+$/.test(raw), true)
  check('el raw se decodifica al MIME original', Buffer.from(raw, 'base64url').toString('utf8'), mime)

  check('valida direcciones', esEmailValido('jobs@empresa.com'), true)
  check('rechaza basura', esEmailValido('no-es-un-mail'), false)
  check(
    'saca el correo de la vacante y NO el propio',
    extraerEmailDeVacante(`Enviar a ${profile.email} o a rrhh@empresa.com`, profile.email),
    'rrhh@empresa.com'
  )
  check(
    'ignora nombres de imagen que parecen mail',
    extraerEmailDeVacante('logo@2x.png y hr@corp.io', profile.email),
    'hr@corp.io'
  )

  // ── reintento del transitorio de Supabase ────────────────────────────────
  seccion('supabase · "JWT issued at future" es transitorio y se reintenta')

  const { crearFetchConReintento, ES_TRANSITORIO } = await import('../src/main/supabase/retry')

  const respuesta = (status: number, cuerpo: string): Response =>
    new Response(cuerpo, { status, headers: { 'Content-Type': 'application/json' } })

  const JWT_FUTURO = '{"code":"PGRST301","message":"JWT issued at future"}'
  const KEY_MALA = '{"message":"Invalid API key"}'

  /** fetch falso que devuelve la cola de respuestas y cuenta las llamadas. */
  function fetchFalso(cola: Response[]): { fn: typeof fetch; llamadas: () => number } {
    let n = 0
    return {
      fn: (async () => {
        const r = cola[Math.min(n, cola.length - 1)]
        n++
        return r.clone()
      }) as unknown as typeof fetch,
      llamadas: () => n
    }
  }

  check('reconoce el transitorio', ES_TRANSITORIO.test('JWT issued at future'), true)
  check('NO confunde una key inválida con transitorio', ES_TRANSITORIO.test('Invalid API key'), false)
  check('NO confunde un token expirado', ES_TRANSITORIO.test('JWT expired'), false)

  // 1 · camino feliz: una sola llamada.
  const feliz = fetchFalso([respuesta(200, '[{"id":1}]')])
  const r1 = await crearFetchConReintento(feliz.fn, 0)('https://x/y')
  check('200 a la primera → una sola llamada', feliz.llamadas(), 1)
  check('200 → devuelve 200', r1.status, 200)
  check('el cuerpo sigue legible para quien llamó', await r1.text(), '[{"id":1}]')

  // 2 · el caso real: falla una vez, anda a la segunda.
  const transitorio = fetchFalso([respuesta(401, JWT_FUTURO), respuesta(200, '[{"id":2}]')])
  const r2 = await crearFetchConReintento(transitorio.fn, 0)('https://x/y')
  check('transitorio → reintenta', transitorio.llamadas(), 2)
  check('transitorio → termina en 200', r2.status, 200)
  check('y el cuerpo bueno llega entero', await r2.text(), '[{"id":2}]')

  // 3 · si no se recupera, corta: no reintenta para siempre.
  const siempre = fetchFalso([respuesta(401, JWT_FUTURO)])
  const r3 = await crearFetchConReintento(siempre.fn, 0)('https://x/y')
  check('transitorio persistente → 1 + 2 reintentos y basta', siempre.llamadas(), 3)
  check('y devuelve el error, no cuelga', r3.status, 401)

  // 4 · un error de credenciales de verdad NO se reintenta: hay que verlo ya.
  const credencial = fetchFalso([respuesta(401, KEY_MALA)])
  const r4 = await crearFetchConReintento(credencial.fn, 0)('https://x/y')
  check('key inválida → una sola llamada', credencial.llamadas(), 1)
  check('key inválida → sale el 401 tal cual', r4.status, 401)

  // 5 · un 500 tampoco: no es esta clase de falla.
  const server = fetchFalso([respuesta(500, '{"message":"boom"}')])
  await crearFetchConReintento(server.fn, 0)('https://x/y')
  check('500 → no se reintenta', server.llamadas(), 1)

  // ── ASSERTS 1-3 · el bug de "host no permitido" ──────────────────────────
  seccion('asserts 1-3 · abrir la vacante que el scraper devuelve de verdad')

  const { esUrlAbrible, esUrlPostulable, HOSTS_POSTULABLES } = await import('../src/shared/ipc')

  // La URL exacta que falló en su corrida.
  const REAL = 'https://co.linkedin.com/jobs/view/frontend-developer-at-fox-analytics-4448573564'
  check('la URL real del scraper AHORA abre', esUrlAbrible(REAL), true)
  check('y sigue siendo postulable', esUrlPostulable(REAL), true)

  for (const h of ['co', 'es', 'uk', 'www', 'mx', 'br']) {
    check(`${h}.linkedin.com abre`, esUrlAbrible(`https://${h}.linkedin.com/jobs/view/1`), true)
  }
  check('linkedin.com pelado abre', esUrlAbrible('https://linkedin.com/jobs/view/1'), true)

  // El ataque que un `endsWith` ingenuo dejaría pasar.
  check(
    'linkedin.com.malicioso.com NO abre',
    esUrlAbrible('https://linkedin.com.malicioso.com/jobs/view/1'),
    false
  )
  check('evil-linkedin.com NO abre', esUrlAbrible('https://evil-linkedin.com/x'), false)
  check('xlinkedin.com NO abre', esUrlAbrible('https://xlinkedin.com/x'), false)
  check('http:// NO abre aunque el host valga', esUrlAbrible('http://www.linkedin.com/x'), false)
  check('un host cualquiera NO abre', esUrlAbrible('https://malicioso.com/x'), false)

  // El invariante: si Albus puede navegar ahí con tu sesión, abrirlo en tu
  // navegador es estrictamente menos riesgoso. Que no se desincronicen nunca.
  const noAbribles = HOSTS_POSTULABLES.filter((h) => !esUrlAbrible(`https://${h}/x`))
  check('todo host postulable es abrible', noAbribles, [])

  // ── el camino a cero dedos ───────────────────────────────────────────────
  seccion('conexiones · una sesión de Google desbloquea el resto')

  const registryTs = await readFile('src/main/connections/registry.ts', 'utf8')
  const agenteTs = await readFile('src/main/connections/agente-conexion.ts', 'utf8')
  const serviciosTs = await readFile('src/main/connections/servicios.ts', 'utf8')
  const sessionTs = await readFile('src/main/browser/session.ts', 'utf8')

  check(
    'existe la sesión de Google en el navegador (distinta del token de API)',
    sessionTs.includes('hasGoogleBrowserSession') && sessionTs.includes('openGoogleLoginWindow'),
    true
  )
  check(
    'está registrada como conexión propia',
    registryTs.includes("id: 'google-navegador'"),
    true
  )
  check(
    'va ANTES de LinkedIn en la lista: es la que desbloquea',
    registryTs.indexOf("'google-navegador'") < registryTs.indexOf("id: 'linkedin'"),
    true
  )
  check(
    'el agente intenta entrar por SSO antes de pedirte nada',
    /sin escribir credenciales|SIN escribir credenciales/i.test(agenteTs),
    true
  )
  check(
    'y si no hay sesión de Google, LO DICE en vez de prometer un click',
    registryTs.includes('te va a pedir un código por mail'),
    true
  )
  check(
    'el login NUNCA se automatiza con contraseña',
    /contraseña/.test(sessionTs) && !/type\(.*password|fill.*password/i.test(sessionTs),
    true
  )
  check(
    'y el agente tampoco: si hay que escribir una clave, se rinde',
    /es IMPOSIBLE/.test(agenteTs),
    true
  )

  // ── un motor, no un archivo por servicio ─────────────────────────────────
  seccion('conexiones · sumar un servicio es una fila de datos, no código')

  check(
    'no quedó ningún adaptador por servicio',
    existsSync('src/main/connections/notion-auto.ts'),
    false
  )
  check(
    'el motor es uno solo y no nombra a Notion en su lógica',
    /notion/i.test(agenteTs.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')),
    false
  )
  check(
    'Notion y Supabase salen de la MISMA tabla',
    serviciosTs.includes("id: 'notion'") && serviciosTs.includes("id: 'supabase'"),
    true
  )
  check(
    'un servicio se declara con url + objetivos + patrón del secreto',
    /url:/.test(serviciosTs) && /objetivos:/.test(serviciosTs) && /patronSecreto:/.test(serviciosTs),
    true
  )
  check(
    'el IPC no tiene un camino especial por servicio',
    /switch\s*\(\s*id|if\s*\(\s*id\s*===\s*['"]notion/.test(
      await readFile('src/main/ipc/connections.ipc.ts', 'utf8')
    ),
    false
  )

  // ── la credencial que no se puede VER, solo copiar ───────────────────────
  seccion('conexiones · hay paneles que solo dejan copiar el token')

  check(
    'se busca también en el portapapeles, no solo en la pantalla',
    agenteTs.includes('clipboard.readText'),
    true
  )
  check(
    'el portapapeles se VACÍA antes de empezar',
    agenteTs.includes("clipboard.writeText('')"),
    true
  )
  check(
    'y lo que el usuario tenía copiado se le devuelve',
    agenteTs.includes('restaurarPortapapeles'),
    true
  )
  check(
    'si los objetivos terminan sin credencial, se intenta un rescate',
    /solo ofrece un botón de COPIAR/i.test(agenteTs),
    true
  )

  // ── reglas por agente ────────────────────────────────────────────────────
  seccion('reglas · un .md que el usuario edita, no una pantalla de config')

  const { parsearReglas } = await import('../src/main/connections/../agents/rules')

  const md = `# Búsqueda de trabajo

## Dónde registrar
- Registro de aplicaciones: https://www.notion.so/81e09fb24cbb4a76bb7015cec17003e2
- Con guiones: https://www.notion.so/otra-1234abcd-5678-90ef-1234-567890abcdef
- App: https://app.notion.com/p/aaaabbbbccccddddeeeeffff00001111
- La misma de arriba otra vez: https://www.notion.so/81e09fb24cbb4a76bb7015cec17003e2

<!-- Ejemplo: https://www.notion.so/00000000000000000000000000000000 -->

## Drive
- CVs: https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp

## Qué NO quiero
- nada con Java
`

  const r = parsearReglas('job-search', md, 'x.md', true)

  check('lee los links de Notion', r.notion.length, 3)
  check('el id viene sin guiones, listo para la API', r.notion[0].id, '81e09fb24cbb4a76bb7015cec17003e2')
  check('acepta ids CON guiones', r.notion[1].id, '1234abcd567890ef1234567890abcdef')
  check('y el host app.notion.com', r.notion[2].id, 'aaaabbbbccccddddeeeeffff00001111')

  // El mismo link dos veces es UNA base. Sin dedupe, el usuario que pega el
  // link de su tracker en dos secciones del archivo tendría dos "proyectos".
  check(
    'el mismo id repetido cuenta una sola vez',
    r.notion.filter((n) => n.id === '81e09fb24cbb4a76bb7015cec17003e2').length,
    1
  )

  // El primero manda: es el que se usa para escribir. Un orden que dependa de
  // en qué sección del archivo quedó el link sería impredecible.
  check('el primero de la lista es el que gana', r.notion[0].etiqueta, 'Registro de aplicaciones')
  check('guarda la etiqueta que escribió el usuario', r.notion[0].etiqueta, 'Registro de aplicaciones')
  check('lee las carpetas de Drive', r.drive.length, 1)
  check('y su id', r.drive[0].id, '1AbCdEfGhIjKlMnOp')

  // El ejemplo comentado NO cuenta: si contara, la plantilla recién creada se
  // autoconfiguraría apuntando a una base de ceros que no existe.
  check(
    'un link dentro de <!-- --> se ignora',
    r.notion.some((n) => n.id === '00000000000000000000000000000000'),
    false
  )

  // El texto ENTERO se conserva: es lo que se le pasa al agente. Si esto se
  // recortara, "nada con Java" —una regla que nadie programó— se perdería.
  check('el texto completo queda para el agente', r.texto.includes('nada con Java'), true)

  // ── el resumen: lo que el usuario VE ─────────────────────────────────────
  // Mostraba "Notion · Registro de aplicaciones" y el reclamo fue "eso no me
  // dice nada". Ahora muestra las reglas escritas, y estos asserts cuidan que
  // no se cuele el andamiaje de la plantilla.
  const conReglas = parsearReglas(
    'x',
    [
      '# Título que no es una regla',
      '',
      'Un párrafo del instructivo que explica cómo usar el archivo.',
      '',
      '- nada con Java ni turnos de noche',
      '- Roles:',
      '- Registro: https://www.notion.so/81e09fb24cbb4a76bb7015cec17003e2',
      '- Ubicación: Colombia',
      '<!-- - comentado: https://www.notion.so/00000000000000000000000000000000 -->'
    ].join('\n'),
    'x.md',
    true
  )

  check('el resumen NO trae los títulos', conReglas.resumen.some((l) => l.includes('Título')), false)
  check(
    'ni la prosa del instructivo, que además se corta en varias líneas',
    conReglas.resumen.some((l) => l.includes('instructivo')),
    false
  )
  check('una viñeta vacía como "Roles:" no cuenta', conReglas.resumen.includes('Roles:'), false)
  check(
    'una línea que era SOLO un link desaparece del resumen',
    conReglas.resumen.some((l) => l.includes('notion.so')),
    false
  )
  check('pero el link sigue contando para saber a dónde escribe', conReglas.notion.length, 1)
  check('quedan las reglas de verdad', conReglas.resumen, [
    'nada con Java ni turnos de noche',
    'Ubicación: Colombia'
  ])


  const { AGENTES: registrados } = await import('../src/main/agents/registry')
  const jobSearch = registrados.find((a) => a.id === 'job-search')

  // Sin archivo, el resumen va VACÍO aunque haya plantilla: si no, un agente
  // recién creado muestra los ejemplos del instructivo como reglas propias y
  // el botón dice "escribir las primeras" arriba de una lista llena.
  const { leerReglas } = await import('../src/main/agents/rules')
  const inexistente = leerReglas('no-existe-este-agente', jobSearch?.plantillaReglas ?? '')
  check('sin archivo, el resumen está vacío', inexistente.resumen.length, 0)
  check('y tampoco hereda los links de la plantilla', inexistente.notion.length, 0)
  check('pero el texto de la plantilla sí viaja, para poder crearla', inexistente.texto.length > 100, true)
  check('el agente de trabajo declara su plantilla', jobSearch?.plantillaReglas !== undefined, true)
  check(
    'y la plantilla trae sus links de ejemplo COMENTADOS',
    /<!--[\s\S]*notion\.so[\s\S]*-->/.test(jobSearch?.plantillaReglas ?? ''),
    true
  )

  const clientTs = await readFile('src/main/notion/client.ts', 'utf8')
  check(
    'la base de Notion ya no es una constante: se resuelve',
    clientTs.includes('setNotionDatabaseIdResolver'),
    true
  )
  check(
    'y el resolver sale de las reglas del agente',
    /setNotionDatabaseIdResolver[\s\S]{0,400}leerReglas/.test(registryTs),
    true
  )

  // ── el chat del agente de trabajo ────────────────────────────────────────
  seccion('chat · un comando se resuelve con reglas; una pregunta, con el modelo')

  const { interpretar, resolverVacante } = await import('../src/main/core/jobs/chat')

  const enPantalla = [
    { id: 'a', company: 'Luxury Presence', title: 'Design Engineer', score: 82 },
    { id: 'b', company: 'Jobgether', title: 'Software Craftsperson', score: 74 },
    { id: 'c', company: 'Truelogic Software', title: 'Semi-Senior Frontend', score: 68 }
  ]

  check('buscar', interpretar('buscame trabajo, hacé un barrido', []).kind, 'buscar')
  check(
    'con roles: lo que pidió, no lo que suponemos',
    (interpretar('buscame trabajo de react developer', []) as { queries: string[] }).queries,
    ['react developer']
  )
  check(
    'sin roles queda VACÍO: mandan las reglas, no un default inventado',
    (interpretar('buscame trabajo', []) as { queries: string[] }).queries,
    []
  )
  check(
    'la ubicación necesita preposición: si no, "React" sería un país',
    (interpretar('buscame frontend en Colombia', []) as { ubicacion: string | null }).ubicacion,
    'Colombia'
  )

  check('postular por posición', interpretar('postulate a la primera', enPantalla), {
    kind: 'postular',
    id: 'a'
  })
  check('postular por número', interpretar('aplicá a la 2', enPantalla), {
    kind: 'postular',
    id: 'b'
  })
  check('postular por empresa', interpretar('postulate a Truelogic', enPantalla), {
    kind: 'postular',
    id: 'c'
  })
  check('mostrar la evidencia', interpretar('mostrame cómo quedó la 1', enPantalla), {
    kind: 'mostrar',
    id: 'a'
  })
  check('pasame el archivo también es mostrar', interpretar('pasame el CV de la 1', enPantalla).kind, 'mostrar')
  check('enviar lo que quedó frenado', interpretar('dale, mandala', [enPantalla[0]]), {
    kind: 'enviar',
    id: 'a'
  })
  check('descartar', interpretar('esa no me interesa', [enPantalla[1]]), {
    kind: 'descartar',
    id: 'b'
  })

  /*
   * Lo que NO se puede adivinar. Postularse a la vacante equivocada no se
   * deshace: se le escribió a un reclutador real con el CV de otro puesto.
   */
  check(
    'con tres en pantalla y sin decir cuál, PREGUNTA',
    interpretar('postulate', enPantalla).kind,
    'ambiguo'
  )
  check(
    'con una sola en pantalla, "postulate" no es ambiguo',
    interpretar('postulate', [enPantalla[0]]),
    { kind: 'postular', id: 'a' }
  )
  check(
    'un número fuera de rango no elige la última por las dudas',
    interpretar('postulate a la 9', enPantalla).kind,
    'ambiguo'
  )

  // Lo que una regla no puede contestar va al modelo, y NO se responde
  // "no entendí": eso es la forma más rápida de que el usuario deje de escribir.
  check(
    'una pregunta de verdad va al modelo',
    interpretar('¿por qué descartaste las otras nueve?', enPantalla).kind,
    'conversar'
  )
  check(
    'y llega con el texto entero, sin recortar',
    (interpretar('¿cuál me conviene más?', enPantalla) as { texto: string }).texto,
    '¿cuál me conviene más?'
  )

  check('sin nada escrito, ayuda', interpretar('   ', enPantalla).kind, 'ayuda')
  check('sin vacantes en pantalla no se puede elegir', resolverVacante('la 1', []), null)

  /*
   * La carrera con la detección de CLIs.
   *
   * `cli:list` tarda hasta 16 segundos; si el usuario escribe antes, el
   * renderer todavía no tiene provider y mandaba `''`. El error resultante era
   * `el CLI "" no está disponible`: incomprensible, y culpaba al usuario de
   * una carrera interna. Ahora el main elige solo.
   */
  const jobsIpcTs = await readFile('src/main/ipc/jobs.ipc.ts', 'utf8')
  check(
    'sin provider elegido, el MAIN resuelve el primero disponible',
    /primerProviderDisponible/.test(jobsIpcTs),
    true
  )
  check(
    'y el error de "no hay CLI" explica qué falta, no repite un id vacío',
    /el CLI "\$\{req\.providerId\}"/.test(jobsIpcTs),
    false
  )
  check(
    'el mensaje nombra los binarios que hay que instalar',
    /claude o agy/.test(jobsIpcTs),
    true
  )

  // ── un conector no es un agente ──────────────────────────────────────────
  seccion('conexiones · el conector describe lo que DA, no lo que un agente hace')

  const { SERVICIOS } = await import('../src/main/connections/registry')

  /*
   * "Espeja tus postulaciones", "Manda las postulaciones por correo", "Deja
   * que Albus complete los formularios": todos describían al agente de trabajo.
   * Un conector es una capacidad de la app; qué se hace con ella lo deciden las
   * reglas del agente, y mañana hay tres agentes usando el mismo Notion.
   */
  const HABLA_DE_AGENTES = /postulaci|postular|vacante|CV|formulario de postulaci|trabajo/i
  const contaminados = SERVICIOS.filter((s) => HABLA_DE_AGENTES.test(s.paraQue)).map((s) => s.id)
  check('ningún conector menciona lo que hace un agente con él', contaminados, [])

  check(
    'todos dicen algo, y en una línea',
    SERVICIOS.every((s) => s.paraQue.length > 20 && s.paraQue.length < 120),
    true
  )

  // Google era DOS tarjetas idénticas —token de API y sesión de navegador— y
  // nadie entendía por qué. Siguen siendo entradas distintas (son mecanismos
  // distintos), pero comparten grupo y se pintan juntas.
  const google = SERVICIOS.filter((s) => s.grupo === 'google')
  check('las dos entradas de Google comparten grupo', google.length, 2)
  check(
    'y cada una dice qué permiso aporta',
    google.every((s) => (s.capacidad ?? '').length > 3),
    true
  )
  check(
    'ninguna se llama "Google (navegador)": el paréntesis era el síntoma',
    SERVICIOS.some((s) => s.nombre.includes('(')),
    false
  )

  // ── preguntas del agente ─────────────────────────────────────────────────
  seccion('preguntas · una respuesta se vuelve una regla, no un formulario')

  const q = await import('../src/main/agents/questions')

  // El bloque que se anexa al .md se verifica sin tocar disco.
  const bloque = q.bloqueDeRespuesta(
    '¿Con qué nombre guardo el CV?',
    'con el nombre del candidato, no el de la vacante',
    '2026-08-08T10:00:00.000Z'
  )

  check(
    'la respuesta se anexa como VIÑETA: así el resumen la lee como regla',
    /^\s*-\s/m.test(bloque),
    true
  )
  check(
    'la pregunta original queda en un comentario, para acordarse en marzo',
    /<!--.*¿Con qué nombre guardo el CV\?.*-->/.test(bloque),
    true
  )
  check('con la fecha en que se respondió', bloque.includes('2026-08-08'), true)

  // El comentario NO puede contar como regla: si contara, cada respuesta
  // aparecería dos veces en el panel —la regla y la pregunta—.
  const conRespuesta = parsearReglas('x', `# Reglas${bloque}`, 'x.md', true)
  check('la regla nueva entra al resumen', conRespuesta.resumen.length, 1)
  check(
    'y el comentario con la pregunta NO se cuela como otra regla',
    conRespuesta.resumen[0],
    'con el nombre del candidato, no el de la vacante'
  )

  // La misma duda veinte veces es UNA pregunta. Sin esto, veinte postulaciones
  // con el mismo campo sin resolver llenan el panel y el usuario lo abandona.
  const AG = 'chequeo-preguntas'
  const rutaQ = join(
    (await import('../src/main/paths')).carpetaAgentes(),
    `${AG}.preguntas.json`
  )
  if (existsSync(rutaQ)) rmSync(rutaQ)

  const p1 = q.encolarPregunta(AG, '¿Qué formato uso?', { ahora: '2026-08-08T10:00:00.000Z' })
  const p2 = q.encolarPregunta(AG, '¿Qué formato uso?', { ahora: '2026-08-08T11:00:00.000Z' })
  check('la misma pregunta no se duplica', p1.id, p2.id)
  check('y queda una sola pendiente', q.pendientes(AG).length, 1)

  q.responderPregunta(AG, p1.id, 'PDF siempre', '2026-08-08T12:00:00.000Z')
  check('respondida deja de estar pendiente', q.pendientes(AG).length, 0)
  check('y pasa a las respondidas', q.respondidas(AG)[0]?.respuesta, 'PDF siempre')

  // Respondida, la MISMA pregunta puede volver a encolarse si el agente
  // insiste — pero eso es una señal de que la respuesta no le alcanzó, no un
  // duplicado. Lo que no puede es reaparecer sola.
  check('no reaparece sola después de responderla', q.pendientes(AG).length, 0)

  rmSync(rutaQ, { force: true })
  rmSync(join((await import('../src/main/paths')).carpetaAgentes(), `${AG}.md`), { force: true })

  // ── albus.yml ────────────────────────────────────────────────────────────
  seccion('albus.yml · un solo archivo de llaves, legible y editable')

  const ymlTs = await readFile('src/main/connections/albus-yml.ts', 'utf8')
  const storeTs = await readFile('src/main/connections/store.ts', 'utf8')
  const gitignore = await readFile('.gitignore', 'utf8')

  check('está en el .gitignore', /^albus\.yml$/m.test(gitignore), true)
  check(
    'el archivo dice de frente que es texto plano y qué se perdió',
    /TEXTO PLANO/.test(ymlTs) && /safeStorage|DPAPI/.test(ymlTs),
    true
  )
  check(
    'no se trajo una dependencia de YAML para guardar CLAVE: valor',
    /from 'js-yaml'|require\('js-yaml'\)/.test(ymlTs),
    false
  )
  check('guardar escribe en albus.yml', /escribirEnAlbusYml\(claveYml/.test(storeTs), true)
  check(
    'y leer lo consulta ANTES que lo cifrado y que el .env',
    storeTs.indexOf('deAlbusYml(claveYml(clave))') < storeTs.indexOf('safeStorage.decryptString'),
    true
  )
  check(
    'desconectar borra de los DOS lados, si no el token reaparece al reiniciar',
    /borrarDeAlbusYml[\s\S]{0,400}escribirCrudo/.test(storeTs),
    true
  )
  check(
    'las llaves se ven como las del .env (notion.token → NOTION_TOKEN)',
    /replace\(\/\\\.\/g, '_'\)\.toUpperCase\(\)/.test(storeTs),
    true
  )

  // El parser es propio: se prueba de verdad, no por su forma.
  const { parsearYml } = await import('../src/main/connections/albus-yml')
  const muestra = parsearYml(
    ['# un comentario', 'NOTION_TOKEN: "ntn_abc#123"', 'VACIA:', 'OTRA: sin-comillas # cola', ''].join(
      '\n'
    )
  )
  check('un # dentro de comillas es parte del token', muestra.NOTION_TOKEN, 'ntn_abc#123')
  check('sin comillas, el # sí corta', muestra.OTRA, 'sin-comillas')
  check('una clave sin valor queda vacía, no rompe', muestra.VACIA, '')
  check('los comentarios no entran', Object.keys(muestra).length, 3)

  // ── una sola instancia ───────────────────────────────────────────────────
  seccion('instancia única · dos Albus rompen el almacenamiento de Chromium')

  const indexTs = await readFile('src/main/index.ts', 'utf8')
  check('pide el candado de instancia única', indexTs.includes('requestSingleInstanceLock'), true)
  // `exit(1)` y no `quit()`: hay que salir ANTES de tocar el disco, y para un
  // comando de terminal el código de salida distinto de cero es la diferencia
  // entre "falló" y "anduvo".
  check(
    'y se cierra si no lo consigue',
    /requestSingleInstanceLock\(\)\)\s*\{[\s\S]{0,1200}app\.(exit\(1\)|quit\(\))/.test(indexTs),
    true
  )
  check(
    'y un comando de terminal recibe el motivo, no un ERR_FAILED confuso',
    /NO PUEDO CORRER[\s\S]{0,300}Cerrá la ventana/.test(indexTs),
    true
  )
  check('trae al frente la que ya está', indexTs.includes("'second-instance'"), true)
  check(
    'el candado va ANTES de whenReady (si no, ya tocó el disco)',
    indexTs.indexOf('requestSingleInstanceLock') < indexTs.indexOf('app.whenReady'),
    true
  )

  // ── ASSERT 9 · el freno del correo ───────────────────────────────────────
  seccion('assert 9 · solo `auto` manda; `review` deja un borrador')

  const { modoGmail } = await import('../src/main/core/jobs/email')
  check('review → borrador', modoGmail('review'), 'draft')
  check('auto → manda', modoGmail('auto'), 'send')
  check('dry-run → ni borrador', modoGmail('dry-run'), 'nada')

  // ── ASSERT 5 · sin credencial se falla ruidoso ───────────────────────────
  seccion('assert 5 · sin NOTION_TOKEN falla con la instrucción, no en silencio')

  const guardado = process.env.NOTION_TOKEN
  delete process.env.NOTION_TOKEN

  const { isNotionConfigured, notionFetch } = await import('../src/main/notion/client')
  check('se detecta que no está configurado', isNotionConfigured(), false)

  let mensaje = ''
  try {
    await notionFetch('/users/me')
  } catch (error: unknown) {
    mensaje = error instanceof Error ? error.message : String(error)
  }
  check('tira, no devuelve undefined', mensaje.length > 0, true)
  check('el error nombra la variable que falta', mensaje.includes('NOTION_TOKEN'), true)
  check('y dice dónde crearla', mensaje.includes('my-integrations'), true)

  if (guardado !== undefined) process.env.NOTION_TOKEN = guardado

  // ── ASSERT 16 · el piso de calidad no se rellena ─────────────────────────
  seccion('assert 16 · con dos buenas devuelve dos, no inventa una tercera')

  const lote = [
    job({ id: 'a', score: 88 }),
    job({ id: 'b', score: 71 }),
    job({ id: 'c', score: 64 }),
    job({ id: 'd', score: 92, gates: ['requires-relocation'] }),
    job({ id: 'e', score: 40 })
  ]
  const { califican, descartadas } = aplicarPiso(lote)

  check('pasan exactamente dos', califican.map((j) => j.id), ['a', 'b'])
  check('64 no pasa (el piso es 65)', descartadas.some((j) => j.id === 'c'), true)
  check('un corte duro descalifica aunque el puntaje sea 92', descartadas.some((j) => j.id === 'd'), true)
  check('vienen ordenadas por puntaje', califican[0].score >= califican[1].score, true)
  check('el piso es 65', PISO_CALIDAD, 65)
  check('sin candidatas devuelve vacío, no un placeholder', aplicarPiso([]).califican, [])
  check(
    'justo en 65 pasa',
    aplicarPiso([job({ id: 'x', score: 65 })]).califican.map((j) => j.id),
    ['x']
  )

  // ── el parseo del CLI contra su forma REAL ───────────────────────────────
  seccion('search · un `null` no puede tragarse la descripción entera')

  const { SCHEMAS_INTERNOS } = await import('../src/main/jobs/search')

  // Copiado tal cual de una corrida del CLI. Los `null` son de LinkedIn, no
  // inventados: son los campos que no publica.
  const DETALLE_REAL = {
    id: '4449642850',
    title: 'React Developer - Remote Work',
    company: 'INDI Staffing Services',
    companyUrl: 'https://www.linkedin.com/company/indi-staffing-services',
    location: 'Cali, Valle del Cauca, Colombia',
    date: null,
    url: 'https://www.linkedin.com/jobs/view/4449642850',
    description: 'At INDI, we are passionate about empowering individuals…',
    seniority: 'Mid-Senior level',
    employmentType: 'Full-time',
    jobFunction: 'Information Technology',
    industries: 'Staffing and Recruiting',
    applyUrl: null
  }

  const det = SCHEMAS_INTERNOS.DetailSchema.safeParse(DETALLE_REAL)
  check('el detalle real parsea', det.success, true)
  check(
    'y la descripción llega entera',
    det.success ? det.data.description : '',
    DETALLE_REAL.description
  )
  check('un applyUrl null no rompe nada', det.success ? det.data.applyUrl : 'x', '')

  const RESULTADO_REAL = {
    id: '4448573564',
    title: 'Frontend Developer',
    company: 'FOX Analytics',
    companyUrl: 'https://es.linkedin.com/company/fox-analytics-es',
    location: 'Colombia',
    date: '2026-08-04',
    url: 'https://co.linkedin.com/jobs/view/frontend-developer-at-fox-analytics-4448573564'
  }
  check('el resultado real parsea', SCHEMAS_INTERNOS.ResultSchema.safeParse(RESULTADO_REAL).success, true)
  check(
    'y una vacante sin fecha no se descarta',
    SCHEMAS_INTERNOS.ResultSchema.safeParse({ ...RESULTADO_REAL, date: null }).success,
    true
  )

  // ── ASSERT 15 · dedupe por id, no por string ─────────────────────────────
  seccion('assert 15 · la misma vacante en dos hosts es una sola')

  check(
    'co. y www. de la misma vacante son la misma clave',
    claveDedupe('https://co.linkedin.com/jobs/view/frontend-at-x-4448573564') ===
      claveDedupe('https://www.linkedin.com/jobs/view/4448573564'),
    true
  )
  check(
    'vacantes distintas no colisionan',
    claveDedupe('https://co.linkedin.com/jobs/view/a-4448573564') ===
      claveDedupe('https://co.linkedin.com/jobs/view/b-4447349957'),
    false
  )
  check(
    'una URL sin id numérico cae al string normalizado',
    claveDedupe('https://JOBS.lever.co/Empresa/abc/'),
    'jobs.lever.co/empresa/abc'
  )

  // ── ASSERT 11 · sumar un agente es una entrada ───────────────────────────
  seccion('assert 11 · el registro de agentes es una lista, no un if')

  const { AGENTES } = await import('../src/main/agents/registry')
  check('hoy hay un agente registrado', AGENTES.length, 1)
  check('es el de búsqueda de trabajo', AGENTES[0].id, 'job-search')
  check('cada agente declara cómo chequearse', typeof AGENTES[0].chequear, 'function')
  // Se verifican los campos OBLIGATORIOS, no la lista exacta: un agente puede
  // declarar cosas opcionales —su plantilla de reglas, por ejemplo— y eso no
  // puede romper el chequeo del registro.
  check(
    'toda entrada trae id + nombre + descripción + chequear',
    ['id', 'nombre', 'descripcion', 'chequear'].every((k) =>
      AGENTES.every((a) => k in a && (a as unknown as Record<string, unknown>)[k] !== undefined)
    ),
    true
  )

  const total = pasados + fallados
  console.log(`\n${'='.repeat(60)}`)
  console.log(`AGENTES · NOTION · CORREO · TRIAGE   ${pasados}/${total} ${fallados === 0 ? '✓' : '✗'}`)
  if (fallados > 0) {
    console.log('')
    for (const f of fallas) console.log(`  ✗ ${f}`)
  }
  console.log('='.repeat(60))

  process.exit(fallados === 0 ? 0 : 1)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
