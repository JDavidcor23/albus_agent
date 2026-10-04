/**
 * El indice del curso, y como una leccion se vuelve una carpeta.
 *
 * ## Que entra aca y que no
 *
 * Esto NO sabe que existe un DOM. Recibe filas ya leidas —texto y si tienen
 * tilde de vista— y devuelve lecciones. Es la misma linea que separa
 * `core/video/transcript.ts` de `video/whisper.ts`: el parseo es dominio y se
 * prueba sin montar nada; leer la pantalla es I/O y vive afuera.
 *
 * La razon practica: Udemy redisena, y cuando lo haga hay que tocar UN archivo
 * de selectores, no la logica de nombres de carpeta que ya funcionaba.
 */

import { classifyItem, hasDuration, shouldCapture, type ItemKind } from './items'

/** Una fila del panel de contenido, tal como se leyo de la pagina. */
export interface RawRow {
  /** El texto visible completo, saltos de linea incluidos. */
  text: string
  /** Si tiene el tilde de "ya la vi". */
  completed: boolean
  /**
   * El numero de la seccion que la contiene. 0 si no se pudo determinar.
   *
   * Lo asigna el script que lee la pagina, recorriendo en orden de documento:
   * una cabecera "Section 3: ..." manda sobre todas las filas que vienen abajo
   * hasta la proxima cabecera. Deducirlo aca seria imposible — el texto de una
   * fila no dice a que seccion pertenece.
   */
  section?: number
}

/**
 * "Section 3: What is Cloud Computing?" en numero y titulo.
 *
 * Acepta la forma en ingles y en castellano porque Udemy traduce la interfaz
 * segun el idioma de la cuenta, y el mismo curso se ve de las dos formas en
 * dos maquinas distintas.
 */
export function parseSectionText(raw: string): { index: number; title: string } {
  const line = (raw.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim()
  const m = /^(?:section|secci[oó]n)\s+(\d+)\s*[:.-]?\s*(.*)$/i.exec(line)
  if (m === null) return { index: 0, title: line }
  return { index: Number(m[1]), title: m[2].trim() }
}

export interface Lecture {
  /** El numero que Udemy le pone. 0 si la fila no es una leccion numerada. */
  index: number
  title: string
  completed: boolean
  slug: string
  /**
   * Video, nota, quiz o role play. Ver `items.ts`.
   *
   * Vive en la leccion y no se calcula despues porque decide TODO lo que sigue:
   * un quiz no tiene transcript, y mandarlo por el camino del video falla con
   * "no pude leer el transcript" — que suena a DOM cambiado y hace perder media
   * hora buscando un selector que estaba bien.
   */
  kind: ItemKind
  /** La seccion que la contiene. 0 = no se pudo determinar. */
  section: number
}

/**
 * Separa "51. EBS Overview" en numero y titulo.
 *
 * Se queda con la PRIMERA linea a proposito: el panel mete la duracion abajo
 * —`53. EBS Hands On\n6min`— y "EBS Hands On 6min" como titulo ensucia el
 * nombre de la carpeta para siempre.
 *
 * Una fila sin numero no es un error. Los quizzes y los articulos tambien
 * estan en el curriculum, y devolver `index: 0` con el titulo entero deja que
 * el que llama decida, en vez de perder la fila.
 */
export function parseLectureText(raw: string): { index: number; title: string } {
  const firstLine = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)

  const line = (firstLine ?? '').replace(/\s+/g, ' ').trim()

  const m = /^(\d+)\.\s*(.+)$/.exec(line)
  if (m === null) return { index: 0, title: line }

  return { index: Number(m[1]), title: m[2].trim() }
}

/**
 * Texto a pedazo de nombre de archivo.
 *
 * Los acentos se descomponen y se tiran: `¿Qué son?` termina en `que-son`. Un
 * nombre de carpeta con tilde sobrevive a Windows pero no a un `git` entre dos
 * maquinas con locales distintos, y ese bug se descubre tarde y en otra
 * computadora.
 */
function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * El nombre de la carpeta de una leccion: `051-ebs-overview`.
 *
 * **El padding a tres digitos no es cosmetico.** `readdirSync` y el explorador
 * ordenan alfabeticamente, y sin padding la leccion 100 queda ANTES de la 51.
 * El curso tiene mas de 300 lecciones, asi que el caso no es hipotetico: llega
 * seguro, y llega cuando ya hay cien carpetas escritas y renombrarlas cuesta.
 *
 * Un titulo que se queda sin caracteres utiles —`!!!`— cae en `leccion` en vez
 * de dejar un slug colgado terminado en guion.
 */
export function lectureSlug(index: number, title: string): string {
  const body = slugify(title)
  const num = String(Math.max(0, Math.trunc(index))).padStart(3, '0')
  return `${num}-${body === '' ? 'leccion' : body}`
}

/** `s06-ec2-instance-storage`. Dos digitos: no hay cursos de mil secciones. */
export function sectionSlug(index: number, title: string): string {
  const body = slugify(title)
  const num = String(Math.max(0, Math.trunc(index))).padStart(2, '0')
  return `s${num}-${body === '' ? 'seccion' : body}`
}

/**
 * Lo que falta bajar.
 *
 * ## Por que esto existe y no es un `filter` en el que llama
 *
 * Son cincuenta lecciones y la corrida SE VA A CORTAR —se cierra la app, se
 * cae la sesion, Udemy mete un captcha—. Un modulo que al volver empieza de
 * cero no sirve para lo que se construyo. Reanudar es el caso normal, no el
 * de borde.
 *
 * ## Por que solo las vistas
 *
 * El transcript de una leccion que no vi no me sirve todavia: el material se
 * baja para reescribirlo DESPUES de haberlo visto. Bajar el curso entero de
 * una seria juntar trescientos archivos que nadie va a leer, y encima cambia
 * la naturaleza de lo que se guarda.
 */
/**
 * Lo que falta bajar, opcionalmente de UNA seccion.
 *
 * El filtro por seccion existe porque "bajame la seccion 3" es el pedido real:
 * el curso se estudia por secciones, no por las primeras N lecciones del
 * indice. Sin esto, un `limit: 9` sobre un curso con las secciones 1 a 6 vistas
 * baja las nueve primeras del curso entero — que no son las que se pidieron, y
 * el que las pidio se entera cuando vuelve.
 *
 * `sections` vacio = todas.
 */
export function pendingLectures(
  lectures: Lecture[],
  alreadyStored: string[],
  sections: number[] = []
): Lecture[] {
  const done = new Set(alreadyStored)
  const wanted = new Set(sections)

  return lectures.filter((l) => {
    if (!l.completed || done.has(l.slug)) return false
    if (wanted.size > 0 && !wanted.has(l.section)) return false

    // Un role play no deja nada que guardar. Filtrarlo ACA y no adentro del
    // recorrido evita que aparezca como "falló" en el reporte: no falló, no
    // habia nada que bajar, y confundir las dos cosas hace dudar del resto.
    const { transcript, screens } = shouldCapture(l.kind)
    if (!transcript && !screens) return false

    // Un quiz no tiene numero de leccion y aun asi vale: es lo mas parecido al
    // examen que hay en el curso.
    return l.index > 0 || l.kind === 'quiz'
  })
}

/**
 * Filas crudas a lecciones. El orden de la pagina se respeta.
 *
 * La duracion se busca en el texto COMPLETO de la fila y el titulo sale de la
 * primera linea: en el panel de Udemy el `6min` vive en un renglon aparte, que
 * es justo el que `parseLectureText` descarta para no ensuciar el nombre.
 */
export function toLectures(rows: RawRow[]): Lecture[] {
  return rows.map((row) => {
    const { index, title } = parseLectureText(row.text)
    return {
      index,
      title,
      completed: row.completed,
      slug: lectureSlug(index, title),
      kind: classifyItem(title, hasDuration(row.text)),
      section: row.section ?? 0
    }
  })
}
