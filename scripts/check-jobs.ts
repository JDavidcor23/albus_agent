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
import type { TrackerRow } from '../src/main/core/jobs/ports'

let pasados = 0
let fallados = 0
const fallas: string[] = []

function check(nombre: string, real: unknown, esperado: unknown): void {
  const ok = JSON.stringify(real) === JSON.stringify(esperado)
  if (ok) {
    pasados++
    console.log(`  ok    ${nombre}`)
  } else {
    fallados++
    const linea = `${nombre}\n          esperado ${JSON.stringify(esperado)}\n          real     ${JSON.stringify(real)}`
    fallas.push(linea)
    console.log(`  FALLA ${linea}`)
  }
}

function seccion(titulo: string): void {
  console.log(`\n── ${titulo}`)
}

// ── perfil de prueba: el real, para que los asserts midan lo que se usa ─────
const PERFIL_PATH = join(
  process.env.JOB_WORKSPACE_DIR ?? 'C:/Users/jdiaz483/Documents/work/dream/ai-job-search',
  'albus-profile.json'
)

function campo(p: Partial<FormField>): FormField {
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
  const profile = parseProfile(JSON.parse(await readFile(PERFIL_PATH, 'utf8')))

  // ── ASSERT 2 · las reglas resuelven los campos canónicos ─────────────────
  seccion('assert 2 · mapeo por reglas (sin LLM, sin red)')

  const campos: FormField[] = [
    campo({ id: 'a', label: 'First name' }),
    campo({ id: 'b', label: 'Last name' }),
    campo({ id: 'c', label: 'Email address', kind: 'email' }),
    campo({
      id: 'd',
      label: 'Phone country code',
      kind: 'select',
      options: [
        { value: 'us', label: '+1 United States' },
        { value: 'co', label: '+57 Colombia' }
      ]
    }),
    campo({ id: 'e', label: 'Mobile phone number', kind: 'tel' }),
    campo({ id: 'f', label: 'City' }),
    campo({
      id: 'g',
      label: 'Country of residence',
      kind: 'select',
      options: [
        { value: 'ar', label: 'Argentina' },
        { value: 'co', label: 'Colombia' }
      ]
    }),
    campo({ id: 'h', label: 'LinkedIn profile URL', kind: 'url' }),
    campo({ id: 'i', label: 'GitHub profile', kind: 'url' }),
    campo({ id: 'j', label: 'Portfolio or personal website', kind: 'url' }),
    campo({
      id: 'k',
      label: 'How many years of work experience do you have with React?',
      kind: 'number'
    }),
    campo({
      id: 'l',
      label: 'Are you legally authorized to work in Colombia?',
      kind: 'radio',
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' }
      ]
    }),
    campo({
      id: 'm',
      label: 'Will you now or in the future require visa sponsorship?',
      kind: 'radio',
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' }
      ]
    }),
    campo({
      id: 'n',
      label: 'Are you willing to relocate for this role?',
      kind: 'radio',
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' }
      ]
    }),
    campo({ id: 'o', label: 'Expected salary' }),
    campo({ id: 'p', label: 'What is your notice period?' }),
    campo({
      id: 'q',
      label: 'English proficiency',
      kind: 'select',
      options: [
        { value: 'basic', label: 'Basic' },
        { value: 'conv', label: 'Conversational (B2+)' },
        { value: 'native', label: 'Native' }
      ]
    }),
    campo({ id: 'r', label: 'Current company' }),
    campo({ id: 's', label: 'Current job title' }),
    campo({
      id: 't',
      label: 'Gender',
      kind: 'select',
      options: [
        { value: 'm', label: 'Male' },
        { value: 'd', label: 'Decline to self-identify' }
      ]
    })
  ]

  const { answers, pending, humanOnly } = answerByRules(campos, profile)
  const porId = new Map(answers.map((a) => [a.fieldId, a.value]))

  check('reglas resuelven ≥12 campos', answers.length >= 12, true)
  check('first name', porId.get('a'), profile.firstName)
  check('last name', porId.get('b'), profile.lastName)
  check('email', porId.get('c'), profile.email)
  check('código de país (select por coincidencia parcial)', porId.get('d'), 'co')
  check('teléfono', porId.get('e'), profile.phone)
  check('ciudad', porId.get('f'), `${profile.city}, ${profile.country}`)
  check('país (select)', porId.get('g'), 'co')
  check('linkedin', porId.get('h'), profile.linkedinUrl)
  check('github', porId.get('i'), profile.githubUrl)
  check('portfolio', porId.get('j'), profile.portfolioUrl)
  check('años con React', porId.get('k'), String(profile.yearsExperience.react))
  check('autorizado a trabajar → Yes', porId.get('l'), 'Yes')
  check('requiere sponsorship → No', porId.get('m'), 'No')
  check('se muda → No', porId.get('n'), 'No')
  check('salario', porId.get('o'), `USD 3,500 / month`)
  check('preaviso', porId.get('p'), `${profile.noticePeriodDays} days notice period`)
  check('inglés (select)', porId.get('q'), 'conv')
  check('empresa actual', porId.get('r'), profile.currentCompany)
  check('cargo actual', porId.get('s'), profile.currentTitle)
  check('EEO → declina', porId.get('t'), 'd')
  check('nada quedó pendiente en este set', pending.length, 0)
  check('nada requiere humano en este set', humanOnly.length, 0)

  // ── honestidad: lo que el perfil no dice, no se contesta ─────────────────
  seccion('honestidad · no inventar experiencia')

  const conPython = haystack(
    campo({ label: 'How many years of work experience do you have with Python?' })
  )
  check('años con Python → sin respuesta', yearsFor(profile, conPython), null)

  const conRust = haystack(campo({ label: 'Years of experience with Rust' }))
  check('años con Rust → sin respuesta', yearsFor(profile, conRust), null)

  const generico = haystack(campo({ label: 'How many years of professional experience?' }))
  check(
    'años en general → el total real',
    yearsFor(profile, generico),
    String(profile.yearsExperience.default)
  )

  const educacion = answerByRules(
    [
      campo({
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
    educacion.answers.length,
    0
  )

  const consentimiento = answerByRules(
    [campo({ id: 'pv', label: 'I agree to the privacy policy', kind: 'checkbox' })],
    profile
  )
  check('consentimiento → lo firma el humano', consentimiento.humanOnly.length, 1)
  check('consentimiento → Albus no lo contesta', consentimiento.answers.length, 0)

  const sinSponsor = answerByRules(
    [
      campo({
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
  check('"sin sponsorship" invierte la respuesta', sinSponsor.answers[0]?.value, 'Yes')

  check(
    'select sin ninguna opción compatible → null, no la primera',
    resolveOption(
      campo({
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
      campo({
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
  seccion('assert 3 · el CV se llama como el candidato, no como la empresa')

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
  seccion('assert 6 · el submit es inalcanzable salvo en modo auto')

  check('clasifica "Submit application"', classifyButton('Submit application'), 'submit')
  check('clasifica "Enviar solicitud"', classifyButton('Enviar solicitud'), 'submit')
  check('clasifica "Next"', classifyButton('Next'), 'next')
  check('clasifica "Easy Apply"', classifyButton('Easy Apply'), 'apply')
  check('review NO puede enviar', canClick('submit', 'review'), false)
  check('dry-run NO puede ni avanzar', canClick('next', 'dry-run'), false)
  check('review sí puede avanzar', canClick('next', 'review'), true)
  check('auto sí puede enviar', canClick('submit', 'auto'), true)

  // ── ASSERT 7 · un campo roto no frena el resto ───────────────────────────
  seccion('assert 7 · el plan sobrevive a un formulario mixto')

  const formMixto: FormModel = {
    url: 'https://example.com/apply',
    title: 'Apply',
    fields: [
      campo({ id: 'x1', label: 'First name' }),
      campo({ id: 'x2', label: 'Qué te motiva de esta vacante en particular', kind: 'textarea' }),
      campo({ id: 'x3', label: 'Email address', kind: 'email' })
    ],
    buttons: [{ selector: '#s', label: 'Submit application', kind: 'submit' }]
  }

  // Sin LLM: el textarea queda sin responder y los otros dos igual se resuelven.
  const plan = await planStep(
    formMixto,
    profile,
    { cvSource: null, cvUpload: null, coverSource: null, coverUpload: null },
    null,
    null,
    'review'
  )
  check('resuelve lo que puede', plan.answers.length, 2)
  check('reporta lo que no', plan.unresolved.length, 1)

  // ── ASSERT 8 · la fila del tracker ───────────────────────────────────────
  seccion('assert 8 · el CSV del usuario se respeta')

  const fila: TrackerRow = {
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

  const linea = toCsvLine(fila)
  const releida = parseCsv(`${linea}\n`)[0]
  check('round-trip: 13 columnas', releida.length, 13)
  check('round-trip: empresa con coma intacta', releida[1], 'Example, Corp')
  check('round-trip: notas con comillas intactas', releida[9], fila.notes)
  check('round-trip: la URL es la última columna', releida[12], fila.source)

  // Append real, contra una copia temporal — nunca contra el CSV del usuario.
  const dir = await mkdtemp(join(tmpdir(), 'albus-jobs-'))
  const encabezado =
    'date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source\n'
  const original = `${encabezado}2026-07-10,Somewhere,Staffing,Web Developer,fullstack,LinkedIn,interview,,69,"a, b",cv/x.tex,cover/y.tex,https://ln/1\n`
  await writeFile(join(dir, 'job_search_tracker.csv'), original, 'utf8')

  process.env.JOB_WORKSPACE_DIR = dir
  const { createCsvTracker } = await import('../src/main/jobs/tracker')
  const tracker = createCsvTracker()
  await tracker.append(fila)

  const final = await readFile(join(dir, 'job_search_tracker.csv'), 'utf8')
  const filas = parseCsv(final)
  check('la fila se agregó', filas.length, 3)
  check('el encabezado quedó igual', filas[0].join(','), encabezado.trim())
  check('la fila vieja no se tocó', filas[1][1], 'Somewhere')
  check('la nueva es la última', filas[2][1], 'Example, Corp')

  const vistas = await tracker.seenUrls()
  check('dedupe lee la URL vieja', vistas.has('https://ln/1'), true)
  check('dedupe lee la URL nueva', vistas.has(fila.source), true)

  // ── ASSERT 9 · nada de secretos nuevos ───────────────────────────────────
  seccion('assert 9 · el workspace sale del entorno')

  delete process.env.JOB_WORKSPACE_DIR
  const { workspaceDir } = await import('../src/main/jobs/workspace')
  let tiro = false
  try {
    workspaceDir()
  } catch {
    tiro = true
  }
  check('sin JOB_WORKSPACE_DIR falla ruidoso al arrancar', tiro, true)

  // ── cierre ───────────────────────────────────────────────────────────────
  const total = pasados + fallados
  console.log(`\n${'='.repeat(60)}`)
  console.log(`DOMINIO DE POSTULACIÓN   ${pasados}/${total} ${fallados === 0 ? '✓' : '✗'}`)
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
