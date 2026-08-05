/**
 * La URL que abre Google Calendar con un evento precargado.
 *
 * Función PURA: recibe texto, devuelve un string. No toca red, ni base, ni
 * Electron. Vive en `shared` porque la usa el renderer para armar el link y el
 * main la valida al recibirlo.
 *
 * ---------------------------------------------------------------------------
 * Por qué una URL y no la API de Calendar
 * ---------------------------------------------------------------------------
 * El proyecto ya tiene OAuth de Google para Drive, así que crear el evento por
 * API parece "más directo". No lo es, por dos razones:
 *
 *   1. Los scopes de Drive no incluyen Calendar. Habría que pedir consentimiento
 *      de nuevo, para escribir en el calendario real del usuario.
 *   2. Y sobre todo: el título de un pendiente lo escribió un MODELO. Escribirlo
 *      en el calendario sin que nadie lo mire significa agendar los errores de la
 *      IA con la misma confianza que los aciertos.
 *
 * Con la URL, Google abre el formulario lleno y el usuario aprieta Guardar. Es un
 * paso más y es el paso que importa: nada entra a su calendario sin que lo vea.
 */

const BASE = 'https://calendar.google.com/calendar/render'

export interface EventoDeCalendario {
  /** Lo que va en el título del evento. */
  title: string
  /** Contexto para el cuerpo. Opcional: muchos pendientes no tienen más que el título. */
  details?: string | null
  /** Dónde. Opcional. */
  location?: string | null
  /** `yyyy-mm-dd`. Si falta, Google abre el formulario en el día de hoy. */
  date?: string | null
}

/**
 * El rango de un evento de DÍA COMPLETO, en el formato de Google: `20260826/20260827`.
 *
 * El fin es EXCLUSIVO — un evento de un día va del 26 al 27. Poner el mismo día
 * en los dos extremos produce un evento de duración cero que Google muestra raro.
 *
 * Día completo y no una hora inventada: "el 27 de agosto" no dice a qué hora, y
 * agendarlo a las 9:00 porque hay que poner algo es meterle al calendario del
 * usuario una precisión que el dato no tiene.
 *
 * La fecha se avanza con UTC a propósito: `new Date(iso)` interpreta
 * "2026-08-26" como medianoche UTC, y sumarle un día con métodos locales cerca
 * de un cambio de horario puede saltar dos días o ninguno.
 */
function rangoDeDiaCompleto(fecha: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha.trim())
  if (m === null) return null

  const inicio = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(inicio)) return null

  const fin = new Date(inicio + 86400000)
  const compacto = (d: Date): string =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`

  return `${m[1]}${m[2]}${m[3]}/${compacto(fin)}`
}

/**
 * Google Calendar con el evento precargado.
 *
 * Si el pendiente tiene fecha, va como evento de día completo. Si no, Google abre
 * el formulario con hoy preseleccionado y el usuario elige — que es mejor que
 * inventarle una, porque una fecha equivocada en un calendario no se nota hasta
 * que te perdés el evento.
 *
 * `URLSearchParams` y no concatenación: un título con `&`, `#` o un acento rompe
 * la URL armada a mano, y los títulos vienen de un modelo — o sea, de cualquier lado.
 */
export function urlDeCalendario(evento: EventoDeCalendario): string {
  const params = new URLSearchParams({ action: 'TEMPLATE', text: evento.title.trim() })

  const detalle = evento.details?.trim()
  if (detalle !== undefined && detalle.length > 0) params.set('details', detalle)

  const lugar = evento.location?.trim()
  if (lugar !== undefined && lugar.length > 0) params.set('location', lugar)

  // Una fecha con forma inesperada se omite en silencio: el botón sigue abriendo
  // el formulario. Un `dates` inválido hace que Google ignore TODO el template.
  const rango = evento.date != null ? rangoDeDiaCompleto(evento.date) : null
  if (rango !== null) params.set('dates', rango)

  return `${BASE}?${params.toString()}`
}
