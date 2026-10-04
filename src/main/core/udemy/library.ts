import { z } from 'zod'

/**
 * Que recuerda una carpeta de curso sobre si misma.
 *
 * Misma decision que `core/video/library.ts`, por las mismas dos razones: un
 * `meta.json` por curso y NO un indice central. El disco es la fuente de
 * verdad —esta carpeta es del usuario y la va a abrir y borrar cosas— y un
 * archivo corrupto cuesta un curso, no la biblioteca entera.
 */

/** CONTRATO. Renombrarlo deja huerfano todo lo bajado. */
export const COURSE_META_FILE = 'curso.json'

/**
 * Todo campo con default Y con `.catch`.
 *
 * El default cubre el campo que falta. `.catch` cubre el campo que esta pero
 * con otro tipo, que es lo que pasa cuando alguien edita el JSON a mano —y va
 * a pasar, porque la carpeta es suya y para eso `paths.ts` la saco de
 * `%APPDATA%`—. Sin `.catch`, un `"lectures": "cuatro"` tirado a mano invalida
 * el archivo entero y el curso desaparece de la lista sin decir por que.
 */
export const CourseMetaSchema = z.object({
  courseTitle: z.string().default('').catch(''),
  courseUrl: z.string().default('').catch(''),
  /** ISO 8601. Guardado, no derivado del mtime: copiar la carpeta no la re-fecha. */
  createdAt: z.string().default('').catch(''),
  updatedAt: z.string().default('').catch(''),
  /** Cuantas lecciones se bajaron, no cuantas tiene el curso. */
  lectures: z.number().int().nonnegative().default(0).catch(0),
  shots: z.number().int().nonnegative().default(0).catch(0),
  /** Los slugs ya bajados. Es lo que hace que reanudar funcione. */
  stored: z.array(z.string()).default([]).catch([])
})

export type CourseMeta = z.infer<typeof CourseMetaSchema>

/**
 * Por numero de leccion, no por slug.
 *
 * El slug ya paddea para que el disco ordene bien, pero el orden de la lista
 * en pantalla no puede depender de eso: una leccion sin numero tiene `index 0`
 * y su slug empieza en `000`, y ordenarla por texto la mezclaria entre las
 * demas. Generico sobre el unico campo que lee, como `sortTranscripts`.
 */
export function sortLectures<T extends { index: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.index - b.index)
}
