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
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseProfile } from '../src/main/core/jobs/profile'
import {
  NOTION_STATUSES,
  notionStatus,
  notionProperties,
  truncate,
  scrubPii,
  type NotionRow
} from '../src/main/core/jobs/notion-map'
import {
  buildMime,
  encodeHeader,
  isValidEmail,
  extractEmailFromJob,
  toGmailRaw,
  type EmailDraft
} from '../src/main/core/jobs/email'
import { applyFloor, QUALITY_FLOOR, type RankedJob } from '../src/main/core/jobs/rank'
import { dedupeKey } from '../src/main/jobs/search'
import { PROFILE_FILE, workspaceDir } from '../src/main/jobs/workspace'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    const l = `${name}\n          esperado ${JSON.stringify(expected)}\n          real     ${JSON.stringify(actual)}`
    failures.push(l)
    console.log(`  FALLA ${l}`)
  }
}

function section(t: string): void {
  console.log(`\n── ${t}`)
}

/*
 * La ruta del perfil se DERIVA. Acá había la ruta absoluta de una máquina
 * commiteada en el repo como fallback — el "esto no se puede publicar" más
 * concreto que había, porque ni se puede configurar.
 *
 * Ojo con el orden: se calcula ANTES de que los asserts de más abajo pisen
 * `ALBUS_DATA_DIR` con un tmpdir, así que apunta al workspace de verdad.
 */
const PROFILE_PATH = join(workspaceDir(), PROFILE_FILE)

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
  const profile = parseProfile(JSON.parse(await readFile(PROFILE_PATH, 'utf8')))

  // ── ASSERT 1 · el select de Notion no se contamina ───────────────────────
  section('assert 1 · estado interno → opción que existe en el select')

  check('submitted → Applying', notionStatus('submitted'), 'Applying')
  check('filled → Backlog (todavía no es postulación)', notionStatus('filled'), 'Backlog')
  check('ranked → Backlog', notionStatus('ranked'), 'Backlog')
  check('blocked → Backlog', notionStatus('blocked'), 'Backlog')
  check('interview → In process', notionStatus('interview'), 'In process')
  check('rejected → Rejected', notionStatus('rejected'), 'Rejected')
  check('discarded → Descartada', notionStatus('discarded'), 'Descartada')
  check('contacted → First contact', notionStatus('contacted'), 'First contact')
  check('un estado inventado → null, NO una opción nueva', notionStatus('en-llamas'), null)
  check('vacío → null', notionStatus(''), null)

  // Todo lo que el mapa devuelve tiene que existir en el select de la base.
  const possibleStatuses = [
    'submitted', 'filled', 'planned', 'ranked', 'blocked', 'failed',
    'needs-login', 'interview', 'rejected', 'discarded', 'contacted'
  ]
  const outside = possibleStatuses
    .map(notionStatus)
    .filter((e) => e !== null && !(NOTION_STATUSES as readonly string[]).includes(e))
  check('ningún estado mapea fuera del select real', outside, [])

  // ── ASSERT 3 · nada de PII en Notion ─────────────────────────────────────
  section('assert 3 · el teléfono y el correo del candidato no viajan')

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

  const row: NotionRow = {
    company: 'Example Corp',
    role: 'Frontend Developer',
    status: 'Applying',
    date: '2026-08-06',
    fitScore: 72,
    postLink: 'https://co.linkedin.com/jobs/view/x-1',
    contactUrl: 'https://co.linkedin.com/jobs/view/x-1',
    jobDescription: 'React y TypeScript',
    coverLetter: '',
    nextAction: 'Esperando respuesta'
  }
  const props = notionProperties(row)
  const serialized = JSON.stringify(props)

  check('el payload no contiene el email del candidato', serialized.includes(profile.email), false)
  check('el payload no contiene el teléfono', serialized.includes(profile.phone), false)
  check('Company va como title', Object.keys(props.Company as object), ['title'])
  check('Status va como select con nombre válido', (props.Status as { select: { name: string } }).select.name, 'Applying')
  check('un rich_text vacío va como array vacío', (props['cover letter'] as { rich_text: unknown[] }).rich_text, [])
  check('recorta a menos de 2000 (límite de Notion)', truncate('x'.repeat(3000)).length <= 1900, true)

  // ── ASSERT 6 · el MIME del correo ────────────────────────────────────────
  section('assert 6 · el adjunto llega con el nombre del candidato')

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
  const parts = mime.split(`--${BOUNDARY}`)
  const attachmentPart = parts.find((p) => p.includes('CV Jorge David Diaz.pdf')) ?? ''
  const bodyB64 = attachmentPart.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n/g, '').trim()
  const recovered = Buffer.from(bodyB64, 'base64')

  check('los bytes del PDF sobreviven el round-trip', recovered.equals(pdf), true)
  check('las líneas base64 respetan el corte de 76',
    attachmentPart.split('\r\n').filter((l) => /^[A-Za-z0-9+/=]+$/.test(l)).every((l) => l.length <= 76),
    true
  )

  const raw = toGmailRaw(mime)
  check('base64url sin caracteres inválidos para la URL', /^[A-Za-z0-9_-]+$/.test(raw), true)
  check('el raw se decodifica al MIME original', Buffer.from(raw, 'base64url').toString('utf8'), mime)

  check('valida direcciones', isValidEmail('jobs@empresa.com'), true)
  check('rechaza basura', isValidEmail('no-es-un-mail'), false)
  check(
    'saca el correo de la vacante y NO el propio',
    extractEmailFromJob(`Enviar a ${profile.email} o a rrhh@empresa.com`, profile.email),
    'rrhh@empresa.com'
  )
  check(
    'ignora nombres de imagen que parecen mail',
    extractEmailFromJob('logo@2x.png y hr@corp.io', profile.email),
    'hr@corp.io'
  )

  // ── reintento del transitorio de Supabase ────────────────────────────────
  section('supabase · "JWT issued at future" es transitorio y se reintenta')

  const { createFetchWithRetry, IS_TRANSIENT } = await import('../src/main/supabase/retry')

  const response = (status: number, body: string): Response =>
    new Response(body, { status, headers: { 'Content-Type': 'application/json' } })

  const JWT_FUTURE = '{"code":"PGRST301","message":"JWT issued at future"}'
  const BAD_KEY = '{"message":"Invalid API key"}'

  /** fetch falso que devuelve la cola de respuestas y cuenta las llamadas. */
  function fakeFetch(queue: Response[]): { fn: typeof fetch; calls: () => number } {
    let n = 0
    return {
      fn: (async () => {
        const r = queue[Math.min(n, queue.length - 1)]
        n++
        return r.clone()
      }) as unknown as typeof fetch,
      calls: () => n
    }
  }

  check('reconoce el transitorio', IS_TRANSIENT.test('JWT issued at future'), true)
  check('NO confunde una key inválida con transitorio', IS_TRANSIENT.test('Invalid API key'), false)
  check('NO confunde un token expirado', IS_TRANSIENT.test('JWT expired'), false)

  // 1 · camino feliz: una sola llamada.
  const happy = fakeFetch([response(200, '[{"id":1}]')])
  const r1 = await createFetchWithRetry(happy.fn, 0)('https://x/y')
  check('200 a la primera → una sola llamada', happy.calls(), 1)
  check('200 → devuelve 200', r1.status, 200)
  check('el cuerpo sigue legible para quien llamó', await r1.text(), '[{"id":1}]')

  // 2 · el caso real: falla una vez, anda a la segunda.
  const transient = fakeFetch([response(401, JWT_FUTURE), response(200, '[{"id":2}]')])
  const r2 = await createFetchWithRetry(transient.fn, 0)('https://x/y')
  check('transitorio → reintenta', transient.calls(), 2)
  check('transitorio → termina en 200', r2.status, 200)
  check('y el cuerpo bueno llega entero', await r2.text(), '[{"id":2}]')

  // 3 · si no se recupera, corta: no reintenta para siempre.
  const persistent = fakeFetch([response(401, JWT_FUTURE)])
  const r3 = await createFetchWithRetry(persistent.fn, 0)('https://x/y')
  check('transitorio persistente → 1 + 2 reintentos y basta', persistent.calls(), 3)
  check('y devuelve el error, no cuelga', r3.status, 401)

  // 4 · un error de credenciales de verdad NO se reintenta: hay que verlo ya.
  const credential = fakeFetch([response(401, BAD_KEY)])
  const r4 = await createFetchWithRetry(credential.fn, 0)('https://x/y')
  check('key inválida → una sola llamada', credential.calls(), 1)
  check('key inválida → sale el 401 tal cual', r4.status, 401)

  // 5 · un 500 tampoco: no es esta clase de falla.
  const server = fakeFetch([response(500, '{"message":"boom"}')])
  await createFetchWithRetry(server.fn, 0)('https://x/y')
  check('500 → no se reintenta', server.calls(), 1)

  // ── ASSERTS 1-3 · el bug de "host no permitido" ──────────────────────────
  section('asserts 1-3 · abrir la vacante que el scraper devuelve de verdad')

  const { isOpenableUrl, isApplicableUrl, APPLICABLE_HOSTS, unwrapLinkedInRedirect } = await import(
    '../src/shared/ipc'
  )

  /*
   * El interstitial de LinkedIn. Es la URL EXACTA que rompió la postulación a
   * Monks: pasaba la allowlist por ser linkedin.com, se cargaba con `loadURL`,
   * LinkedIn se comía el `url=` y quedaba la pantalla de "Página no encontrada".
   * Sin desenvolverlo, ninguna postulación externa de LinkedIn puede funcionar.
   */
  const SAFETY_GO =
    'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fwww%2Emonks%2Ecom%2Fcareers%2F6134628004%2Fsenior-frontend-engineer%3Fgh_src%3Da9b949034us&urlhash=Ce2A&isSdui=true'

  check(
    'saca el destino real del interstitial de LinkedIn',
    unwrapLinkedInRedirect(SAFETY_GO),
    'https://www.monks.com/careers/6134628004/senior-frontend-engineer?gh_src=a9b949034us'
  )
  check(
    'una vacante normal de LinkedIn NO es un interstitial',
    unwrapLinkedInRedirect('https://co.linkedin.com/jobs/view/1'),
    null
  )
  check(
    'un host que no es LinkedIn no se desenvuelve',
    unwrapLinkedInRedirect('https://malicioso.com/safety/go/?url=https%3A%2F%2Fx.com'),
    null
  )
  // Un `javascript:` metido en el parámetro es justo el ataque que la allowlist
  // viene a evitar: desenvolverlo sin filtrar el protocolo sería abrirle la puerta.
  check(
    'un destino que no es https se rechaza',
    unwrapLinkedInRedirect('https://www.linkedin.com/safety/go/?url=javascript%3Aalert(1)'),
    null
  )
  check(
    'y sin parámetro url tampoco inventa nada',
    unwrapLinkedInRedirect('https://www.linkedin.com/safety/go/?_l=es_ES'),
    null
  )

  // La URL exacta que falló en su corrida.
  const REAL = 'https://co.linkedin.com/jobs/view/frontend-developer-at-fox-analytics-4448573564'
  check('la URL real del scraper AHORA abre', isOpenableUrl(REAL), true)
  check('y sigue siendo postulable', isApplicableUrl(REAL), true)

  for (const h of ['co', 'es', 'uk', 'www', 'mx', 'br']) {
    check(`${h}.linkedin.com abre`, isOpenableUrl(`https://${h}.linkedin.com/jobs/view/1`), true)
  }
  check('linkedin.com pelado abre', isOpenableUrl('https://linkedin.com/jobs/view/1'), true)

  // El ataque que un `endsWith` ingenuo dejaría pasar.
  check(
    'linkedin.com.malicioso.com NO abre',
    isOpenableUrl('https://linkedin.com.malicioso.com/jobs/view/1'),
    false
  )
  check('evil-linkedin.com NO abre', isOpenableUrl('https://evil-linkedin.com/x'), false)
  check('xlinkedin.com NO abre', isOpenableUrl('https://xlinkedin.com/x'), false)
  check('http:// NO abre aunque el host valga', isOpenableUrl('http://www.linkedin.com/x'), false)
  check('un host cualquiera NO abre', isOpenableUrl('https://malicioso.com/x'), false)

  // El invariante: si Albus puede navegar ahí con tu sesión, abrirlo en tu
  // navegador es estrictamente menos riesgoso. Que no se desincronicen nunca.
  const notOpenable = APPLICABLE_HOSTS.filter((h) => !isOpenableUrl(`https://${h}/x`))
  check('todo host postulable es abrible', notOpenable, [])

  // ── el camino a cero dedos ───────────────────────────────────────────────
  section('conexiones · una sesión de Google desbloquea el resto')

  const registryTs = await readFile('src/main/connections/registry.ts', 'utf8')
  const agentTs = await readFile('src/main/connections/connection-agent.ts', 'utf8')
  const servicesTs = await readFile('src/main/connections/services.ts', 'utf8')
  const sessionTs = await readFile('src/main/browser/session.ts', 'utf8')

  check(
    'existe la sesión de Google en el navegador (distinta del token de API)',
    sessionTs.includes('hasGoogleBrowserSession') && sessionTs.includes('openGoogleLoginWindow'),
    true
  )
  check(
    'está registrada como conexión propia',
    registryTs.includes("id: 'google-browser'"),
    true
  )
  check(
    'va ANTES de LinkedIn en la lista: es la que desbloquea',
    registryTs.indexOf("'google-browser'") < registryTs.indexOf("id: 'linkedin'"),
    true
  )
  check(
    'el agente intenta entrar por SSO antes de pedirte nada',
    /sin escribir credenciales|SIN escribir credenciales/i.test(agentTs),
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
    /es IMPOSIBLE/.test(agentTs),
    true
  )

  // ── un motor, no un archivo por servicio ─────────────────────────────────
  section('conexiones · sumar un servicio es una fila de datos, no código')

  check(
    'no quedó ningún adaptador por servicio',
    existsSync('src/main/connections/notion-auto.ts'),
    false
  )
  check(
    'el motor es uno solo y no nombra a Notion en su lógica',
    /notion/i.test(agentTs.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')),
    false
  )
  check(
    'Notion y Supabase salen de la MISMA tabla',
    servicesTs.includes("id: 'notion'") && servicesTs.includes("id: 'supabase'"),
    true
  )
  check(
    'un servicio se declara con url + objetivos + patrón del secreto',
    /url:/.test(servicesTs) && /goals:/.test(servicesTs) && /secretPattern:/.test(servicesTs),
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
  section('conexiones · hay paneles que solo dejan copiar el token')

  check(
    'se busca también en el portapapeles, no solo en la pantalla',
    agentTs.includes('clipboard.readText'),
    true
  )
  check(
    'el portapapeles se VACÍA antes de empezar',
    agentTs.includes("clipboard.writeText('')"),
    true
  )
  check(
    'y lo que el usuario tenía copiado se le devuelve',
    agentTs.includes('restoreClipboard'),
    true
  )
  check(
    'si los objetivos terminan sin credencial, se intenta un rescate',
    /solo ofrece un botón de COPIAR/i.test(agentTs),
    true
  )

  // ── reglas por agente ────────────────────────────────────────────────────
  section('reglas · un .md que el usuario edita, no una pantalla de config')

  const { parseRules } = await import('../src/main/agents/rules')

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

  const r = parseRules('job-search', md, 'x.md', true)

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
  check('el primero de la lista es el que gana', r.notion[0].label, 'Registro de aplicaciones')
  check('guarda la etiqueta que escribió el usuario', r.notion[0].label, 'Registro de aplicaciones')
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
  check('el texto completo queda para el agente', r.text.includes('nada con Java'), true)

  // ── el resumen: lo que el usuario VE ─────────────────────────────────────
  // Mostraba "Notion · Registro de aplicaciones" y el reclamo fue "eso no me
  // dice nada". Ahora muestra las reglas escritas, y estos asserts cuidan que
  // no se cuele el andamiaje de la plantilla.
  const withRules = parseRules(
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

  check('el resumen NO trae los títulos', withRules.summary.some((l) => l.includes('Título')), false)
  check(
    'ni la prosa del instructivo, que además se corta en varias líneas',
    withRules.summary.some((l) => l.includes('instructivo')),
    false
  )
  check('una viñeta vacía como "Roles:" no cuenta', withRules.summary.includes('Roles:'), false)
  check(
    'una línea que era SOLO un link desaparece del resumen',
    withRules.summary.some((l) => l.includes('notion.so')),
    false
  )
  check('pero el link sigue contando para saber a dónde escribe', withRules.notion.length, 1)
  check('quedan las reglas de verdad', withRules.summary, [
    'nada con Java ni turnos de noche',
    'Ubicación: Colombia'
  ])


  const { JOB_SEARCH_SEED } = await import('../src/main/agents/seeds')

  // Sin archivo, el resumen va VACÍO aunque haya plantilla: si no, un agente
  // recién creado muestra los ejemplos del instructivo como reglas propias y
  // el botón dice "escribir las primeras" arriba de una lista llena.
  const { readRules } = await import('../src/main/agents/rules')
  const missing = readRules('no-existe-este-agente', JOB_SEARCH_SEED.rulesTemplate)
  check('sin archivo, el resumen está vacío', missing.summary.length, 0)
  check('y tampoco hereda los links de la plantilla', missing.notion.length, 0)
  check('pero el texto de la plantilla sí viaja, para poder crearla', missing.text.length > 100, true)
  check(
    'y la plantilla trae sus links de ejemplo COMENTADOS',
    /<!--[\s\S]*notion\.so[\s\S]*-->/.test(JOB_SEARCH_SEED.rulesTemplate),
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
    /setNotionDatabaseIdResolver[\s\S]{0,400}readRules/.test(registryTs),
    true
  )

  // ── el chat del agente de trabajo ────────────────────────────────────────
  section('chat · un comando se resuelve con reglas; una pregunta, con el modelo')

  const { interpret, resolveJob } = await import('../src/main/core/jobs/chat')

  const onScreen = [
    { id: 'a', company: 'Luxury Presence', title: 'Design Engineer', score: 82 },
    { id: 'b', company: 'Jobgether', title: 'Software Craftsperson', score: 74 },
    { id: 'c', company: 'Truelogic Software', title: 'Semi-Senior Frontend', score: 68 }
  ]

  check('buscar', interpret('buscame trabajo, hacé un barrido', []).kind, 'search')
  check(
    'con roles: lo que pidió, no lo que suponemos',
    (interpret('buscame trabajo de react developer', []) as { queries: string[] }).queries,
    ['react developer']
  )
  check(
    'sin roles queda VACÍO: mandan las reglas, no un default inventado',
    (interpret('buscame trabajo', []) as { queries: string[] }).queries,
    []
  )
  check(
    'la ubicación necesita preposición: si no, "React" sería un país',
    (interpret('buscame frontend en Colombia', []) as { location: string | null }).location,
    'Colombia'
  )

  check('postular por posición', interpret('postulate a la primera', onScreen), {
    kind: 'apply',
    id: 'a'
  })
  check('postular por número', interpret('aplicá a la 2', onScreen), {
    kind: 'apply',
    id: 'b'
  })
  check('postular por empresa', interpret('postulate a Truelogic', onScreen), {
    kind: 'apply',
    id: 'c'
  })
  check('mostrar la evidencia', interpret('mostrame cómo quedó la 1', onScreen), {
    kind: 'show',
    id: 'a'
  })
  check('pasame el archivo también es mostrar', interpret('pasame el CV de la 1', onScreen).kind, 'show')
  check('enviar lo que quedó frenado', interpret('dale, mandala', [onScreen[0]]), {
    kind: 'send',
    id: 'a'
  })
  check('descartar', interpret('esa no me interesa', [onScreen[1]]), {
    kind: 'discard',
    id: 'b'
  })

  /*
   * Lo que NO se puede adivinar. Postularse a la vacante equivocada no se
   * deshace: se le escribió a un reclutador real con el CV de otro puesto.
   */
  check(
    'con tres en pantalla y sin decir cuál, PREGUNTA',
    interpret('postulate', onScreen).kind,
    'ambiguous'
  )
  check(
    'con una sola en pantalla, "postulate" no es ambiguo',
    interpret('postulate', [onScreen[0]]),
    { kind: 'apply', id: 'a' }
  )
  check(
    'un número fuera de rango no elige la última por las dudas',
    interpret('postulate a la 9', onScreen).kind,
    'ambiguous'
  )

  // Lo que una regla no puede contestar va al modelo, y NO se responde
  // "no entendí": eso es la forma más rápida de que el usuario deje de escribir.
  check(
    'una pregunta de verdad va al modelo',
    interpret('¿por qué descartaste las otras nueve?', onScreen).kind,
    'chat'
  )
  check(
    'y llega con el texto entero, sin recortar',
    (interpret('¿cuál me conviene más?', onScreen) as { text: string }).text,
    '¿cuál me conviene más?'
  )

  check('sin nada escrito, ayuda', interpret('   ', onScreen).kind, 'help')
  check('sin vacantes en pantalla no se puede elegir', resolveJob('la 1', []), null)

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
    /firstAvailableProvider/.test(jobsIpcTs),
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
  section('conexiones · el conector describe lo que DA, no lo que un agente hace')

  const { SERVICES } = await import('../src/main/connections/registry')

  /*
   * "Espeja tus postulaciones", "Manda las postulaciones por correo", "Deja
   * que Albus complete los formularios": todos describían al agente de trabajo.
   * Un conector es una capacidad de la app; qué se hace con ella lo deciden las
   * reglas del agente, y mañana hay tres agentes usando el mismo Notion.
   */
  const TALKS_ABOUT_AGENTS = /postulaci|postular|vacante|CV|formulario de postulaci|trabajo/i
  const contaminated = SERVICES.filter((s) => TALKS_ABOUT_AGENTS.test(s.purpose)).map((s) => s.id)
  check('ningún conector menciona lo que hace un agente con él', contaminated, [])

  check(
    'todos dicen algo, y en una línea',
    SERVICES.every((s) => s.purpose.length > 20 && s.purpose.length < 120),
    true
  )

  // Google era DOS tarjetas idénticas —token de API y sesión de navegador— y
  // nadie entendía por qué. Siguen siendo entradas distintas (son mecanismos
  // distintos), pero comparten grupo y se pintan juntas.
  const google = SERVICES.filter((s) => s.group === 'google')
  check('las dos entradas de Google comparten grupo', google.length, 2)
  check(
    'y cada una dice qué permiso aporta',
    google.every((s) => (s.capability ?? '').length > 3),
    true
  )
  check(
    'ninguna se llama "Google (navegador)": el paréntesis era el síntoma',
    SERVICES.some((s) => s.name.includes('(')),
    false
  )

  // ── preguntas del agente ─────────────────────────────────────────────────
  section('preguntas · una respuesta se vuelve una regla, no un formulario')

  const q = await import('../src/main/agents/questions')

  // El bloque que se anexa al .md se verifica sin tocar disco.
  const block = q.answerBlock(
    '¿Con qué nombre guardo el CV?',
    'con el nombre del candidato, no el de la vacante',
    '2026-08-08T10:00:00.000Z'
  )

  check(
    'la respuesta se anexa como VIÑETA: así el resumen la lee como regla',
    /^\s*-\s/m.test(block),
    true
  )
  check(
    'la pregunta original queda en un comentario, para acordarse en marzo',
    /<!--.*¿Con qué nombre guardo el CV\?.*-->/.test(block),
    true
  )
  check('con la fecha en que se respondió', block.includes('2026-08-08'), true)

  // El comentario NO puede contar como regla: si contara, cada respuesta
  // aparecería dos veces en el panel —la regla y la pregunta—.
  const withAnswer = parseRules('x', `# Reglas${block}`, 'x.md', true)
  check('la regla nueva entra al resumen', withAnswer.summary.length, 1)
  check(
    'y el comentario con la pregunta NO se cuela como otra regla',
    withAnswer.summary[0],
    'con el nombre del candidato, no el de la vacante'
  )

  // La misma duda veinte veces es UNA pregunta. Sin esto, veinte postulaciones
  // con el mismo campo sin resolver llenan el panel y el usuario lo abandona.
  /*
   * El chequeo escribe en una carpeta TEMPORAL, no en la del usuario.
   *
   * Antes usaba `agentsDir()` a secas, o sea la carpeta real: estos asserts
   * dejaban `chequeo-preguntas.md` y su `.preguntas.json` al lado del
   * `job-search.md` de verdad. Ya causó un daño concreto —la carpeta que este
   * chequeo creaba hacía que la migración de datos se diera por hecha y las
   * reglas del usuario quedaran atrás— y el potencial era peor: un bug en
   * `answerQuestion` acá se le come las reglas al usuario mientras corre un test.
   *
   * `ALBUS_DATA_DIR` existe para esto y para que la carpeta se pueda mover.
   */
  const AG = 'chequeo-preguntas'
  process.env.ALBUS_DATA_DIR = join(tmpdir(), `albus-check-${process.pid}`)

  const questionsPath = join(
    (await import('../src/main/paths')).agentsDir(),
    `${AG}.preguntas.json`
  )
  if (existsSync(questionsPath)) rmSync(questionsPath)

  const p1 = q.enqueueQuestion(AG, '¿Qué formato uso?', { now: '2026-08-08T10:00:00.000Z' })
  const p2 = q.enqueueQuestion(AG, '¿Qué formato uso?', { now: '2026-08-08T11:00:00.000Z' })
  check('la misma pregunta no se duplica', p1.id, p2.id)
  check('y queda una sola pendiente', q.pending(AG).length, 1)

  q.answerQuestion(AG, p1.id, 'PDF siempre', '2026-08-08T12:00:00.000Z')
  check('respondida deja de estar pendiente', q.pending(AG).length, 0)
  check('y pasa a las respondidas', q.answered(AG)[0]?.answer, 'PDF siempre')

  // Respondida, la MISMA pregunta puede volver a encolarse si el agente
  // insiste — pero eso es una señal de que la respuesta no le alcanzó, no un
  // duplicado. Lo que no puede es reaparecer sola.
  check('no reaparece sola después de responderla', q.pending(AG).length, 0)

  rmSync(questionsPath, { force: true })
  rmSync(join((await import('../src/main/paths')).agentsDir(), `${AG}.md`), { force: true })

  // ── albus.yml ────────────────────────────────────────────────────────────
  section('albus.yml · un solo archivo de llaves, legible y editable')

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
  check('guardar escribe en albus.yml', /writeToAlbusYml\(ymlKey/.test(storeTs), true)
  check(
    'y leer lo consulta ANTES que lo cifrado y que el .env',
    storeTs.indexOf('fromAlbusYml(ymlKey(key))') < storeTs.indexOf('safeStorage.decryptString'),
    true
  )
  check(
    'desconectar borra de los DOS lados, si no el token reaparece al reiniciar',
    /deleteFromAlbusYml[\s\S]{0,400}writeRaw/.test(storeTs),
    true
  )
  check(
    'las llaves se ven como las del .env (notion.token → NOTION_TOKEN)',
    /replace\(\/\\\.\/g, '_'\)\.toUpperCase\(\)/.test(storeTs),
    true
  )

  // El parser es propio: se prueba de verdad, no por su forma.
  const { parseYml } = await import('../src/main/connections/albus-yml')
  const sample = parseYml(
    ['# un comentario', 'NOTION_TOKEN: "ntn_abc#123"', 'VACIA:', 'OTRA: sin-comillas # cola', ''].join(
      '\n'
    )
  )
  check('un # dentro de comillas es parte del token', sample.NOTION_TOKEN, 'ntn_abc#123')
  check('sin comillas, el # sí corta', sample.OTRA, 'sin-comillas')
  check('una clave sin valor queda vacía, no rompe', sample.VACIA, '')
  check('los comentarios no entran', Object.keys(sample).length, 3)

  // ── una sola instancia ───────────────────────────────────────────────────
  section('instancia única · dos Albus rompen el almacenamiento de Chromium')

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
  section('assert 9 · solo `auto` manda; `review` deja un borrador')

  const { gmailMode } = await import('../src/main/core/jobs/email')
  check('review → borrador', gmailMode('review'), 'draft')
  check('auto → manda', gmailMode('auto'), 'send')
  check('dry-run → ni borrador', gmailMode('dry-run'), 'none')

  // ── ASSERT 5 · sin credencial se falla ruidoso ───────────────────────────
  section('assert 5 · sin NOTION_TOKEN falla con la instrucción, no en silencio')

  const saved = process.env.NOTION_TOKEN
  delete process.env.NOTION_TOKEN

  const { isNotionConfigured, notionFetch } = await import('../src/main/notion/client')
  check('se detecta que no está configurado', isNotionConfigured(), false)

  let message = ''
  try {
    await notionFetch('/users/me')
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error)
  }
  check('tira, no devuelve undefined', message.length > 0, true)
  check('el error nombra la variable que falta', message.includes('NOTION_TOKEN'), true)
  check('y dice dónde crearla', message.includes('my-integrations'), true)

  if (saved !== undefined) process.env.NOTION_TOKEN = saved

  // ── ASSERT 16 · el piso de calidad no se rellena ─────────────────────────
  section('assert 16 · con dos buenas devuelve dos, no inventa una tercera')

  const batch = [
    job({ id: 'a', score: 88 }),
    job({ id: 'b', score: 71 }),
    job({ id: 'c', score: 64 }),
    job({ id: 'd', score: 92, gates: ['requires-relocation'] }),
    job({ id: 'e', score: 40 })
  ]
  const { qualified, rejected } = applyFloor(batch)

  check('pasan exactamente dos', qualified.map((j) => j.id), ['a', 'b'])
  check('64 no pasa (el piso es 65)', rejected.some((j) => j.id === 'c'), true)
  check('un corte duro descalifica aunque el puntaje sea 92', rejected.some((j) => j.id === 'd'), true)
  check('vienen ordenadas por puntaje', qualified[0].score >= qualified[1].score, true)
  check('el piso es 65', QUALITY_FLOOR, 65)
  check('sin candidatas devuelve vacío, no un placeholder', applyFloor([]).qualified, [])
  check(
    'justo en 65 pasa',
    applyFloor([job({ id: 'x', score: 65 })]).qualified.map((j) => j.id),
    ['x']
  )

  // ── el parseo del CLI contra su forma REAL ───────────────────────────────
  section('search · un `null` no puede tragarse la descripción entera')

  const { INTERNAL_SCHEMAS } = await import('../src/main/jobs/search')

  // Copiado tal cual de una corrida del CLI. Los `null` son de LinkedIn, no
  // inventados: son los campos que no publica.
  const REAL_DETAIL = {
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

  const det = INTERNAL_SCHEMAS.DetailSchema.safeParse(REAL_DETAIL)
  check('el detalle real parsea', det.success, true)
  check(
    'y la descripción llega entera',
    det.success ? det.data.description : '',
    REAL_DETAIL.description
  )
  check('un applyUrl null no rompe nada', det.success ? det.data.applyUrl : 'x', '')

  const REAL_RESULT = {
    id: '4448573564',
    title: 'Frontend Developer',
    company: 'FOX Analytics',
    companyUrl: 'https://es.linkedin.com/company/fox-analytics-es',
    location: 'Colombia',
    date: '2026-08-04',
    url: 'https://co.linkedin.com/jobs/view/frontend-developer-at-fox-analytics-4448573564'
  }
  check('el resultado real parsea', INTERNAL_SCHEMAS.ResultSchema.safeParse(REAL_RESULT).success, true)
  check(
    'y una vacante sin fecha no se descarta',
    INTERNAL_SCHEMAS.ResultSchema.safeParse({ ...REAL_RESULT, date: null }).success,
    true
  )

  // ── ASSERT 15 · dedupe por id, no por string ─────────────────────────────
  section('assert 15 · la misma vacante en dos hosts es una sola')

  check(
    'co. y www. de la misma vacante son la misma clave',
    dedupeKey('https://co.linkedin.com/jobs/view/frontend-at-x-4448573564') ===
      dedupeKey('https://www.linkedin.com/jobs/view/4448573564'),
    true
  )
  check(
    'vacantes distintas no colisionan',
    dedupeKey('https://co.linkedin.com/jobs/view/a-4448573564') ===
      dedupeKey('https://co.linkedin.com/jobs/view/b-4447349957'),
    false
  )
  check(
    'una URL sin id numérico cae al string normalizado',
    dedupeKey('https://JOBS.lever.co/Empresa/abc/'),
    'jobs.lever.co/empresa/abc'
  )

  /*
   * ── ASSERT 11 · un agente es un ARCHIVO del usuario, no una entrada de código
   *
   * Antes este assert verificaba lo contrario: que `AGENTS` fuera un array con
   * una entrada y una función `check` por agente. Era coherente con el diseño de
   * entonces y ese diseño era el problema — para sumar un agente había que editar
   * el array, o sea bajarse el código fuente. Ahora el registro lee
   * `userData/agentes/*.agente.json` y lo que se verifica es que el agente que
   * TRAE la app no tenga un camino privilegiado: si la semilla no valida con el
   * mismo schema que un archivo escrito a mano, sigue siendo un caso especial del
   * código disfrazado de dato.
   */
  section('assert 11 · un agente es un archivo, y el de fábrica no es especial')

  const { AgentManifestSchema, AGENT_NEEDS } = await import('../src/main/agents/manifest')

  const seeded = AgentManifestSchema.safeParse(JOB_SEARCH_SEED.manifest)
  check('la semilla valida con el schema de un archivo del usuario', seeded.success, true)
  check('y declara objetivos: el flujo es dato, no código', JOB_SEARCH_SEED.manifest.goals.length > 0, true)
  check(
    'sus dependencias salen del enum cerrado, que es el que tiene sondas',
    JOB_SEARCH_SEED.manifest.needs.every((n) => (AGENT_NEEDS as readonly string[]).includes(n)),
    true
  )
  check(
    'tools vacío = todas: recortar capacidades es dato del usuario',
    JOB_SEARCH_SEED.manifest.tools.length,
    0
  )

  // Una dependencia que ya no existe NO invalida el archivo: se descarta y el
  // agente sigue abriendo. Un manifiesto viejo tiene que sobrevivir al upgrade.
  const withJunk = AgentManifestSchema.safeParse({ name: 'X', needs: ['notion', 'fax'] })
  check('un "need" desconocido se descarta, no rompe el manifiesto', withJunk.success, true)
  check('y queda solo el que sí existe', withJunk.success ? withJunk.data.needs : [], ['notion'])

  // Lo mínimo es el nombre: todo lo demás tiene default. Un agente que el
  // usuario escriba con dos líneas tiene que funcionar.
  const minimal = AgentManifestSchema.safeParse({ name: 'Mi agente' })
  check('un manifiesto de una sola clave alcanza', minimal.success, true)
  check('sin nombre NO alcanza: sería un agente sin identidad', AgentManifestSchema.safeParse({}).success, false)

  /*
   * ── ASSERT 12 · el agente sabe qué postulación está abierta
   *
   * El bug: el usuario decía "sí manda, pero rellená estos datos" y el agente
   * contestaba "¿cuál es el id de la vacante donde estás rellenando el formulario?
   * hay varias en pantalla". No era terquedad — su contexto tenía las vacantes que
   * se MUESTRAN y nada que dijera cuál estaba abierta en el navegador.
   */
  section('assert 12 · el agente sabe cuál postulación está abierta')

  const { buildAgentPrompt } = await import('../src/main/core/jobs/agent')
  const { JOB_TOOLS } = await import('../src/main/jobs/agent-tools')

  const baseCtx = {
    rules: '',
    tools: JOB_TOOLS,
    screen: [
      { id: 'a', company: 'BairesDev', title: 'UI Engineer', score: 70, kitReady: true },
      { id: 'b', company: 'Monks', title: 'Senior Frontend Engineer', score: 80, kitReady: true }
    ],
    history: [],
    message: 'si pero debes rellenar estas preguntas'
  }

  const withOpen = buildAgentPrompt({
    ...baseCtx,
    openApplication: {
      id: 'b',
      company: 'Monks',
      role: 'Senior Frontend Engineer',
      url: 'https://www.monks.com/careers/1',
      unresolved: ['What is your level of English?']
    }
  })

  /*
   * Se busca el ENCABEZADO en su propio renglón, no la frase suelta.
   *
   * La descripción de `completar_formulario` nombra la sección —"ver POSTULACIÓN
   * ABIERTA AHORA MISMO"— y las descripciones de las herramientas están SIEMPRE en
   * el prompt. Un `includes` ingenuo da positivo aunque no haya ninguna abierta, y
   * el assert de más abajo dejaría de proteger nada.
   */
  const HEADER = '\nPOSTULACIÓN ABIERTA AHORA MISMO\n'

  check('el prompt dice cuál está abierta', withOpen.includes(HEADER), true)
  check('con su id, para que no lo tenga que adivinar', withOpen.includes('id=b'), true)
  check('y los campos que faltaron', withOpen.includes('What is your level of English?'), true)
  check(
    'y le prohíbe preguntar cuál es',
    /No le preguntes cuál es/.test(withOpen),
    true
  )

  // Sin postulación abierta el bloque NO aparece: un encabezado vacío invita al
  // modelo a inventar que hay una.
  const withoutOpen = buildAgentPrompt({ ...baseCtx, openApplication: null })
  check('sin ninguna abierta no se menciona', withoutOpen.includes(HEADER), false)

  check(
    'y existe la herramienta para trabajar sobre ella',
    JOB_TOOLS.some((t) => t.name === 'completar_formulario'),
    true
  )

  /*
   * El PERFIL viaja al agente. Sin esto preguntaba lo que la app ya sabía:
   * "Necesito tu nivel de inglés. ¿B1, B2, C1 o C2?" — teniendo `englishLevel` en el
   * JSON y el formulario ya mostrándolo lleno.
   */
  // `profile` es el que este chequeo ya cargó del workspace, más arriba.
  const withProfile = buildAgentPrompt({ ...baseCtx, profile })

  check('el prompt lleva los DATOS del candidato', withProfile.includes('DATOS DEL CANDIDATO'), true)
  check(
    'incluido el nivel de inglés, que venía preguntando',
    withProfile.includes(`inglés ${profile.englishLevel}`),
    true
  )
  check(
    'y le prohíbe preguntar lo que ya tiene',
    /NO le preguntes al usuario nada que esté en esta lista/.test(withProfile),
    true
  )
  // Sin perfil el bloque no aparece: el agente puede buscar y puntuar igual, solo
  // que no puede contestar campos por su cuenta.
  check(
    'sin perfil no se inventa el bloque',
    buildAgentPrompt({ ...baseCtx, profile: null }).includes('DATOS DEL CANDIDATO'),
    false
  )

  const total = passed + failed
  console.log(`\n${'='.repeat(60)}`)
  console.log(`AGENTES · NOTION · CORREO · TRIAGE   ${passed}/${total} ${failed === 0 ? '✓' : '✗'}`)
  if (failed > 0) {
    console.log('')
    for (const f of failures) console.log(`  ✗ ${f}`)
  }
  console.log('='.repeat(60))

  process.exit(failed === 0 ? 0 : 1)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
