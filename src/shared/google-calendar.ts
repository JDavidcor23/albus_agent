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
}

/**
 * Google Calendar con el evento precargado y sin fecha.
 *
 * Sin fecha a propósito: los pendientes de Albus no la tienen todavía. Google
 * abre el formulario con el día de hoy preseleccionado y el usuario lo cambia —
 * que es mejor que mandarle una fecha inventada, porque una fecha equivocada en un
 * calendario no se nota hasta que te perdés el evento.
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

  return `${BASE}?${params.toString()}`
}
