import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalize } from '../core/jobs/answers'
import { parseProfile } from '../core/jobs/profile'
import { uploadFileName } from '../core/jobs/cv-name'
import type { KitPaths, KitSource } from '../core/jobs/ports'
import type { CandidateProfile, JobPosting } from '../core/jobs/types'

/**
 * El puente con el workspace de búsqueda laboral (`ai-job-search`).
 *
 * Albus NO reimplementa la generación del kit: las skills de ese repo ya
 * arman el CV y la carta en LaTeX, los compilan y los verifican contra una
 * checklist de veinte puntos. Duplicar eso acá sería tirar a la basura lo que
 * ya funciona. Albus lee los PDF que ese proceso dejó y los lleva al
 * formulario, que es la parte que hoy sigue siendo a mano.
 *
 * Every path literal here — `albus-profile.json`, `cv/main_<slug>.pdf`,
 * `cover_letters/cover_<slug>*.pdf` — is FROZEN: it is the contract with the
 * sibling workspace, and this repo is not the only writer.
 */

export function workspaceDir(): string {
  const dir = process.env.JOB_WORKSPACE_DIR
  if (!dir || dir.trim() === '') {
    throw new Error('Falta JOB_WORKSPACE_DIR en .env — la ruta al workspace de ai-job-search')
  }
  return dir
}

export const PROFILE_FILE = 'albus-profile.json'

let profileCache: CandidateProfile | null = null

export async function loadProfile(force = false): Promise<CandidateProfile> {
  if (profileCache !== null && !force) return profileCache

  const path = join(workspaceDir(), PROFILE_FILE)

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new Error(`No encontré el perfil en ${path}. Copiá el ejemplo y completalo.`)
  }

  profileCache = parseProfile(JSON.parse(raw))
  return profileCache
}

/** "BC Tecnología" → "bc_tecnologia", que es como se llaman los archivos. */
export function slugify(text: string): string {
  return normalize(text)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

async function findPdf(dir: string, prefixes: string[]): Promise<string | null> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return null
  }

  const pdfs = files.filter((f) => f.toLowerCase().endsWith('.pdf'))

  for (const prefix of prefixes) {
    const exact = pdfs.find((f) => f.toLowerCase() === `${prefix}.pdf`)
    if (exact !== undefined) return join(dir, exact)
  }
  for (const prefix of prefixes) {
    const prefixed = pdfs.find((f) => f.toLowerCase().startsWith(`${prefix}_`))
    if (prefixed !== undefined) return join(dir, prefixed)
  }

  return null
}

/**
 * `stagingDir` entra por parámetro y no se resuelve acá adentro a propósito:
 * en la app sale de `app.getPath('userData')`, y en el verificador de una
 * carpeta temporal. Importar electron en este archivo lo volvería inejecutable
 * con `npx tsx`, que es justo como corren los chequeos.
 */
export function createWorkspaceKitSource(stagingDir: string): KitSource {
  return {
    async findKit(posting: JobPosting): Promise<KitPaths> {
      const ws = workspaceDir()
      const slug = posting.slug !== '' ? posting.slug : slugify(posting.company)

      return {
        cv: await findPdf(join(ws, 'cv'), [`main_${slug}`]),
        cover: await findPdf(join(ws, 'cover_letters'), [`cover_${slug}`])
      }
    },

    /**
     * Copia, no renombra. El original sigue siendo `cv/main_<empresa>.pdf`
     * porque así lo referencian el CSV y el archivo por aplicación; lo que
     * cambia es el nombre con que lo ve el reclutador.
     */
    async stageForUpload(sourcePath: string, uploadBaseName: string): Promise<string> {
      await mkdir(stagingDir, { recursive: true })

      const target = join(stagingDir, uploadFileName(uploadBaseName, sourcePath))
      await copyFile(sourcePath, target)
      return target
    }
  }
}
