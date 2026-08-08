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
 */

export function workspaceDir(): string {
  const dir = process.env.JOB_WORKSPACE_DIR
  if (!dir || dir.trim() === '') {
    throw new Error('Falta JOB_WORKSPACE_DIR en .env — la ruta al workspace de ai-job-search')
  }
  return dir
}

export const PROFILE_FILE = 'albus-profile.json'

let cacheProfile: CandidateProfile | null = null

export async function loadProfile(forzar = false): Promise<CandidateProfile> {
  if (cacheProfile !== null && !forzar) return cacheProfile

  const ruta = join(workspaceDir(), PROFILE_FILE)

  let crudo: string
  try {
    crudo = await readFile(ruta, 'utf8')
  } catch {
    throw new Error(`No encontré el perfil en ${ruta}. Copiá el ejemplo y completalo.`)
  }

  cacheProfile = parseProfile(JSON.parse(crudo))
  return cacheProfile
}

/** "BC Tecnología" → "bc_tecnologia", que es como se llaman los archivos. */
export function slugify(texto: string): string {
  return normalize(texto)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

async function buscarPdf(dir: string, prefijos: string[]): Promise<string | null> {
  let archivos: string[]
  try {
    archivos = await readdir(dir)
  } catch {
    return null
  }

  const pdfs = archivos.filter((f) => f.toLowerCase().endsWith('.pdf'))

  for (const prefijo of prefijos) {
    const exacto = pdfs.find((f) => f.toLowerCase() === `${prefijo}.pdf`)
    if (exacto !== undefined) return join(dir, exacto)
  }
  for (const prefijo of prefijos) {
    const empieza = pdfs.find((f) => f.toLowerCase().startsWith(`${prefijo}_`))
    if (empieza !== undefined) return join(dir, empieza)
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
        cv: await buscarPdf(join(ws, 'cv'), [`main_${slug}`]),
        cover: await buscarPdf(join(ws, 'cover_letters'), [`cover_${slug}`])
      }
    },

    /**
     * Copia, no renombra. El original sigue siendo `cv/main_<empresa>.pdf`
     * porque así lo referencian el CSV y el archivo por aplicación; lo que
     * cambia es el nombre con que lo ve el reclutador.
     */
    async stageForUpload(sourcePath: string, uploadBaseName: string): Promise<string> {
      await mkdir(stagingDir, { recursive: true })

      const destino = join(stagingDir, uploadFileName(uploadBaseName, sourcePath))
      await copyFile(sourcePath, destino)
      return destino
    }
  }
}
