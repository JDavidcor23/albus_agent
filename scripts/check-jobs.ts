/**
 * Verificador del dominio de postulación. Corre sin Electron y sin red:
 *
 *   npx tsx scripts/check-jobs.ts
 *
 * Cubre los asserts que no necesitan un navegador vivo. Los que sí (leer un
 * formulario real, subir un archivo, no tocar el submit) están en
 * `src/main/devtools/selftest.ts` y se corren con ALBUS_JOBS_SELFTEST=1.
 *
 * Sale con código 1 si algo falla, para poder encadenarlo.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { answerByRules, haystack, resolveOption, yearsFor } from '../src/main/core/jobs/answers'
import { parseProfile } from '../src/main/core/jobs/profile'
import { cvUploadName, sanitizeFileName, uploadFileName } from '../src/main/core/jobs/cv-name'
import { canClick, classifyButton } from '../src/main/core/jobs/submit-guard'
import { planStep } from '../src/main/core/jobs/apply'
import type { FormField, FormModel } from '../src/main/core/jobs/types'
import { csvEscape, parseCsv, toCsvLine } from '../src/main/jobs/tracker'
import { PROFILE_FILE, workspaceDir } from '../src/main/jobs/workspace'
import type { TrackerRow } from '../src/main/core/jobs/ports'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    const line = `${name}\n          esperado ${JSON.stringify(expected)}\n          real     ${JSON.stringify(actual)}`
    failures.push(line)
    console.log(`  FALLA ${line}`)
  }
}

function section(title: string): void {
  console.log(`\n── ${title}`)
}

/*
 * ── perfil de prueba: el real, para que los asserts midan lo que se usa ─────
 *
 * La ruta se DERIVA de `workspaceDir()`. Acá había
 * `process.env.JOB_WORKSPACE_DIR ?? 'C:/Users/jdiaz483/Documents/work/dream/…'`:
 * la ruta absoluta de una máquina, commiteada en el repo. Ese literal era el "esto
 * no se puede publicar" más concreto que había — más que cualquier variable de
 * entorno, porque ni se puede configurar.
 */
const PROFILE_PATH = join(workspaceDir(), PROFILE_FILE)

function field(p: Partial<FormField>): FormField {
  return {
    id: p.id ?? 'f0',
    selector: `[data-albus-fid="${p.id ?? 'f0'}"]`,
    kind: p.kind ?? 'text',
    label: p.label ?? '',
    name: p.name ?? '',
    placeholder: p.placeholder ?? '',
    required: p.required ?? false,
    value: p.value ?? '',
    options: p.options ?? [],
    maxLength: p.maxLength ?? null
  }
}

async function main(): Promise<void> {
  const profile = parseProfile(JSON.parse(await readFile(PROFILE_PATH, 'utf8')))

  // ── ASSERT 2 · las reglas resuelven los campos canónicos ─────────────────
  section('assert 2 · mapeo por reglas (sin LLM, sin red)')

  const fields: FormField[] = [
    field({ id: 'a', label: 'First name' }),
    field({ id: 'b', label: 'Last name' }),
    field({ id: 'c', label: 'Email address', kind: 'email' }),
    field({
      id: 'd',
      label: 'Phone country code',
      kind: 'select',
      options: [
        { value: 'us', label: '+1 United States' },
        { value: 'co', label: '+57 Colombia' }
      ]
    }),
    field({ id: 'e', label: 'Mobile phone number', kind: 'tel' }),
    field({ id: 'f', label: 'City' }),
    field({
      id: 'g',
      label: 'Country of residence',
      kind: 'select',
      options: [
        { value: 'ar', label: 'Argentina' },
        { value: 'co', label: 'Colombia' }
      ]
    }),
    field({ id: 'h', label: 'LinkedIn profile URL', kind: 'url' }),
    field({ id: 'i', label: 'GitHub profile', kind: 'url' }),
    field({ id: 'j', label: 'Portfolio or personal website', kind: 'url' }),
    field({
      id: 'k',
      label: 'How many years of work experience do you have with React?',
      kind: 'number'
    }),
    field({
      id: 'l',
      label: 'Are you legally authorized to work in Colombia?',
      kind: 'radio',
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' }
      ]
    }),
    field({
      id: 'm',
      label: 'Will you now or in the future require visa sponsorship?',
      kind: 'radio',
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' }
      ]
    }),
    field({
      id: 'n',
      label: 'Are you willing to relocate for this role?',
      kind: 'radio',
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' }
      ]
    }),
    field({ id: 'o', label: 'Expected salary' }),
    field({ id: 'p', label: 'What is your notice period?' }),
    field({
      id: 'q',
      label: 'English proficiency',
      kind: 'select',
      options: [
        { value: 'basic', label: 'Basic' },
        { value: 'conv', label: 'Conversational (B2+)' },
        { value: 'native', label: 'Native' }
      ]
    }),
    field({ id: 'r', label: 'Current company' }),
    field({ id: 's', label: 'Current job title' }),
    field({
      id: 't',
      label: 'Gender',
      kind: 'select',
      options: [
        { value: 'm', label: 'Male' },
        { value: 'd', label: 'Decline to self-identify' }
      ]
    })
  ]

  const { answers, pending, humanOnly } = answerByRules(fields, profile)
  const byId = new Map(answers.map((a) => [a.fieldId, a.value]))

  check('reglas resuelven ≥12 campos', answers.length >= 12, true)
  check('first name', byId.get('a'), profile.firstName)
  check('last name', byId.get('b'), profile.lastName)
  check('email', byId.get('c'), profile.email)
  check('código de país (select por coincidencia parcial)', byId.get('d'), 'co')
  check('teléfono', byId.get('e'), profile.phone)
  check('ciudad', byId.get('f'), `${profile.city}, ${profile.country}`)
  check('país (select)', byId.get('g'), 'co')
  check('linkedin', byId.get('h'), profile.linkedinUrl)
  check('github', byId.get('i'), profile.githubUrl)
  check('portfolio', byId.get('j'), profile.portfolioUrl)
  check('años con React', byId.get('k'), String(profile.yearsExperience.react))
  check('autorizado a trabajar → Yes', byId.get('l'), 'Yes')
  check('requiere sponsorship → No', byId.get('m'), 'No')
  check('se muda → No', byId.get('n'), 'No')
  check('salario', byId.get('o'), `USD 3,500 / month`)
  check('preaviso', byId.get('p'), `${profile.noticePeriodDays} days notice period`)
  check('inglés (select)', byId.get('q'), 'conv')
  check('empresa actual', byId.get('r'), profile.currentCompany)
  check('cargo actual', byId.get('s'), profile.currentTitle)
  check('EEO → declina', byId.get('t'), 'd')
  check('nada quedó pendiente en este set', pending.length, 0)
  check('nada requiere humano en este set', humanOnly.length, 0)

  // ── honestidad: lo que el perfil no dice, no se contesta ─────────────────
  section('honestidad · no inventar experiencia')

  const withPython = haystack(
    field({ label: 'How many years of work experience do you have with Python?' })
  )
  check('años con Python → sin respuesta', yearsFor(profile, withPython), null)

  const withRust = haystack(field({ label: 'Years of experience with Rust' }))
  check('años con Rust → sin respuesta', yearsFor(profile, withRust), null)

  const generic = haystack(field({ label: 'How many years of professional experience?' }))
  check(
    'años en general → el total real',
    yearsFor(profile, generic),
    String(profile.yearsExperience.default)
  )

  const education = answerByRules(
    [
      field({
        id: 'ed',
        label: 'Highest level of education',
        kind: 'select',
        options: [
          { value: 'hs', label: 'High school' },
          { value: 'ba', label: "Bachelor's degree" },
          { value: 'ma', label: "Master's degree" }
        ]
      })
    ],
    profile
  )
  check(
    'select académico sin opción para bootcamp → NO elige un título',
    education.answers.length,
    0
  )

  const consent = answerByRules(
    [field({ id: 'pv', label: 'I agree to the privacy policy', kind: 'checkbox' })],
    profile
  )
  check('consentimiento → lo firma el humano', consent.humanOnly.length, 1)
  check('consentimiento → Albus no lo contesta', consent.answers.length, 0)

  const noSponsor = answerByRules(
    [
      field({
        id: 'ws',
        label: 'Are you authorized to work in the US without sponsorship?',
        kind: 'radio',
        options: [
          { value: 'Yes', label: 'Yes' },
          { value: 'No', label: 'No' }
        ]
      })
    ],
    profile
  )
  check('"sin sponsorship" invierte la respuesta', noSponsor.answers[0]?.value, 'Yes')

  check(
    'select sin ninguna opción compatible → null, no la primera',
    resolveOption(
      field({
        kind: 'select',
        options: [
          { value: 'a', label: 'Japan' },
          { value: 'b', label: 'Korea' }
        ]
      }),
      'Colombia'
    ),
    null
  )

  check(
    'número contra rangos: 4 años cae en "3-5"',
    resolveOption(
      field({
        kind: 'select',
        options: [
          { value: '1', label: '0-2 years' },
          { value: '2', label: '3-5 years' },
          { value: '3', label: '5+ years' }
        ]
      }),
      '4'
    ),
    '2'
  )

  // ── ASSERT 3 · el nombre del archivo ─────────────────────────────────────
  section('assert 3 · el CV se llama como el candidato, no como la empresa')

  check(
    'nombre de subida del CV',
    cvUploadName(profile, 'C:/ws/cv/main_agileengine.pdf'),
    'CV Jorge David Diaz.pdf'
  )
  check('los espacios se conservan', sanitizeFileName('CV Jorge David Diaz'), 'CV Jorge David Diaz')
  // Se van los ilegales y SOLO los ilegales: el espacio entre "CV" y el nombre
  // sobrevive, que es la mitad del pedido.
  check(
    'los caracteres ilegales de Windows se van, los espacios no',
    sanitizeFileName('CV Jorge/David:Diaz?'),
    'CV JorgeDavidDiaz'
  )
  check('la extensión sale del origen', uploadFileName('Hoja de vida', 'x/y/main_x.PDF'), 'Hoja de vida.pdf')

  // ── ASSERT 6 · el freno del submit ───────────────────────────────────────
  section('assert 6 · el submit es inalcanzable salvo en modo auto')

  check('clasifica "Submit application"', classifyButton('Submit application'), 'submit')
  check('clasifica "Enviar solicitud"', classifyButton('Enviar solicitud'), 'submit')
  check('clasifica "Next"', classifyButton('Next'), 'next')

  /*
   * "Easy Apply" ya NO es una categoría propia, y esto lo fija.
   *
   * Antes devolvía 'apply', y todo lo que caía ahí lo apretaba `canClick` en modo
   * `review` sin que nadie mirara. El agujero: un ATS de una sola pantalla cuyo
   * botón final diga solo "Apply" caía en esa misma categoría —`SUBMIT` tiene
   * `apply now`, no `apply`— y la postulación se enviaba sola. Ahora todo lo que
   * no sea avanzar o enviar es `other`, el bucle no lo toca, y llegar al
   * formulario es trabajo del agente que mira la pantalla.
   */
  check('"Easy Apply" es other: abrir no se decide por texto', classifyButton('Easy Apply'), 'other')
  check('"Apply" pelado tampoco es accionable', classifyButton('Apply'), 'other')
  check('"Solicitar" tampoco — y por eso ya no importa', classifyButton('Solicitar'), 'other')
  /*
   * Ojo dónde está el freno: `canClick('other', …)` devuelve `true`. Lo que
   * protege no es eso, es que `pickButton` SOLO elige `next` o `submit`, así que
   * un `other` no se aprieta porque nunca se elige. La propiedad que importa es
   * que estos textos no caigan en ninguna de las dos categorías accionables.
   */
  check(
    '"Apply" no cae en ninguna categoría que el bucle apriete',
    ['next', 'submit'].includes(classifyButton('Apply')),
    false
  )
  check('review NO puede enviar', canClick('submit', 'review'), false)
  check('dry-run NO puede ni avanzar', canClick('next', 'dry-run'), false)
  check('review sí puede avanzar', canClick('next', 'review'), true)
  check('auto sí puede enviar', canClick('submit', 'auto'), true)

  // ── ASSERT 7 · un campo roto no frena el resto ───────────────────────────
  section('assert 7 · el plan sobrevive a un formulario mixto')

  const mixedForm: FormModel = {
    url: 'https://example.com/apply',
    title: 'Apply',
    inModal: false,
    fields: [
      field({ id: 'x1', label: 'First name' }),
      field({ id: 'x2', label: 'Qué te motiva de esta vacante en particular', kind: 'textarea' }),
      field({ id: 'x3', label: 'Email address', kind: 'email' })
    ],
    buttons: [{ selector: '#s', label: 'Submit application', kind: 'submit' }]
  }

  // Sin LLM: el textarea queda sin responder y los otros dos igual se resuelven.
  const plan = await planStep(
    mixedForm,
    profile,
    { cvSource: null, cvUpload: null, coverSource: null, coverUpload: null },
    null,
    null,
    'review'
  )
  check('resuelve lo que puede', plan.answers.length, 2)
  check('reporta lo que no', plan.unresolved.length, 1)

  // ── ASSERT 8 · la fila del tracker ───────────────────────────────────────
  section('assert 8 · el CSV del usuario se respeta')

  const row: TrackerRow = {
    date: '2026-08-06',
    company: 'Example, Corp',
    sector: 'SaaS',
    role: 'Senior Frontend Engineer',
    roleType: 'frontend',
    channel: 'LinkedIn',
    status: 'applied',
    contactPerson: '',
    fitRating: '72',
    notes: '2026-08-06: Albus (review) — listo para enviar | sin responder: "motivación"',
    cvFile: 'cv/main_example.pdf',
    coverLetterFile: 'cover_letters/cover_example.pdf',
    source: 'https://www.linkedin.com/jobs/view/123'
  }

  check('las comas se citan', csvEscape('Example, Corp'), '"Example, Corp"')
  check('las comillas se duplican', csvEscape('dijo "hola"'), '"dijo ""hola"""')
  check('lo simple no se toca', csvEscape('LinkedIn'), 'LinkedIn')

  const line = toCsvLine(row)
  const reread = parseCsv(`${line}\n`)[0]
  check('round-trip: 13 columnas', reread.length, 13)
  check('round-trip: empresa con coma intacta', reread[1], 'Example, Corp')
  check('round-trip: notas con comillas intactas', reread[9], row.notes)
  check('round-trip: la URL es la última columna', reread[12], row.source)

  // Append real, contra una copia temporal — nunca contra el CSV del usuario.
  const dir = await mkdtemp(join(tmpdir(), 'albus-jobs-'))
  const header =
    'date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source\n'
  const original = `${header}2026-07-10,Somewhere,Staffing,Web Developer,fullstack,LinkedIn,interview,,69,"a, b",cv/x.tex,cover/y.tex,https://ln/1\n`
  await writeFile(join(dir, 'job_search_tracker.csv'), original, 'utf8')

  // La copia temporal entra por PARÁMETRO. Antes se pisaba `JOB_WORKSPACE_DIR`, y
  // el día que la precedencia quedó al revés este mismo test le agregó dos filas
  // de prueba al CSV real del usuario. Un parámetro no se puede ignorar.
  const { createCsvTracker } = await import('../src/main/jobs/tracker')
  const tracker = createCsvTracker(join(dir, 'job_search_tracker.csv'))
  await tracker.append(row)

  const final = await readFile(join(dir, 'job_search_tracker.csv'), 'utf8')
  const rows = parseCsv(final)
  check('la fila se agregó', rows.length, 3)
  check('el encabezado quedó igual', rows[0].join(','), header.trim())
  check('la fila vieja no se tocó', rows[1][1], 'Somewhere')
  check('la nueva es la última', rows[2][1], 'Example, Corp')

  const seen = await tracker.seenUrls()
  check('dedupe lee la URL vieja', seen.has('https://ln/1'), true)
  check('dedupe lee la URL nueva', seen.has(row.source), true)

  /*
   * ── ASSERT 9 · el workspace se DERIVA. No hay nada que configurar.
   *
   * Este assert pasó por dos versiones equivocadas antes de esta:
   *
   * 1. Verificaba que sin `JOB_WORKSPACE_DIR` la app **fallara ruidoso**. Era
   *    coherente con el diseño de entonces, y ese diseño era el problema: la
   *    variable apuntaba a un clon de un repo de un TERCERO, así que arrancar
   *    Albus exigía clonar el repositorio de otra persona.
   * 2. Verificaba que esa variable, como override, GANARA. También mal: una ruta
   *    de una máquina no se publica, y el reclamo del usuario fue exacto — *"si
   *    ahí están listados todos los agentes, ¿por qué yo tengo que poner en el
   *    .env todo eso?"*.
   *
   * Ahora no hay variable. La carpeta sale del id del agente y esto lo fija. Para
   * mover toda la carpeta de datos está `ALBUS_DATA_DIR`: UNO para la raíz, cero
   * por agente.
   */
  section('assert 9 · el workspace se deriva del id del agente, sin configurar nada')

  const { agentsDir } = await import('../src/main/paths')

  check('sale de la carpeta del agente', workspaceDir(), join(agentsDir(), 'job-search'))
  check(
    'la regla es agente X → agents/X',
    workspaceDir().endsWith(join('agents', 'job-search')),
    true
  )

  // La variable vieja ya no existe para el código: setearla no cambia nada. Sin
  // este assert, alguien la vuelve a leer "por compatibilidad" y volvemos al `.env`.
  process.env.JOB_WORKSPACE_DIR = join(tmpdir(), 'ya-no-se-mira')
  check('y JOB_WORKSPACE_DIR ya NO se lee', workspaceDir(), join(agentsDir(), 'job-search'))
  delete process.env.JOB_WORKSPACE_DIR

  // ── cierre ───────────────────────────────────────────────────────────────
  const total = passed + failed
  console.log(`\n${'='.repeat(60)}`)
  console.log(`DOMINIO DE POSTULACIÓN   ${passed}/${total} ${failed === 0 ? '✓' : '✗'}`)
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
