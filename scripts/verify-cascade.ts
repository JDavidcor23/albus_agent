/**
 * Verificación de la cascada sin red, sin credenciales y sin datos del usuario.
 * Correr con: npx tsx scripts/verify-cascade.ts
 */
import QRCode from 'qrcode'
import sharp from 'sharp'

import { runCascade } from '../src/main/core/extraction/cascade'
import { terminateOcr } from '../src/main/core/extraction/ocr'
import { findReceipt } from '../src/main/core/extraction/patterns'
import type { PendingItem } from '../src/main/core/extraction/types'

const QR_URL = 'https://ejemplo.com/albus'

let failures = 0

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`PASS  ${name}`)
  } else {
    console.log(`FAIL  ${name} — ${detail}`)
    failures++
  }
}

function imageItem(): PendingItem {
  return {
    entryId: '00000000-0000-0000-0000-000000000000',
    userId: '00000000-0000-0000-0000-000000000000',
    attachmentPath: 'fixture.png',
    mime: 'image/png',
    sizeBytes: 0,
    body: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    context: null
  }
}

async function main(): Promise<void> {
  // (a) QR derecho
  const qrPng = await QRCode.toBuffer(QR_URL, { width: 600, margin: 4 })
  const straight = await runCascade(imageItem(), qrPng)
  check(
    'a) QR derecho se decodifica',
    straight.kind === 'qr' && JSON.stringify(straight.payload).includes(QR_URL),
    `kind=${straight.kind} payload=${JSON.stringify(straight.payload)}`
  )

  // (b) el mismo QR rotado 90°
  const rotated = await sharp(qrPng).rotate(90).png().toBuffer()
  const turned = await runCascade(imageItem(), rotated)
  check(
    'b) QR rotado 90 grados se decodifica',
    turned.kind === 'qr' && JSON.stringify(turned.payload).includes(QR_URL),
    `kind=${turned.kind} payload=${JSON.stringify(turned.payload)}`
  )

  // (b2) QR de bajo contraste: fuerza el escalón de rescate en escala de grises.
  // Los intentos a color fallan y solo pasa si greyscale entrega RGBA de verdad.
  const faded = await sharp(qrPng)
    .linear(0.35, 140) // aplasta el contraste como una foto con flash
    .blur(1.1)
    .png()
    .toBuffer()
  const rescued = await runCascade(imageItem(), faded)
  check(
    'b2) QR de bajo contraste (escalón greyscale)',
    rescued.kind === 'qr' && JSON.stringify(rescued.payload).includes(QR_URL),
    `kind=${rescued.kind} payload=${JSON.stringify(rescued.payload)}`
  )

  // (c) imagen sólida sin QR ni texto: no debe tirar
  const blank = await sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 200, g: 200, b: 200 } }
  })
    .png()
    .toBuffer()
  const empty = await runCascade(imageItem(), blank)
  check(
    'c) imagen sin QR no revienta',
    empty.kind !== 'failed',
    `kind=${empty.kind} payload=${JSON.stringify(empty.payload)}`
  )

  // (d) comprobante colombiano por patrones
  const receipt = findReceipt(
    'Nequi - Enviaste $ 150.000,00 el 12/03/2026 Comprobante: M1234567890'
  )
  check(
    'd) comprobante Nequi: entidad, monto, fecha y referencia',
    receipt !== null &&
      receipt.entity === 'Nequi' &&
      receipt.amount === 150000 &&
      receipt.date === '2026-03-12' &&
      receipt.reference === 'M1234567890',
    JSON.stringify(receipt)
  )

  // (e) Caso real que falló en producción: "Enviaste" se colaba como referencia
  // porque el flag `i` vuelve [A-Z0-9] insensible a mayúsculas.
  const falsoRef = findReceipt('Bre-B Enviaste $400.000 a Juan')
  check(
    'e) una palabra sin digitos no pasa como referencia',
    falsoRef !== null && falsoRef.reference === null && falsoRef.amount === 400000,
    JSON.stringify(falsoRef)
  )

  await terminateOcr()

  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} caso(s) fallando`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('El script de verificación explotó:', error)
  process.exit(1)
})
