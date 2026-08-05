import { z } from 'zod'
import { getSupabaseClient } from './client'
import { fusionarCapturas } from '../core/extraction/clean-ocr'
import { esCifrado } from '../core/tasks/qr-identity'
import { leerResumen } from './note-summary-repo'
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
  closed_at: z.string().nullable(),
  due_date: z.string().nullable()
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
      confidence: t.confidence,
      // Idempotencia por esquema: el unique parcial (user_id, dedupe_key) es lo
      // que hace que volver a subir la misma captura en otra nota no duplique.
      // null cuando la cosa no tiene identidad repetible — ver 0003.
      dedupe_key: t.dedupeKey ?? null,
      due_date: t.dueDate ?? null
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

/**
 * Los pendientes, ordenados por CUÁNDO HAY QUE HACERLOS.
 *
 * Antes ordenaba por `confidence`, que mide cuán seguro estaba el modelo. Con 20
 * tareas y 5 valores distintos, 11 quedaban empatadas y su orden era el que
 * Postgres devolviera — y las dos únicas con fecha real caían 15° y última.
 *
 * `confidence` sigue siendo el segundo criterio: entre dos cosas sin fecha, una
 * regla ("usar este QR") pesa más que una inferencia ("quizás quieras postularte").
 */
export async function listTasks(status: TaskStatus | 'all' = 'open'): Promise<Task[]> {
  const supabase = getSupabaseClient()

  let query = supabase
    .from('tasks')
    .select(
      'id, entry_id, title, detail, status, source, confidence, created_at, closed_at, due_date'
    )
    .neq('source', 'centinela')
    .order('due_date', { ascending: true, nullsFirst: false })
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
      closedAt: r.closed_at,
      dueDate: r.due_date
    })
  }
  return out
}

const DetalleSchema = z.object({
  id: z.string(),
  entry_id: z.string(),
  /** Hace falta para resolver el email del dueño y no ofrecérselo como contacto. */
  user_id: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  status: z.enum(['open', 'done', 'dismissed']),
  source: z.string(),
  confidence: z.number(),
  created_at: z.string(),
  closed_at: z.string().nullable(),
  due_date: z.string().nullable(),
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

/**
 * Las capturas de una nota, agrupadas POR TIPO y no por archivo.
 *
 * Antes había una fila por adjunto. Una nota con 3 fotos del mismo QR daba tres
 * bloques que decían casi lo mismo, y el usuario los leyó como "tres links":
 * `código QR · drive/qr-eventos` repetido. Su reclamo fue exacto — "si ya tengo
 * una, ya cualquiera me sirve".
 */
export interface TaskSourceRow {
  kind: string
  /** Cuántas capturas se fusionaron acá. La UI dice "3 capturas", no las repite. */
  captures: number
  /** Texto fusionado y limpio de chrome. `null` si el OCR no dejó nada legible. */
  text: string | null
  /** El crudo, detrás de un toggle. Sin esto un heurístico no es auditable. */
  rawText: string | null
  /** Links a las originales. El OCR pierde cosas; la foto no. */
  driveLinks: string[]
}

/** Emails y links que estaban enterrados en el OCR. */
export interface TaskContacts {
  emails: string[]
  urls: string[]
}

const RE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/g
const RE_URL = /https?:\/\/[^\s<>"')\]]+/g

/**
 * El texto útil de un payload, según lo que la cascada haya resuelto.
 *
 * Un QR CIFRADO devuelve null a propósito: el ciphertext no le dice nada a nadie
 * y ocupaba 192 caracteres del detalle. Que no haya nada que mostrar es
 * información, y el título ya explica por qué.
 */
function textoDe(p: Record<string, unknown>): string | null {
  if (typeof p.text === 'string' && p.text.trim().length > 0) return p.text

  if (Array.isArray(p.codes) && p.codes.length > 0) {
    const legibles = p.codes.filter((c): c is string => typeof c === 'string' && !esCifrado(c))
    return legibles.length > 0 ? legibles.join('\n') : null
  }

  if (Array.isArray(p.profiles) && p.profiles.length > 0) return p.profiles.join('\n')

  if (p.amount !== undefined) {
    return [
      p.merchant ? `a ${String(p.merchant)}` : null,
      p.amount ? `monto ${String(p.amount)}` : null,
      p.date ? `fecha ${String(p.date)}` : null,
      p.reference ? `ref ${String(p.reference)}` : null
    ]
      .filter(Boolean)
      .join(' · ')
  }

  return null
}

/**
 * El email del dueño de la nota, para no ofrecérselo como forma de contacto.
 *
 * Sin esto, el detalle del evento de cripto resaltaba la propia dirección del
 * usuario bajo "cómo contactar" — leída del OCR de su propia pantalla de perfil.
 * Prometer un canal de contacto y mostrarle su propio mail es peor que no
 * mostrar nada.
 *
 * Nunca lanza: si la consulta falla, se sigue sin filtrar. Un email de más es
 * ruido; un detalle que no carga es un pendiente que no se puede leer.
 */
async function emailDelDueño(userId: string): Promise<string | null> {
  try {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase.auth.admin.getUserById(userId)
    if (error) throw new Error(error.message)
    const email = data.user?.email
    return typeof email === 'string' && email.length > 0 ? email.toLowerCase() : null
  } catch (err: unknown) {
    console.warn(
      `[tasks-repo] no se pudo resolver el email del dueño ${userId}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    )
    return null
  }
}

/**
 * Todo lo que hay detrás de un pendiente, listo para leer.
 *
 * Cambió de "devolver todo crudo y que la UI recorte" a "devolver lo legible y
 * el crudo aparte". El motivo: la UI recortaba a 220 caracteres un texto que
 * empezaba con la barra de estado del teléfono, así que el recorte se gastaba
 * entero en basura y el dato bueno nunca entraba. Limpiar es una decisión de
 * dominio, no de presentación.
 *
 * Los emails y links se buscan sobre el CRUDO, no sobre el limpio: la barra de
 * direcciones es ruido para leer pero puede ser el único lugar donde quedó una URL.
 */
export async function getTaskDetail(id: string): Promise<{
  task: Task
  noteBody: string
  noteSummary: string | null
  contacts: TaskContacts
  sources: TaskSourceRow[]
} | null> {
  const supabase = getSupabaseClient()

  const { data, error } = await supabase
    .from('tasks')
    .select(
      'id, entry_id, user_id, title, detail, status, source, confidence, created_at, closed_at,' +
        ' due_date, entries ( body, extractions ( attachment_path, kind, payload ) )'
    )
    .eq('id', id)
    .maybeSingle()

  if (error) throw new Error(`Error leyendo el detalle de ${id}: ${error.message}`)
  if (data === null) return null

  const parsed = DetalleSchema.safeParse(data)
  if (!parsed.success) throw new Error(`Detalle con forma inesperada: ${parsed.error.message}`)
  const r = parsed.data

  // Un acumulador por tipo, en orden de aparición.
  const porTipo = new Map<string, { textos: string[]; links: string[]; capturas: number }>()
  let noteSummary: string | null = null
  const crudoParaContactos: string[] = []

  for (const e of r.entries?.extractions ?? []) {
    const p = (e.payload ?? {}) as Record<string, unknown>

    // attachment_path '' es la fila del body: no es una captura. Ahí vive el
    // resumen de la nota (ver note-summary-repo).
    if (e.attachment_path === '') {
      noteSummary = leerResumen(p)
      continue
    }

    const texto = textoDe(p)
    if (texto !== null) crudoParaContactos.push(texto)

    const drive = p.drive as { webViewLink?: string } | undefined
    const grupo = porTipo.get(e.kind) ?? { textos: [], links: [], capturas: 0 }

    grupo.capturas++
    if (texto !== null) grupo.textos.push(texto)
    if (typeof drive?.webViewLink === 'string') grupo.links.push(drive.webViewLink)
    porTipo.set(e.kind, grupo)
  }

  const sources: TaskSourceRow[] = [...porTipo.entries()].map(([kind, g]) => {
    const fusionado = fusionarCapturas(g.textos)
    return {
      kind,
      captures: g.capturas,
      text: fusionado.length > 0 ? fusionado : null,
      rawText: g.textos.length > 0 ? g.textos.join('\n\n— — —\n\n') : null,
      driveLinks: [...new Set(g.links)]
    }
  })

  const todoElCrudo = crudoParaContactos.join('\n')
  const propio = await emailDelDueño(r.user_id)

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
      closedAt: r.closed_at,
      dueDate: r.due_date
    },
    noteBody: (r.entries?.body ?? '').trim(),
    noteSummary,
    contacts: {
      emails: [...new Set(todoElCrudo.match(RE_EMAIL) ?? [])].filter(
        (e) => propio === null || e.toLowerCase() !== propio
      ),
      urls: [...new Set(todoElCrudo.match(RE_URL) ?? [])]
    },
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
