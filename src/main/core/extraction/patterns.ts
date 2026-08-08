/**
 * Clasificadores deterministas sobre texto. Funciones puras, sin IO.
 *
 * El texto llega del `body` de una entry o de la salida del OCR. Todo lo que se
 * pueda resolver acá no gasta cuota de ningún CLI.
 */

export interface ReceiptFields {
  /** El RIEL de pago: PSE, Nequi, Bre-B. Dice cómo pagaste, no qué pagaste. */
  entity: string | null
  /**
   * A QUIÉN le pagaste. "DIAN", "@calderon1973".
   *
   * Es el campo que importa para clasificar: `entity` te dice que usaste PSE,
   * que es como decir "pagué con tarjeta". El comercio es lo que distingue el
   * gas del gimnasio, y es ESTABLE entre pagos del mismo servicio.
   */
  merchant: string | null
  /**
   * Número de contrato o cuenta con ese comercio ("Referencia 1" en PSE).
   * Estable entre pagos, a diferencia de `reference`, que es de la transacción.
   */
  accountRef: string | null
  /** Monto normalizado a número. 150000 para "$ 150.000,00". */
  amount: number | null
  /** ISO yyyy-mm-dd. */
  date: string | null
  /** Referencia de ESTA transacción. Cambia en cada pago; no sirve para agrupar. */
  reference: string | null
}

export interface ReceiptMatch extends ReceiptFields {
  /** 0..1 según cuántos de los cuatro campos se reconocieron. */
  confidence: number
}

const ENTITIES = [
  'Nequi',
  'Bancolombia',
  'Daviplata',
  'Davivienda',
  'Bre-B',
  'Movii',
  'Lulo Bank',
  'Banco de Bogotá',
  'BBVA',
  'Scotiabank Colpatria',
  'PSE'
] as const

const MONTHS: Record<string, number> = {
  enero: 1, ene: 1,
  febrero: 2, feb: 2,
  marzo: 3, mar: 3,
  abril: 4, abr: 4,
  mayo: 5,
  junio: 6, jun: 6,
  julio: 7, jul: 7,
  agosto: 8, ago: 8,
  septiembre: 9, setiembre: 9, sep: 9, sept: 9,
  octubre: 10, oct: 10,
  noviembre: 11, nov: 11,
  diciembre: 12, dic: 12
}

// ---------------------------------------------------------------------------
// Monto
// ---------------------------------------------------------------------------

/**
 * Colombia escribe el punto como separador de miles y la coma como decimal
 * ($ 150.000,00), al revés que el formato anglosajón. Distinguirlos por el
 * último separador es ambiguo con dos decimales, así que se decide por la
 * FORMA completa del número, no por el último carácter.
 */
function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '')

  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(cleaned)) {
    return Number(cleaned.replace(/\./g, '').replace(',', '.'))
  }
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(cleaned)) {
    return Number(cleaned.replace(/,/g, ''))
  }
  if (/^\d+(,\d{1,2})$/.test(cleaned)) {
    return Number(cleaned.replace(',', '.'))
  }
  if (/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return Number(cleaned)
  }

  return null
}

export function findAmount(text: string): number | null {
  // Se exige el signo o el código de moneda: un número suelto en una nota no
  // es un monto, y tratarlo como tal genera comprobantes fantasma.
  const pattern = /(?:\$|COP)\s*([\d.,]+)/gi
  let best: number | null = null

  for (const match of text.matchAll(pattern)) {
    const value = parseAmount(match[1])
    // El mayor de la captura: los recibos suelen mostrar el total junto a
    // comisiones y saldos, y el total es el que interesa.
    if (value !== null && value > 0 && (best === null || value > best)) {
      best = value
    }
  }

  return best
}

// ---------------------------------------------------------------------------
// Fecha
// ---------------------------------------------------------------------------

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const yyyy = year < 100 ? 2000 + year : year
  return `${String(yyyy).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function findDate(text: string): string | null {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (iso) return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  // dd/mm/aaaa — en Colombia el día va primero, nunca el mes.
  const numeric = text.match(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/)
  if (numeric) return toIso(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]))

  const written = text.match(
    /\b(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})\b/i
  )
  if (written) {
    const month = MONTHS[written[2].toLowerCase()]
    if (month !== undefined) return toIso(Number(written[3]), month, Number(written[1]))
  }

  const short = text.match(/\b(\d{1,2})\s+([a-záéíóú]{3,10})\.?\s+(\d{4})\b/i)
  if (short) {
    const month = MONTHS[short[2].toLowerCase()]
    if (month !== undefined) return toIso(Number(short[3]), month, Number(short[1]))
  }

  return null
}

// ---------------------------------------------------------------------------
// Entidad y referencia
// ---------------------------------------------------------------------------

export function findEntity(text: string): string | null {
  const lower = text.toLowerCase()
  for (const entity of ENTITIES) {
    if (lower.includes(entity.toLowerCase())) return entity
  }
  return null
}

/**
 * A quién le pagaste. Hay dos formas, según el tipo de pago:
 *
 *  - PSE y facturas:  "Comercio: DIAN - PSE"   (etiqueta y valor en la misma línea)
 *  - Transferencia:   "Llave\n@calderon1973"   (valor en la línea siguiente)
 *
 * El sufijo " - PSE" se recorta: es el riel, ya lo captura `findEntity`.
 *
 * OJO: verificado contra comprobantes de PSE/DIAN y Bre-B reales. Los de gas e
 * internet deberían usar el mismo formato de PSE, pero no hay muestra todavía.
 */
export function findMerchant(text: string): string | null {
  const merchant = text.match(/comercio\s*:\s*([^\n]+)/i)
  if (merchant) {
    const clean = merchant[1].replace(/\s*[-–]\s*PSE\s*$/i, '').trim()
    if (clean.length > 0) return clean
  }

  const key = text.match(/^[ \t]*llave[ \t]*$\r?\n[ \t]*(@?[\w.\-]{3,})/im)
  if (key) return key[1].trim()

  return null
}

/** "Referencia 1: 03-1127626954" — el contrato, no la transacción. */
export function findAccountRef(text: string): string | null {
  const match = text.match(/referencia\s*1\s*:\s*([^\n]+)/i)
  if (match === null) return null

  const value = match[1].trim()
  // Sin al menos un dígito no es un número de contrato.
  return value.length > 0 && /\d/.test(value) ? value : null
}

export function findReference(text: string): string | null {
  const match = text.match(
    /(?:comprobante|referencia|transacci[oó]n|cus|autorizaci[oó]n)\s*(?:n[°ºo]\.?|#|:)?\s*([A-Za-z0-9][A-Za-z0-9-]{4,})/i
  )
  if (match === null) return null

  // El flag `i` hace que [A-Z0-9] matchee minúsculas, así que cualquier palabra
  // suelta pasaba como referencia ("Enviaste" salió como tal en datos reales).
  // Una referencia real siempre lleva al menos un dígito.
  return /\d/.test(match[1]) ? match[1] : null
}

// ---------------------------------------------------------------------------
// Comprobante de pago
// ---------------------------------------------------------------------------

/**
 * Devuelve null si el texto no parece un comprobante.
 *
 * El monto es obligatorio y no alcanza solo: hace falta al menos otro campo.
 * Sin esa regla, cualquier nota que mencione "$50.000" se clasificaría como pago.
 */
export function findReceipt(text: string): ReceiptMatch | null {
  const fields: ReceiptFields = {
    entity: findEntity(text),
    merchant: findMerchant(text),
    accountRef: findAccountRef(text),
    amount: findAmount(text),
    date: findDate(text),
    reference: findReference(text)
  }

  if (fields.amount === null) return null

  // La confianza se calcula sobre los cuatro campos ORIGINALES. `merchant` y
  // `accountRef` sirven para clasificar, no para decidir si esto es un
  // comprobante — meterlos acá bajaría la confianza de los recibos que ya
  // reconocíamos bien solo porque no traen línea "Comercio:".
  const core = [fields.entity, fields.amount, fields.date, fields.reference]
  const matched = core.filter((v) => v !== null).length
  if (matched < 2) return null

  return { ...fields, confidence: matched / 4 }
}

// ---------------------------------------------------------------------------
// Perfiles y URLs
// ---------------------------------------------------------------------------

export function findLinkedInProfiles(text: string): string[] {
  const pattern = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([A-Za-z0-9\-_%]+)/gi
  const slugs = new Set<string>()

  for (const match of text.matchAll(pattern)) {
    slugs.add(`https://www.linkedin.com/in/${match[1]}`)
  }

  return [...slugs]
}

export function findUrls(text: string): string[] {
  const pattern = /https?:\/\/[^\s<>"')]+/gi
  return [...new Set(text.match(pattern) ?? [])]
}
