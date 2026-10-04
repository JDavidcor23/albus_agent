import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { udemyDir } from '../paths'
import { COURSE_META_FILE, CourseMetaSchema, type CourseMeta } from '../core/udemy/library'

/**
 * La biblioteca de cursos contra el disco.
 *
 * ```
 * Documentos/albus_agent/udemy/
 *   aws-certified-cloud-practitioner/
 *     curso.json                  el titulo, la url, que se bajo
 *     051-ebs-overview.md         el transcript
 *     051-ebs-overview/           las capturas de esa leccion, si las hubo
 *       1-tabla-comparativa.jpg
 * ```
 *
 * ## Por que las capturas van en una carpeta con el nombre del transcript
 *
 * Y no en un `img/` comun: borrar una leccion para volver a bajarla tiene que
 * llevarse sus capturas. Con una carpeta compartida quedan huerfanas, y tres
 * corridas despues nadie sabe a que leccion pertenecia `12.jpg`.
 */

function safe(slug: string): string {
  // El slug lo arma `core/udemy/curriculum.ts`, pero esto escribe en el disco
  // del usuario: un `..` acá no puede escribir fuera de la carpeta, venga de
  // donde venga. Misma regla que `manifestPath`.
  return slug.replace(/[^a-z0-9-]/gi, '')
}

export function courseDir(courseSlug: string): string {
  return join(udemyDir(), safe(courseSlug))
}

export function lectureFile(courseSlug: string, lectureSlug: string): string {
  return join(courseDir(courseSlug), `${safe(lectureSlug)}.md`)
}

export function shotsDir(courseSlug: string, lectureSlug: string): string {
  return join(courseDir(courseSlug), safe(lectureSlug))
}

/**
 * Lo que YA está bajado, leído del disco y no del `curso.json`.
 *
 * El `curso.json` lleva la cuenta, pero la fuente de verdad es qué archivos
 * hay. El usuario va a borrar una lección a mano para que se vuelva a bajar
 * —para eso la carpeta es suya— y un contador que no se enteró haría que esa
 * lección no se baje nunca más. Misma decisión que `listManifests`: escanear
 * no puede desincronizarse de lo que realmente está.
 */
export function storedLectures(courseSlug: string): string[] {
  const dir = courseDir(courseSlug)
  if (!existsSync(dir)) return []

  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
  } catch (error: unknown) {
    console.warn(`[udemy] no pude leer ${dir}: ${String(error)}`)
    return []
  }
}

export function writeLecture(courseSlug: string, lectureSlug: string, markdown: string): string {
  const path = lectureFile(courseSlug, lectureSlug)
  mkdirSync(courseDir(courseSlug), { recursive: true })
  writeFileSync(path, markdown, 'utf8')
  return path
}

/** Un `curso.json` roto no puede hacer desaparecer las lecciones ya bajadas. */
export function readCourseMeta(courseSlug: string): CourseMeta {
  const path = join(courseDir(courseSlug), COURSE_META_FILE)
  if (!existsSync(path)) return CourseMetaSchema.parse({})

  try {
    return CourseMetaSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error: unknown) {
    console.warn(`[udemy] ${path} no se pudo leer, sigo con defaults: ${String(error)}`)
    return CourseMetaSchema.parse({})
  }
}

export function writeCourseMeta(courseSlug: string, meta: CourseMeta): void {
  mkdirSync(courseDir(courseSlug), { recursive: true })
  writeFileSync(
    join(courseDir(courseSlug), COURSE_META_FILE),
    `${JSON.stringify(meta, null, 2)}\n`,
    'utf8'
  )
}
