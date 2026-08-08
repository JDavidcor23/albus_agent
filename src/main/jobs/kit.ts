import { spawn } from 'node:child_process'
import { collect, resolveBinary } from '../providers/cli-common'
import { createWorkspaceKitSource, slugify, workspaceDir } from './workspace'
import { uploadStagingDir } from './apply-runner'
import type { JobPosting } from '../core/jobs/types'

/**
 * Generar el CV y la carta a medida sin abrir el otro repo.
 *
 * Albus NO reimplementa la fábrica de kits, y no es pereza: ese flujo compila
 * LaTeX con lualatex, ABRE el PDF resultante para mirarlo, verifica que tenga
 * exactamente dos páginas y sin títulos huérfanos, extrae la capa de texto con
 * `pdftotext` y compara la cobertura de palabras clave contra la vacante. Son
 * veinte puntos de checklist que ya están escritos, probados y que el usuario
 * sabe mantener. Reescribir eso acá sería tirarlo a la basura.
 *
 * Lo que sí cambia: quién lo dispara. Antes había que abrir una terminal en
 * `ai-job-search` y escribir `/apply <url>`. Ahora lo lanza un botón, y el
 * repo pasa de ser un lugar donde se trabaja a ser una fábrica que nadie mira.
 */

const cache: { value: string | null | undefined } = { value: undefined }

/** Compilar, revisar y verificar un kit lleva minutos. Veinte es el techo. */
const KIT_TIMEOUT_MS = 20 * 60_000

export interface KitRequest {
  url: string
  company: string
  role: string
  slug: string
  onLine?: (line: string) => void
}

export interface KitResult {
  ok: boolean
  cv: string | null
  cover: string | null
  message: string
}

/**
 * El prompt es explícito en no preguntar: `/apply` está escrito para una
 * sesión interactiva y en el paso 1 pregunta "¿sigo?". En modo headless nadie
 * puede contestar eso, y el agente se quedaría esperando hasta el timeout.
 */
function prompt(req: KitRequest): string {
  return [
    `Ejecutá el flujo de /apply para esta vacante, de punta a punta y SIN preguntar nada:`,
    ``,
    `  Empresa: ${req.company}`,
    `  Puesto:  ${req.role}`,
    `  URL:     ${req.url}`,
    ``,
    `Estás en modo headless: no hay nadie del otro lado para contestar. El paso de`,
    `confirmación se da por aceptado y seguís derecho hasta compilar los PDF.`,
    ``,
    `Los archivos van a:`,
    `  cv/main_${req.slug}.tex  →  cv/main_${req.slug}.pdf`,
    `  cover_letters/cover_${req.slug}_*.tex  →  su .pdf`,
    ``,
    `NO relajes la verificación: el CV son exactamente 2 páginas, la carta 1, y`,
    `nada de lo que digan puede ser algo que el perfil no respalde. Si la vacante`,
    `pide algo que el candidato no tiene, se deja la brecha visible.`,
    ``,
    `Cuando termines, escribí una sola línea: LISTO <ruta del cv> | <ruta de la carta>`
  ].join('\n')
}

export async function generateKit(req: KitRequest): Promise<KitResult> {
  const bin = await resolveBinary('claude', cache)
  if (bin === null) {
    return { ok: false, cv: null, cover: null, message: 'claude no está en el PATH' }
  }

  const slug = req.slug !== '' ? req.slug : slugify(req.company)
  const posting: JobPosting = { url: req.url, company: req.company, role: req.role, slug }
  const kitSource = createWorkspaceKitSource(uploadStagingDir())

  // Si ya existe no se regenera: compilar de nuevo cuesta minutos y cuota, y
  // el kit anterior ya pasó su verificación.
  const previous = await kitSource.findKit(posting)
  if (previous.cv !== null) {
    return { ok: true, cv: previous.cv, cover: previous.cover, message: 'el kit ya estaba compilado' }
  }

  req.onLine?.(`generando el kit de ${req.company}… esto tarda varios minutos`)

  try {
    // cwd en el workspace: ahí viven las skills, las plantillas y el .claude
    // con el comando /apply. El prompt va por stdin, nada toca argv.
    const child = spawn(`"${bin}"`, ['-p', '--output-format', 'text'], {
      shell: true,
      windowsHide: true,
      cwd: workspaceDir()
    })

    await collect(child, `claude /apply ${req.company}`, prompt(req), {
      timeoutMs: KIT_TIMEOUT_MS,
      onLine: (l) => req.onLine?.(l.slice(0, 160))
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    // Aunque el CLI falle, puede haber dejado los PDF: se mira el disco antes
    // de dar el kit por perdido. El estado real manda sobre el exit code.
    const afterFailure = await kitSource.findKit(posting)
    if (afterFailure.cv !== null) {
      return {
        ok: true,
        cv: afterFailure.cv,
        cover: afterFailure.cover,
        message: 'compilado (el CLI salió mal)'
      }
    }
    return { ok: false, cv: null, cover: null, message }
  }

  // La verdad es el disco, no lo que el agente diga que hizo.
  const final = await kitSource.findKit(posting)
  if (final.cv === null) {
    return {
      ok: false,
      cv: null,
      cover: null,
      message: `el agente terminó pero no hay cv/main_${slug}.pdf en el workspace`
    }
  }

  return {
    ok: true,
    cv: final.cv,
    cover: final.cover,
    message: final.cover === null ? 'CV listo (sin carta)' : 'CV y carta listos'
  }
}
