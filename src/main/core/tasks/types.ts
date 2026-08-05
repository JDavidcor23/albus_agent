/**
 * Pendientes derivados de las notas. Dominio puro: no importa electron ni
 * supabase ni ningún CLI.
 */

/** Espejo del CHECK de `tasks.status` en supabase/migrations/0002_tasks.sql. */
export type TaskStatus = 'open' | 'done' | 'dismissed'

export interface DetectedTask {
  /** Accionable y en primera persona: "Postularme a Globant", no "Oferta". */
  title: string
  /** Por qué esto es un pendiente, en una línea legible. Nunca un volcado. */
  detail: string | null
  /** 0..1. Un "tengo que X" explícito vale más que una inferencia. */
  confidence: number

  /**
   * Identidad estable de la COSA, para no duplicarla entre notas distintas.
   *
   * `null` = deduplicar solo dentro de la nota. Es el default correcto para todo
   * lo que detecta el modelo: "Pagar el gym" en la nota de enero y en la de
   * febrero son dos pagos, no uno, y colapsarlos por título sería perder uno.
   *
   * Lo setea solo lo que tiene identidad real y repetible — hoy, un QR legible:
   * volver a subir la misma captura del mismo grupo de Meetup es la misma cosa
   * por hacer, sin importar en qué nota la guardaste.
   */
  dedupeKey?: string | null
}

export interface Task extends DetectedTask {
  id: string
  entryId: string
  status: TaskStatus
  source: string
  createdAt: string
  closedAt: string | null

  /**
   * Cuándo hay que actuar, en ISO `yyyy-mm-dd`. Solo lo usa el botón de Calendar.
   *
   * Va en `Task` y NO en `DetectedTask` a propósito: hoy nada lo ESCRIBE. Las tres
   * fechas que existen las dejó una corrida anterior de la detección. Mientras la
   * extracción de fechas no vuelva, este campo se lee pero no se llena — y ponerlo
   * en `DetectedTask` sugeriría lo contrario.
   */
  dueDate: string | null
}

/** Lo que la cascada sacó de un adjunto. Sin píxeles: solo el resultado. */
export interface AttachmentInfo {
  kind: string
  payload: Record<string, unknown>
}

/**
 * Lo que hay para analizar de una entry. El adjunto entra por lo que se le
 * extrajo, no como imagen: para saber si queda algo por hacer importa QUÉ es la
 * captura ("una oferta de trabajo en LinkedIn"), no sus píxeles.
 */
export interface TaskCandidate {
  entryId: string
  userId: string
  body: string
  attachments: AttachmentInfo[]
}
