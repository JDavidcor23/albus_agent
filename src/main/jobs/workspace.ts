import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
/*
 * `paths.ts` importa electron pero está escrito para sobrevivir a `npx tsx`
 * —resuelve las rutas a mano cuando `app.getPath` no existe—, así que este
 * archivo sigue corriendo en los chequeos. Es la misma vía que ya usa
 * `connections/albus-yml.ts` desde `notion:check`.
 */
import { agentsDir } from '../paths'
import { normalize } from '../core/jobs/answers'
import { parseProfile } from '../core/jobs/profile'
import { uploadFileName } from '../core/jobs/cv-name'
import type { KitPaths, KitSource } from '../core/jobs/ports'
import type { CandidateProfile, JobPosting } from '../core/jobs/types'

/**
 * El workspace del agente de trabajo: su perfil, sus CV y sus cartas.
 *
 * Albus NO reimplementa la generación del kit: las skills que armaron ese
 * workspace ya escriben el CV y la carta en LaTeX, los compilan y los verifican
 * contra una checklist de veinte puntos. Duplicar eso acá sería tirar a la basura
 * lo que ya funciona. Albus lee los PDF que ese proceso dejó y los lleva al
 * formulario, que es la parte que hoy sigue siendo a mano.
 *
 * ## Dónde vive, y por qué se mudó
 *
 * Vive en `agents/job-search/` dentro de la carpeta del usuario — la carpeta se
 * deriva del ID DEL AGENTE, así que la regla es agente `X` → `agents/X/` y un
 * agente nuevo trae la suya sin que nadie agregue una constante.
 *
 * Antes salía solo de `JOB_WORKSPACE_DIR`, que apuntaba a un clon de
 * `github.com/MadsLorentzen/ai-job-search`: el repo de un TERCERO. Con eso, para
 * que Albus arrancara había que clonar el repositorio de otra persona y escribir
 * una ruta en un `.env`. La variable sigue funcionando como override.
 *
 * Every path literal here — `albus-profile.json`, `cv/main_<slug>.pdf`,
 * `cover_letters/cover_<slug>*.pdf` — is FROZEN: it is the contract with whatever
 * else writes that workspace, and this repo is not the only writer. Si el usuario
 * mantiene el clon original, las dos copias divergen en silencio: un CV nuevo
 * generado allá no aparece acá.
 */

/** El id del agente dueño de este workspace. Es el nombre de su carpeta. */
const AGENT_ID = 'job-search'

/**
 * Dónde está el workspace del agente de trabajo.
 *
 * ## No hay variable de entorno. Se DERIVA, y eso es todo.
 *
 * `agents/job-search/`, y el `job-search` sale del id del agente. Nada que
 * configurar, nada que escribir en un `.env`.
 *
 * Hubo dos versiones peores antes de esta:
 *
 * 1. **`JOB_WORKSPACE_DIR` obligatoria.** Tiraba si faltaba, y apuntaba a un clon
 *    de `github.com/MadsLorentzen/ai-job-search` — el repo de un TERCERO. Para
 *    que Albus arrancara había que clonar el repositorio de otra persona.
 * 2. **La misma variable como override que ganaba.** Reclamo del usuario, y tenía
 *    razón: *"si ahí están listados todos los agentes, ¿por qué yo tengo que poner
 *    en el .env todo eso? Si esto yo lo quiero publicar el día de mañana para otra
 *    persona, ¿qué hago?"*. Una ruta de una máquina no se publica.
 *
 * ## Y los tests, ¿cómo se aíslan?
 *
 * Por PARÁMETRO, no por variable de entorno. Es lo que este archivo ya hacía con
 * `stagingDir` y por el mismo motivo. Una perilla pública que existe solo para que
 * los tests se aíslen es una perilla que el usuario puede girar sin querer — y
 * girada al revés, ya le agregó una fila de prueba a su CSV real.
 *
 * Para mover TODA la carpeta de datos —un disco sincronizado, otro sistema— está
 * `ALBUS_DATA_DIR` en `paths.ts`: UN override para la raíz, cero por agente.
 */
export function workspaceDir(): string {
  return join(agentsDir(), AGENT_ID)
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
    /*
     * El mensaje dice la RUTA, porque es el único dato que sirve.
     *
     * Antes el que fallaba era `workspaceDir()` con "Falta JOB_WORKSPACE_DIR en
     * .env": mandaba a editar un archivo del repo por una variable que ya no es
     * la forma normal de configurar esto. Ahora se dice dónde va el archivo.
     */
    throw new Error(
      `No encontré el perfil del agente. Ponelo en:\n  ${path}\n` +
        '(es el `albus-profile.json` del workspace de postulación)'
    )
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
export function createWorkspaceKitSource(stagingDir: string, workspace?: string): KitSource {
  /*
   * `workspace` entra por parámetro por el MISMO motivo que `stagingDir`: el
   * verificador necesita apuntar a una carpeta temporal, y hacerlo con una
   * variable de entorno significaría exponer una perilla pública para uso interno.
   * Sin argumento, la carpeta del agente.
   */
  const root = workspace ?? workspaceDir()

  return {
    async findKit(posting: JobPosting): Promise<KitPaths> {
      const ws = root
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
