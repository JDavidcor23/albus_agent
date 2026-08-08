/**
 * Verificación del loop del worker sin red, sin Supabase y sin credenciales.
 * Correr con: npx tsx scripts/verify-worker.ts
 */
import { processBatch } from '../src/main/core/extraction/worker'
import { terminateOcr } from '../src/main/core/extraction/ocr'
import type { ItemSource, ResultSink } from '../src/main/core/extraction/ports'
import type { ExtractionResult, PendingItem } from '../src/main/core/extraction/types'

let failures = 0

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`PASS  ${name}`)
  } else {
    console.log(`FAIL  ${name} — ${detail}`)
    failures++
  }
}

function createMockItem(id: string, body: string | null = null, attachmentPath = ''): PendingItem {
  return {
    entryId: id,
    userId: '00000000-0000-0000-0000-000000000000',
    attachmentPath,
    mime: attachmentPath ? 'image/png' : 'text/plain',
    sizeBytes: body ? body.length : 0,
    body,
    createdAt: '2026-01-01T00:00:00.000Z',
    context: body
  }
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // Caso a) 3 items de body con texto -> processBatch los procesa y el sink recibe 3 saves
  // -------------------------------------------------------------------------
  const itemsA: PendingItem[] = [
    createMockItem('entry-1', 'https://github.com'),
    createMockItem('entry-2', 'Nequi - Enviaste $ 50.000,00 el 10/01/2026 Comprobante: M9999'),
    createMockItem('entry-3', 'https://linkedin.com/in/juan-perez')
  ]

  const savedA: { item: PendingItem; result: ExtractionResult }[] = []

  const sourceA: ItemSource = {
    async listPending() {
      return itemsA
    },
    async downloadAttachment() {
      throw new Error('No deberia llamarse para body')
    }
  }

  const sinkA: ResultSink = {
    async save(item, result) {
      savedA.push({ item, result })
    }
  }

  const resA = await processBatch(sourceA, sinkA, 10)

  check(
    'a) 3 items de body procesados y guardados',
    resA.processed === 3 && resA.failed === 0 && savedA.length === 3,
    `processed=${resA.processed} failed=${resA.failed} saved=${savedA.length}`
  )

  // -------------------------------------------------------------------------
  // Caso b) item cuyo downloadAttachment TIRA excepcion -> el lote NO se corta, failed === 1
  // -------------------------------------------------------------------------
  const itemsB: PendingItem[] = [
    createMockItem('entry-10', 'Texto normal 1', ''),
    createMockItem('entry-11', null, 'foto_corrupta.png'),
    createMockItem('entry-12', 'Texto normal 2', '')
  ]

  const savedB: { item: PendingItem; result: ExtractionResult }[] = []

  const sourceB: ItemSource = {
    async listPending() {
      return itemsB
    },
    async downloadAttachment(path) {
      if (path === 'foto_corrupta.png') {
        throw new Error('Fallo de red al descargar adjunto')
      }
      return new Uint8Array()
    }
  }

  const sinkB: ResultSink = {
    async save(item, result) {
      savedB.push({ item, result })
    }
  }

  const resB = await processBatch(sourceB, sinkB, 10)

  check(
    'b) excepcion en downloadAttachment no corta lote, failed === 1',
    resB.processed === 2 && resB.failed === 1,
    `processed=${resB.processed} failed=${resB.failed}`
  )

  // El item que falló tiene que quedar registrado como 'failed', o en la próxima
  // corrida vuelve a aparecer como pendiente y se reintenta para siempre.
  const failedRow = savedB.find((s) => s.item.attachmentPath === 'foto_corrupta.png')
  check(
    'b2) el fallo queda registrado y no vuelve a la cola',
    savedB.length === 3 &&
      failedRow !== undefined &&
      failedRow.result.kind === 'failed' &&
      String(failedRow.result.payload.error).includes('Fallo de red'),
    `saved=${savedB.length} failedRow=${JSON.stringify(failedRow?.result)}`
  )

  // -------------------------------------------------------------------------
  // Caso b3) si el sink tambien falla, NO se cuenta como guardado: reintentar
  // en la proxima corrida es lo correcto cuando la base esta caida.
  // -------------------------------------------------------------------------
  const brokenSink: ResultSink = {
    async save() {
      throw new Error('base caida')
    }
  }

  const resBroken = await processBatch(sourceB, brokenSink, 10)
  check(
    'b3) sink roto no tira la excepcion hacia afuera',
    resBroken.failed === 3 && resBroken.processed === 0,
    `processed=${resBroken.processed} failed=${resBroken.failed}`
  )

  // -------------------------------------------------------------------------
  // Caso c) conteo byKind refleja lo guardado
  // -------------------------------------------------------------------------
  const itemsC: PendingItem[] = [
    createMockItem('entry-20', 'Nequi - Enviaste $ 100.000,00 el 15/02/2026 Comprobante: M1111'),
    createMockItem('entry-21', 'https://github.com/albus'),
    createMockItem('entry-22', 'Texto simple sin nada especial')
  ]

  const savedC: { item: PendingItem; result: ExtractionResult }[] = []

  const sourceC: ItemSource = {
    async listPending() {
      return itemsC
    },
    async downloadAttachment() {
      return new Uint8Array()
    }
  }

  const sinkC: ResultSink = {
    async save(item, result) {
      savedC.push({ item, result })
    }
  }

  const resC = await processBatch(sourceC, sinkC, 10)

  const expectedKindCounts: Record<string, number> = {}
  for (const entry of savedC) {
    expectedKindCounts[entry.result.kind] = (expectedKindCounts[entry.result.kind] ?? 0) + 1
  }

  const kindMatch = Object.keys(expectedKindCounts).every(
    (k) => resC.byKind[k] === expectedKindCounts[k]
  )

  check(
    'c) conteo byKind coincide con lo guardado en el sink',
    resC.processed === 3 && resC.failed === 0 && kindMatch,
    `byKind=${JSON.stringify(resC.byKind)} expected=${JSON.stringify(expectedKindCounts)}`
  )

  await terminateOcr()

  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} caso(s) fallando`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('El script de verificación del worker explotó:', error)
  process.exit(1)
})
