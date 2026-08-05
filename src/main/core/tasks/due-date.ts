/**
 * Fechas escritas en español (y algo de inglés) sacadas de texto libre.
 *
 * Dominio puro: no importa electron, ni supabase, ni ningún CLI, ni lee el reloj.
 * Escalón 3 — reglas, gratis, instantáneo.
 *
 * ---------------------------------------------------------------------------
 * Por qué esto no lo hace el modelo
 * ---------------------------------------------------------------------------
 * Lo hace TAMBIÉN el modelo, para las tareas que él detecta. Pero las reglas
 * (`rules.ts`) corren sin modelo a propósito: son gratis y no dependen de que el
 * CLI esté vivo. Si la fecha del QR de un evento dependiera del escalón 4, un CLI
 * caído dejaría la entrada del 27 de agosto ordenada junto a "hacer cursos de IA".
 *
 * Y era justo el caso peor: la nota decía "evento de cripto de 27 y 28 de agosto"
 * y el pendiente quedaba último en una lista de 20.
 */

const MESES: Record<string, number> = {
  enero: 1, ene: 1, january: 1, jan: 1,
  febrero: 2, feb: 2, february: 2,
  marzo: 3, mar: 3, march: 3,
  abril: 4, abr: 4, april: 4, apr: 4,
  mayo: 5, may: 5,
  junio: 6, jun: 6, june: 6,
  julio: 7, jul: 7, july: 7,
  agosto: 8, ago: 8, august: 8, aug: 8,
  septiembre: 9, setiembre: 9, sep: 9, sept: 9, september: 9,
  octubre: 10, oct: 10, october: 10,
  noviembre: 11, nov: 11, november: 11,
  diciembre: 12, dic: 12, december: 12, dec: 12
}

const NOMBRES_MES = Object.keys(MESES).sort((a, b) => b.length - a.length).join('|')

/** `27 de agosto`, `27 y 28 de agosto de 2026`, `26 Agosto` */
const RE_DIA_MES = new RegExp(
  `\\b(\\d{1,2})\\s*(?:(?:y|a|-|al|hasta)\\s*\\d{1,2}\\s*)?(?:de\\s+)?(${NOMBRES_MES})\\b(?:\\s+(?:de\\s+)?(\\d{4}))?`,
  'gi'
)

/** `August 26th`, `Aug 26` */
const RE_MES_DIA = new RegExp(`\\b(${NOMBRES_MES})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4}))?`, 'gi')

/** `27/08/2026`, `27/8`. Día primero: es el orden que se usa en Colombia. */
const RE_BARRAS = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g

const RE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g

function esFechaValida(a: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const f = new Date(Date.UTC(a, m - 1, d))
  return f.getUTCFullYear() === a && f.getUTCMonth() === m - 1 && f.getUTCDate() === d
}

function iso(a: number, m: number, d: number): string {
  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * El año cuando el texto no lo dice.
 *
 * Se elige el que deja la fecha en el FUTURO respecto de `hoy`. "27 de agosto"
 * escrito el 5 de agosto es de este año; escrito el 30 de septiembre, del que
 * viene. Asumir siempre el año actual convertiría media lista en tareas vencidas
 * el 1 de enero.
 */
function añoImplicito(hoy: string, m: number, d: number): number {
  const actual = Number(hoy.slice(0, 4))
  return iso(actual, m, d) >= hoy ? actual : actual + 1
}

/**
 * La fecha más TEMPRANA que no haya pasado, o `null`.
 *
 * La más temprana y no la última: de "26 Agosto: Business Day / 27 y 28 de Agosto:
 * Evento general" la que importa es el 26 — es cuando hay que tener la entrada a
 * mano. Una tarea se ordena por cuándo hay que ACTUAR, no por cuándo termina.
 *
 * Nunca lanza. Sin fecha reconocible devuelve null, y la tarea cae al grupo "sin
 * fecha" en vez de inventarle una urgencia.
 */
export function fechaLimiteDe(texto: string, hoy: string): string | null {
  const candidatas: string[] = []

  const agregar = (a: number, m: number, d: number): void => {
    if (esFechaValida(a, m, d)) candidatas.push(iso(a, m, d))
  }

  for (const m of texto.matchAll(RE_ISO)) {
    agregar(Number(m[1]), Number(m[2]), Number(m[3]))
  }

  for (const m of texto.matchAll(RE_DIA_MES)) {
    const dia = Number(m[1])
    const mes = MESES[m[2].toLowerCase()]
    const año = m[3] !== undefined ? Number(m[3]) : añoImplicito(hoy, mes, dia)
    agregar(año, mes, dia)
  }

  for (const m of texto.matchAll(RE_MES_DIA)) {
    const mes = MESES[m[1].toLowerCase()]
    const dia = Number(m[2])
    const año = m[3] !== undefined ? Number(m[3]) : añoImplicito(hoy, mes, dia)
    agregar(año, mes, dia)
  }

  for (const m of texto.matchAll(RE_BARRAS)) {
    const dia = Number(m[1])
    const mes = Number(m[2])

    // Sin año, un d/m solo se acepta si el día NO puede ser un mes.
    //
    // Sobre los datos reales, el OCR de una foto produjo la línea
    // "/ No 1/4 ARE HERAT RE AENA NR NL Nags mr", y ese "1/4" — que es una
    // fracción, o ruido — se leyó como 1 de abril. Como abril ya había pasado,
    // se resolvió a 2027 y mandó la tarea al tope de la lista.
    //
    // "27/8" es inequívoco: no existe el mes 27. "1/4" no lo es en absoluto.
    // Perder un "5/8" legítimo es barato; una fecha inventada corrompe el orden
    // de toda la lista, que es justo lo que este campo vino a arreglar.
    if (m[3] === undefined) {
      if (dia <= 12) continue
      agregar(añoImplicito(hoy, mes, dia), mes, dia)
      continue
    }

    agregar(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), mes, dia)
  }

  const futuras = [...new Set(candidatas)].filter((f) => f >= hoy).sort()
  return futuras[0] ?? null
}

/** Una fecha ISO válida, o null. Para no confiar en lo que devuelve un modelo. */
export function normalizarFechaIso(valor: unknown): string | null {
  if (typeof valor !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor.trim())
  if (m === null) return null
  const [, a, mes, d] = m
  return esFechaValida(Number(a), Number(mes), Number(d)) ? iso(Number(a), Number(mes), Number(d)) : null
}
