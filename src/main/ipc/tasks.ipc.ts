import { shell } from 'electron'
import { z } from 'zod'
import { registerHandler } from './register-handler'
import {
  IpcChannels,
  type AskAnswer,
  type ExtractionKind,
  type TaskDetail,
  type TaskRow
} from '../../shared/ipc'
import { closeTask, getTaskDetail, listTasks } from '../supabase/tasks-repo'
import { interpretar, redactar } from '../core/tasks/ask'
import type { Task } from '../core/tasks/types'

// El main NUNCA confía en el renderer: todo payload se valida.
const AskSchema = z.object({ message: z.string().min(1).max(500) })
const CloseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['done', 'dismissed'])
})
const DetailSchema = z.object({ id: z.string().uuid() })

/**
 * Abrir un link es entregarle el navegador del sistema a algo que vino del
 * renderer. Va con allowlist de host, no con "empieza con https": un
 * `https://malicioso.com` pasaría ese chequeo igual.
 */
const HOSTS_PERMITIDOS = new Set([
  'drive.google.com',
  'docs.google.com',
  'www.linkedin.com',
  'linkedin.com',
  'www.meetup.com',
  'meetup.com'
])

const OpenExternalSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => {
      try {
        const parsed = new URL(u)
        return parsed.protocol === 'https:' && HOSTS_PERMITIDOS.has(parsed.hostname)
      } catch {
        return false
      }
    }, 'host no permitido')
})

function aRow(t: Task): TaskRow {
  return {
    id: t.id,
    title: t.title,
    detail: t.detail,
    status: t.status,
    source: t.source,
    confidence: t.confidence,
    createdAt: t.createdAt
  }
}

export function registerTaskHandlers(): void {
  registerHandler(IpcChannels.TASKS_LIST, async () => (await listTasks('open')).map(aRow))

  registerHandler(IpcChannels.TASKS_DETAIL, async (payload: unknown): Promise<TaskDetail> => {
    const { id } = DetailSchema.parse(payload)

    const detalle = await getTaskDetail(id)
    if (detalle === null) throw new Error('ese pendiente ya no existe')

    return {
      task: aRow(detalle.task),
      noteBody: detalle.noteBody,
      sources: detalle.sources.map((s) => ({
        kind: s.kind as ExtractionKind,
        text: s.text,
        driveLink: s.driveLink,
        driveFolder: s.driveFolder
      }))
    }
  })

  registerHandler(IpcChannels.OPEN_EXTERNAL, async (payload: unknown) => {
    const { url } = OpenExternalSchema.parse(payload)
    await shell.openExternal(url)
    return { opened: true }
  })

  registerHandler(IpcChannels.TASKS_CLOSE, async (payload: unknown) => {
    const { id, status } = CloseSchema.parse(payload)
    await closeTask(id, status)
    return (await listTasks('open')).map(aRow)
  })

  registerHandler(IpcChannels.TASKS_ASK, async (payload: unknown): Promise<AskAnswer> => {
    const { message } = AskSchema.parse(payload)

    const abiertos = await listTasks('open')
    const intent = interpretar(message, abiertos)

    // Cerrar es la única rama que escribe. Se hace ANTES de redactar para que el
    // texto y la lista que vuelven ya reflejen el estado nuevo.
    if (intent.kind === 'cerrar') {
      const texto = redactar(intent, abiertos)
      await closeTask(intent.taskId, intent.comoDismissed ? 'dismissed' : 'done')
      return {
        text: texto,
        tasks: (await listTasks('open')).map(aRow),
        intent: 'cerrar'
      }
    }

    if (intent.kind === 'ambiguo') {
      return {
        text: redactar(intent, abiertos),
        tasks: intent.candidatos.map(aRow),
        intent: 'ambiguo'
      }
    }

    if (intent.kind === 'pendientes') {
      return { text: redactar(intent, abiertos), tasks: abiertos.map(aRow), intent: 'pendientes' }
    }

    return { text: redactar(intent, abiertos), tasks: [], intent: 'ayuda' }
  })
}
