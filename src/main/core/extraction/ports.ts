import type { ExtractionResult, PendingItem } from './types'
import type { ArchiveFolder, ArchivedRef } from './archive'

export interface ItemSource {
  listPending(limit: number): Promise<PendingItem[]>
  downloadAttachment(path: string): Promise<Uint8Array>
}

export interface ResultSink {
  save(item: PendingItem, result: ExtractionResult): Promise<void>
}

/**
 * Guarda la imagen donde el usuario la pueda ver desde el celular. El dominio
 * no sabe que abajo hay Google Drive: solo pide una carpeta lógica y recibe una
 * referencia. Cambiar Drive por otra cosa es cambiar el adaptador, nada más.
 */
export interface ArchivePort {
  archive(
    item: PendingItem,
    result: ExtractionResult,
    folder: ArchiveFolder,
    bytes: Uint8Array
  ): Promise<ArchivedRef>
}

