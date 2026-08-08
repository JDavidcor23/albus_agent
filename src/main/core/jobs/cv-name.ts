import { normalize } from './answers'
import type { CandidateProfile } from './types'

/**
 * El pedido explícito del usuario: el reclutador abre el adjunto y tiene que
 * leer "CV Jorge David Diaz.pdf", no "main_agileengine.pdf". El nombre del
 * archivo de trabajo es un detalle del workspace y no tiene por qué viajar.
 *
 * Se copia a un temporal con el nombre bueno en vez de renombrar el original:
 * el original es la fuente de verdad del tracker y ahí sigue siendo
 * `cv/main_<empresa>.pdf`, que es como lo referencian el CSV y el archivo por
 * aplicación.
 */

/**
 * Caracteres que Windows no acepta en un nombre de archivo, más los de
 * control. El espacio NO entra a propósito: "CV Jorge David Diaz.pdf" tiene
 * que conservar los suyos, que es justamente el pedido.
 */
const ILEGALES = /[<>:"/\\|?*\u0000-\u001f]/g

export function sanitizeFileName(base: string): string {
  const limpio = base
    .replace(ILEGALES, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows tampoco tolera un nombre terminado en punto o espacio.
    .replace(/[. ]+$/, '')

  if (limpio === '') throw new Error('el nombre de archivo quedó vacío después de limpiarlo')
  return limpio
}

/** Extensión del origen, en minúsculas, con el punto. Vacío si no tiene. */
export function extensionOf(sourcePath: string): string {
  const base = sourcePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const punto = base.lastIndexOf('.')
  return punto <= 0 ? '' : base.slice(punto).toLowerCase()
}

export function uploadFileName(base: string, sourcePath: string): string {
  return `${sanitizeFileName(base)}${extensionOf(sourcePath)}`
}

export function cvUploadName(p: CandidateProfile, sourcePath: string): string {
  return uploadFileName(p.cvFileBaseName, sourcePath)
}

export function coverUploadName(p: CandidateProfile, sourcePath: string): string {
  return uploadFileName(p.coverFileBaseName, sourcePath)
}

/**
 * ¿Este `input[type=file]` es el del CV o el de la carta? Un formulario puede
 * tener los dos y subir la carta donde va el CV es peor que no subir nada.
 */
export function classifyFileField(labelYNombre: string): 'cv' | 'cover' | 'unknown' {
  const hay = normalize(labelYNombre)
  if (/cover[\s_-]*letter|carta[\s_-]*(de[\s_-]*)?presentacion|motivation/.test(hay)) return 'cover'
  if (/resume|\bcv\b|curriculum|hoja de vida/.test(hay)) return 'cv'
  return 'unknown'
}
