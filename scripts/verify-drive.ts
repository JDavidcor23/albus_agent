/**
 * Verifica el archivado en Drive de punta a punta.
 *
 *   npx tsx scripts/verify-drive.ts
 *
 * Sube un archivo de prueba REAL, comprueba que la idempotencia funciona y
 * limpia lo que creo. No deja basura en el Drive del usuario.
 */
import sharp from 'sharp'
import { createDriveArchive } from '../src/main/drive/archive'
import { isDriveConfigured } from '../src/main/drive/client'
import { decideArchive, archiveFileName, archiveKey } from '../src/main/core/extraction/archive'
import type { ExtractionResult, PendingItem } from '../src/main/core/extraction/types'
import { trashFile, listAll } from './lib/drive'

let failures = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`)
  else {
    console.log(`FAIL  ${name} — ${detail}`)
    failures++
  }
}

/**
 * El path tiene la forma REAL de Supabase Storage: uuid/fecha/uuid-nombre.
 * Con un path corto de fixture este script pasaba en verde mientras produccion
 * fallaba con 403 por el tope de 124 bytes de appProperties. Un fixture que no
 * se parece a los datos reales no esta probando nada.
 */
const ITEM: PendingItem = {
  entryId: 'dcd0197c-953d-402a-929e-a14dd3676883',
  userId: '00000000-0000-0000-0000-000000000000',
  attachmentPath:
    '169c4008-cc36-4235-9ccf-d04cd811b411/2026-07-31/' +
    'verifydrive-e5928075-5459-48af-9868-bc03de02fd4e-Captura_de_pantalla_2026-07-31_083200.png',
  mime: 'image/png',
  sizeBytes: 0,
  body: null,
  createdAt: '2026-07-31T14:03:00.000Z',
  // Lo que el usuario escribio al subir la captura. Es la etiqueta buena.
  context: 'pago de gym'
}

const RECEIPT: ExtractionResult = {
  kind: 'receipt',
  payload: { amount: 400_000, entity: 'Bre-B', date: '2026-05-30', context: 'pago de gym' },
  confidence: 0.9,
  source: 'tesseract'
}

// Se deriva del MISMO resultado que se sube. Calcularlo con un payload distinto
// hacia que el test buscara un nombre que nunca se creo.
const NOMBRE_ESPERADO = archiveFileName(ITEM, RECEIPT)

async function main(): Promise<void> {
  // --- 1. Politica de retencion: funciones puras, sin red -------------------
  console.log('--- politica de retencion (pura) ---')

  check('comprobante -> pagos', decideArchive(RECEIPT) === 'pagos')

  check(
    'QR de evento -> qr-eventos',
    decideArchive({ kind: 'qr', payload: { codes: ['ABC123'] }, confidence: 1, source: 'jsqr' }) ===
      'qr-eventos'
  )

  check(
    'QR de LinkedIn -> contactos',
    decideArchive({
      kind: 'qr',
      payload: { codes: ['https://linkedin.com/in/x'], profiles: [{ handle: 'x' }] },
      confidence: 1,
      source: 'jsqr'
    }) === 'contactos'
  )

  check(
    'lamina corporativa (text) -> info',
    decideArchive({
      kind: 'text',
      payload: { text: 'vision y mision' },
      confidence: 0.2,
      source: 'tesseract'
    }) === 'info'
  )

  // La regla de oro: con bytes en la mano, NUNCA se descarta el original.
  // El OCR de las laminas produce basura ("Y1los — OS y tomamos decisiones"),
  // asi que borrar apoyandose en el texto es perder el contenido.
  const TODOS: ExtractionResult['kind'][] = [
    'qr',
    'receipt',
    'profile',
    'document',
    'text',
    'none',
    'failed'
  ]
  const sinCarpeta = TODOS.filter(
    (kind) => decideArchive({ kind, payload: {}, confidence: 0, source: 'x' }) === null
  )
  check(
    'ningun kind descarta el original',
    sinCarpeta.length === 0,
    `se descartarian: ${sinCarpeta.join(', ')}`
  )

  // El nombre tiene que ser encontrable desde el celular, no arrastrar el UUID
  // de Storage. Etiqueta = lo que escribio el usuario; fecha = la del PAGO.
  const nombre = archiveFileName(ITEM, RECEIPT)
  check('nombre usa la etiqueta del usuario, no el UUID', nombre.includes('pago-de-gym'), nombre)
  check('nombre usa la fecha del PAGO, no la de captura', nombre.startsWith('2026-05-30_'), nombre)
  check('nombre conserva la extension', nombre.endsWith('.png'), nombre)
  check('nombre no arrastra el UUID de Storage', !nombre.includes('e5928075'), nombre)

  // Regresion del 403 que rompio produccion: Drive limita CADA appProperty a
  // 124 bytes UTF-8 contando clave + valor.
  const pesoProp = Buffer.byteLength(`albusKey${archiveKey(ITEM)}`, 'utf8')
  check(
    `clave de idempotencia entra en los 124 bytes de Drive (${pesoProp})`,
    pesoProp <= 124,
    `${pesoProp} bytes`
  )

  // --- 2. Round-trip real contra Drive -------------------------------------
  if (!isDriveConfigured()) {
    console.log('\nDrive sin configurar — se saltea el round-trip real.')
    process.exit(failures === 0 ? 0 : 1)
  }

  console.log('\n--- round-trip real contra Drive ---')

  const png = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 30, g: 90, b: 200 } }
  })
    .png()
    .toBuffer()

  const archive = createDriveArchive()
  let uploadedId: string | null = null

  try {
    const first = await archive.archive(ITEM, RECEIPT, 'pagos', new Uint8Array(png))
    uploadedId = first.fileId

    check('sube y devuelve fileId', first.fileId.length > 0, JSON.stringify(first))
    check('marca reused=false en la primera subida', first.reused === false)
    check('devuelve webViewLink para abrir desde el celular', first.webViewLink !== null)

    // Lo importante: reprocesar NO debe duplicar.
    const second = await archive.archive(ITEM, RECEIPT, 'pagos', new Uint8Array(png))
    check('idempotencia: mismo fileId en la segunda pasada', second.fileId === first.fileId,
      `${first.fileId} vs ${second.fileId}`)
    check('idempotencia: marca reused=true', second.reused === true)

    // Y que efectivamente haya UNA sola copia en Drive.
    const copies = await listAll(`name = '${NOMBRE_ESPERADO}' and trashed = false`)
    check('hay exactamente 1 copia en Drive', copies.length === 1, `encontradas: ${copies.length}`)

    // Y que este en la carpeta correcta.
    const pagos = await listAll(
      `name = 'pagos' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    )
    check(
      'quedo dentro de "pagos"',
      copies[0]?.parents?.[0] === pagos[0]?.id,
      `parent=${copies[0]?.parents?.[0]} pagos=${pagos[0]?.id}`
    )
  } finally {
    if (uploadedId) {
      await trashFile(uploadedId)
      console.log(`\n(limpieza) archivo de prueba mandado a la papelera: ${uploadedId}`)
    }
  }

  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLAS`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nError:', err instanceof Error ? err.message : err)
  process.exit(1)
})
