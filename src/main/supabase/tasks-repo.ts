import { z } from 'zod'
import { getSupabaseClient } from './client'
import type { DetectedTask, Task, TaskCandidate, TaskStatus } from '../core/tasks/types'

const CandidatoSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  body: z.string().nullable(),
  extractions: z
    .array(z.object({ kind: z.string(), payload: z.unknown() }))
    .nullable(),
  tasks: z.array(z.object({ id: z.string() })).nullable()
})

const TaskRowSchema = z.object({
  id: z.string(),
  entry_id: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  status: z.enum(['open', 'done', 'dismissed']),
  source: z.string(),
  confidence: z.number(),
  created_at: z.string(),
  closed_at: z.string().nullable()
})

/**
 * Entries con texto que TODAVÍA no fueron analizadas.
 *
 * Excluir las ya analizadas hace dos cosas a la vez: no vuelve a gastar cuota
 * sobre lo mismo, y hace imposible duplicar pendientes. Si querés re-analizar
 * una entry, primero hay que borrarle los tasks.
 */
export async function listTaskCandidates(limit: number): Promise<TaskCandidate[]> {
  const supabase = getSupabaseClient()

  const { data, error } = await supabase
    .from('entries')
    .select('id, user_id, body, extractions ( kind, payload ), tasks ( id )')
    .order('created_at', { ascending: true })
    .limit(limit)

  if (error) throw new Error(`Error listando candidatos a task: ${error.message}`)

  const out: TaskCandidate[] = []
  for (const raw of Array.isArray(data) ? data : []) {
    // Por fila, no por lote: una entry corrupta se saltea sola.
    const parsed = CandidatoSchema.safeParse(raw)
    if (!parsed.success) {
      console.warn('[tasks-repo] fila de entries descartada por schema inválido')
      continue
    }
    const row = parsed.data

    if ((row.tasks ?? []).length > 0) continue

    const body = (row.body ?? '').trim()
    if (body.length === 0) continue

    out.push({
      entryId: row.id,
      userId: row.user_id,
      body,
      attachments: (row.extractions ?? []).map((e) => ({
        kind: e.kind,
        payload: (e.payload ?? {}) as Record<string, unknown>
      }))
    })
  }

  return out
}

/**
 * Guarda los pendientes de una entry. Inserta de a uno: un título repetido choca
 * contra el unique y solo se pierde ESE, no el lote entero.
 *
 * Devuelve cuántos entraron de verdad.
 */
export async function saveTasks(
  candidate: TaskCandidate,
  tasks: DetectedTask[],
  source: string
): Promise<number> {
  const supabase = getSupabaseClient()
  let guardados = 0

  for (const t of tasks) {
    const { error } = await supabase.from('tasks').insert({
      entry_id: candidate.entryId,
      user_id: candidate.userId,
      title: t.title,
      detail: t.detail,
      source,
      confidence: t.confidence
    })

    if (error) {
      // 23505 = unique_violation. Ya existía: no es un problema.
      if (error.code === '23505') continue
      console.warn(`[tasks-repo] no se pudo guardar "${t.title}": ${error.message}`)
      continue
    }
    guardados++
  }

  return guardados
}

/**
 * Marca una entry como analizada aunque no haya dado ningún pendiente.
 *
 * Sin esto, una nota sin nada que hacer se vuelve a mandar al modelo en cada
 * corrida, para siempre, gastando cuota para recibir la misma lista vacía.
 */
export async function markAnalyzedWithNoTasks(candidate: TaskCandidate): Promise<void> {
  const supabase = getSupabaseClient()
  const { error } = await supabase.from('tasks').insert({
    entry_id: candidate.entryId,
    user_id: candidate.userId,
    title: '(sin pendientes)',
    detail: null,
    status: 'dismissed',
    closed_at: new Date().toISOString(),
    source: 'centinela',
    confidence: 0
  })
  if (error && error.code !== '23505') {
    console.warn(`[tasks-repo] no se pudo marcar la entry como analizada: ${error.message}`)
  }
}

export async function listTasks(status: TaskStatus | 'all' = 'open'): Promise<Task[]> {
  const supabase = getSupabaseClient()

  let query = supabase
    .from('tasks')
    .select('id, entry_id, title, detail, status, source, confidence, created_at, closed_at')
    .neq('source', 'centinela')
    .order('confidence', { ascending: false })

  if (status !== 'all') query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw new Error(`Error listando tasks: ${error.message}`)

  const out: Task[] = []
  for (const raw of Array.isArray(data) ? data : []) {
    const parsed = TaskRowSchema.safeParse(raw)
    if (!parsed.success) continue
    const r = parsed.data
    out.push({
      id: r.id,
      entryId: r.entry_id,
      title: r.title,
      detail: r.detail,
      status: r.status,
      source: r.source,
      confidence: r.confidence,
      createdAt: r.created_at,
      closedAt: r.closed_at
    })
  }
  return out
}

const DetalleSchema = z.object({
  id: z.string(),
  entry_id: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  status: z.enum(['open', 'done', 'dismissed']),
  source: z.string(),
  confidence: z.number(),
  created_at: z.string(),
  closed_at: z.string().nullable(),
  entries: z
    .object({
      body: z.string().nullable(),
      extractions: z
        .array(
          z.object({
            attachment_path: z.string(),
            kind: z.string(),
            payload: z.unknown()
          })
        )
        .nullable()
    })
    .nullable()
})

export interface TaskSourceRow {
  kind: string
  text: string | null
  driveLink: string | null
  driveFolder: string | null
}

/**
 * Todo lo que hay detrás de un pendiente: la nota que escribiste y cada captura
 * que guardaste con ella, con el texto COMPLETO del OCR y el link a la imagen
 * en Drive.
 *
 * El link importa más de lo que parece: el OCR de una captura de LinkedIn sale
 * fragmentado ("We're hiring a Senior Fronten…") y no dice cómo aplicar. La
 * imagen original sí lo dice. Recortar el texto es tarea de la UI, no de acá:
 * si el repo devuelve 220 caracteres, el detalle no puede mostrar más.
 */
export async function getTaskDetail(
  id: string
): Promise<{ task: Task; noteBody: string; sources: TaskSourceRow[] } | null> {
  const supabase = getSupabaseClient()

  const { data, error } = await supabase
    .from('tasks')
    .select(
      'id, entry_id, title, detail, status, source, confidence, created_at, closed_at,' +
        ' entries ( body, extractions ( attachment_path, kind, payload ) )'
    )
    .eq('id', id)
    .maybeSingle()

  if (error) throw new Error(`Error leyendo el detalle de ${id}: ${error.message}`)
  if (data === null) return null

  const parsed = DetalleSchema.safeParse(data)
  if (!parsed.success) throw new Error(`Detalle con forma inesperada: ${parsed.error.message}`)
  const r = parsed.data

  const sources: TaskSourceRow[] = []
  for (const e of r.entries?.extractions ?? []) {
    // El body de la entry también tiene su fila en `extractions`, con
    // attachment_path ''. No es una captura: ya se muestra como `noteBody`.
    // Dejarlo acá lo duplicaba y encima aparecía "sin link", como si faltara algo.
    if (e.attachment_path === '') continue

    const p = (e.payload ?? {}) as Record<string, unknown>
    const drive = p.drive as { fileId?: string; folder?: string; webViewLink?: string } | undefined

    // El texto útil según el tipo: de un QR interesa el código, de una captura
    // el OCR, de un comprobante los campos.
    let text: string | null = null
    if (typeof p.text === 'string' && p.text.trim().length > 0) text = p.text
    else if (Array.isArray(p.codes) && p.codes.length > 0) text = p.codes.join('\n')
    else if (Array.isArray(p.profiles) && p.profiles.length > 0) text = p.profiles.join('\n')
    else if (p.amount !== undefined) {
      text = [
        p.merchant ? `a ${String(p.merchant)}` : null,
        p.amount ? `monto ${String(p.amount)}` : null,
        p.date ? `fecha ${String(p.date)}` : null,
        p.reference ? `ref ${String(p.reference)}` : null
      ]
        .filter(Boolean)
        .join(' · ')
    }

    sources.push({
      kind: e.kind,
      text,
      driveLink: typeof drive?.webViewLink === 'string' ? drive.webViewLink : null,
      driveFolder: typeof drive?.folder === 'string' ? drive.folder : null
    })
  }

  return {
    task: {
      id: r.id,
      entryId: r.entry_id,
      title: r.title,
      detail: r.detail,
      status: r.status,
      source: r.source,
      confidence: r.confidence,
      createdAt: r.created_at,
      closedAt: r.closed_at
    },
    noteBody: (r.entries?.body ?? '').trim(),
    sources
  }
}

/** Cerrar es lo que hace que la lista siga sirviendo dentro de un mes. */
export async function closeTask(id: string, status: 'done' | 'dismissed'): Promise<void> {
  const supabase = getSupabaseClient()
  const { error } = await supabase
    .from('tasks')
    .update({ status, closed_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw new Error(`Error cerrando task ${id}: ${error.message}`)
}
