import { clipboard, shell } from 'electron'
import { z } from 'zod'
import { registerHandler } from './register-handler'
import {
  IpcChannels,
  isOpenableUrl,
  type AskAnswer,
  type ExtractionKind,
  type TaskDetail,
  type TaskRow
} from '../../shared/ipc'
import { closeTask, getTaskDetail, listTasks } from '../supabase/tasks-repo'
import { interpret, compose } from '../core/tasks/ask'
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
 * renderer. La allowlist vive en `shared/ipc` porque el renderer también la
 * necesita — para no dibujar un botón que el main va a rechazar.
 *
 * Que el renderer la conozca NO la debilita: el chequeo que importa es este, y
 * corre acá. Lo de allá es cortesía visual.
 */
const OpenExternalSchema = z.object({
  url: z.string().url().refine(isOpenableUrl, 'host no permitido')
})

/**
 * Copiar NO lleva allowlist de host: el portapapeles no navega a ningún lado, y
 * el usuario pide justo esto para los links que la app no puede abrir.
 *
 * Sí lleva tope de largo. El main no confía en el renderer, y un bug del otro
 * lado que mande medio megabyte le pisaría el portapapeles al usuario con
 * basura. 4096 alcanza de sobra para cualquier URL.
 */
const ClipboardSchema = z.object({ text: z.string().min(1).max(4096) })

function toRow(t: Task): TaskRow {
  return {
    id: t.id,
    title: t.title,
    detail: t.detail,
    status: t.status,
    source: t.source,
    confidence: t.confidence,
    createdAt: t.createdAt,
    // Solo para el botón de agendar. No ordena la lista ni se pinta en la tarjeta.
    dueDate: t.dueDate
  }
}

export function registerTaskHandlers(): void {
  registerHandler(IpcChannels.TASKS_LIST, async () => (await listTasks('open')).map(toRow))

  registerHandler(IpcChannels.TASKS_DETAIL, async (payload: unknown): Promise<TaskDetail> => {
    const { id } = DetailSchema.parse(payload)

    const detail = await getTaskDetail(id)
    if (detail === null) throw new Error('ese pendiente ya no existe')

    return {
      task: toRow(detail.task),
      noteBody: detail.noteBody,
      noteSummary: detail.noteSummary,
      contacts: detail.contacts,
      sources: detail.sources.map((s) => ({
        kind: s.kind as ExtractionKind,
        captures: s.captures,
        photos: s.photos,
        text: s.text,
        rawText: s.rawText,
        driveLinks: s.driveLinks
      }))
    }
  })

  registerHandler(IpcChannels.OPEN_EXTERNAL, async (payload: unknown) => {
    const { url } = OpenExternalSchema.parse(payload)
    await shell.openExternal(url)
    return { opened: true }
  })

  registerHandler(IpcChannels.CLIPBOARD_WRITE, async (payload: unknown) => {
    const { text } = ClipboardSchema.parse(payload)
    clipboard.writeText(text)
    return { copied: true }
  })

  registerHandler(IpcChannels.TASKS_CLOSE, async (payload: unknown) => {
    const { id, status } = CloseSchema.parse(payload)
    await closeTask(id, status)
    return (await listTasks('open')).map(toRow)
  })

  registerHandler(IpcChannels.TASKS_ASK, async (payload: unknown): Promise<AskAnswer> => {
    const { message } = AskSchema.parse(payload)

    const openTasks = await listTasks('open')
    const intent = interpret(message, openTasks)

    // Cerrar es la única rama que escribe. Se hace ANTES de redactar para que el
    // texto y la lista que vuelven ya reflejen el estado nuevo.
    if (intent.kind === 'close') {
      const text = compose(intent, openTasks)
      await closeTask(intent.taskId, intent.asDismissed ? 'dismissed' : 'done')
      return {
        text,
        tasks: (await listTasks('open')).map(toRow),
        intent: 'close'
      }
    }

    if (intent.kind === 'ambiguous') {
      return {
        text: compose(intent, openTasks),
        tasks: intent.candidates.map(toRow),
        intent: 'ambiguous'
      }
    }

    if (intent.kind === 'tasks') {
      return { text: compose(intent, openTasks), tasks: openTasks.map(toRow), intent: 'tasks' }
    }

    return { text: compose(intent, openTasks), tasks: [], intent: 'help' }
  })
}
