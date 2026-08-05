/**
 * Pendientes derivados de las notas. Dominio puro: no importa electron ni
 * supabase ni ningún CLI.
 */

/** Espejo del CHECK de `tasks.status` en supabase/migrations/0002_tasks.sql. */
export type TaskStatus = 'open' | 'done' | 'dismissed'

export interface DetectedTask {
  /** Accionable y en primera persona: "Postularme a Globant", no "Oferta". */
  title: string
  /** El texto de la nota del que salió, para poder auditarlo. */
  detail: string | null
  /** 0..1. Un "tengo que X" explícito vale más que una inferencia. */
  confidence: number
}

export interface Task extends DetectedTask {
  id: string
  entryId: string
  status: TaskStatus
  source: string
  createdAt: string
  closedAt: string | null
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
