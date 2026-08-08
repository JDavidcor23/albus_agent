/**
 * Interpreta lo que el usuario le escribe al agente de trabajo.
 *
 * Función PURA: recibe el texto y las vacantes en pantalla, devuelve qué
 * hacer. No toca red, ni disco, ni CLI — por eso se puede verificar entera sin
 * levantar nada.
 *
 * ## Por qué la mayoría NO pasa por un modelo
 *
 * "postulate a la primera" es un COMANDO sobre una entidad que ya está en la
 * pantalla, no una conversación. Resolverlo con IA es pagar cuota y esperar
 * segundos para ejecutar el equivalente a un `SELECT` — y encima introduce la
 * chance de que entienda mal cuál era "la primera".
 *
 * El modelo se guarda para lo que una regla no puede: *"¿por qué descartaste
 * esa?"*, *"¿cuál me conviene más?"*. Todo lo demás cae acá, gratis y en cero
 * milisegundos. Es el mismo criterio que el chat de pendientes.
 */

/** Lo mínimo que el router necesita saber de una vacante para poder elegirla. */
export interface VacanteEnPantalla {
  id: string
  company: string
  title: string
  score: number
}

export type IntentJob =
  /** Buscar vacantes nuevas. `queries` vacío = usar lo que digan las reglas. */
  | { kind: 'buscar'; queries: string[]; ubicacion: string | null }
  /** Postularse a una concreta: ya se resolvió a cuál se refiere. */
  | { kind: 'postular'; id: string }
  /** Mostrar la evidencia de lo último que se hizo con esa vacante. */
  | { kind: 'mostrar'; id: string }
  /** Mandar de verdad lo que quedó frenado en `review`. */
  | { kind: 'enviar'; id: string }
  | { kind: 'descartar'; id: string }
  /** Dijo algo que apunta a varias vacantes, o a ninguna. */
  | { kind: 'ambiguo'; candidatas: VacanteEnPantalla[]; termino: string }
  /** No es un comando: es conversación. Va al modelo con el contexto. */
  | { kind: 'conversar'; texto: string }
  | { kind: 'ayuda' }

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

const PIDE_BUSCAR =
  /\b(busca|buscame|buscar|barrido|barre|rastrea|rastrear|vacantes?|trabajos?|ofertas?)\b/

const PIDE_POSTULAR = /\b(postula|postulate|postularme|aplica|aplicar|aplicame|manda el cv)\b/

const PIDE_MOSTRAR =
  /\b(mostra|mostrame|muestra|muestrame|ver|veamos|pasame|dame|abri|abrime|captura|evidencia|como quedo|como se hizo)\b/

const PIDE_ENVIAR = /\b(envia|enviar|enviala|manda|mandala|mandalo|confirma|dale enviar)\b/

const PIDE_DESCARTAR = /\b(descarta|descartar|descartala|no me interesa|olvidala|esa no|sacala)\b/

const PIDE_AYUDA = /\b(ayuda|que podes hacer|que sabes hacer|como funciona|help)\b/

/**
 * "Colombia", "remoto", "en LATAM" — lo que suena a lugar dentro del pedido.
 *
 * Se extrae con una preposición delante a propósito: sin el "en", cualquier
 * palabra capitalizada del texto se convertiría en ubicación y una búsqueda de
 * "React" terminaría filtrando por un país que no existe.
 */
function ubicacionDe(texto: string): string | null {
  const m = /\b(?:en|para|desde)\s+([a-záéíóúñ][\wáéíóúñ\s]{2,24})$/i.exec(texto.trim())
  return m === null ? null : m[1].trim()
}

/**
 * Qué roles pidió buscar. Vacío = lo que digan las reglas.
 *
 * Devolver vacío NO es un fallo: las reglas del agente ya dicen qué roles
 * busca. Inventar un default acá sería pisar lo que el usuario escribió en su
 * `.md`, que es justo lo que ese archivo viene a evitar.
 */
function queriesDe(texto: string): string[] {
  const m = /\b(?:de|como|para|busca(?:me)?)\s+(.+)$/i.exec(texto.trim())
  if (m === null) return []

  const crudo = m[1]
    .replace(/\b(?:en|para|desde)\s+[a-záéíóúñ][\wáéíóúñ\s]*$/i, '')
    .replace(/\b(trabajo|trabajos|vacante|vacantes|oferta|ofertas|empleo)\b/gi, '')
    .trim()

  return (
    crudo
      .split(/,| y | o /)
      // Sacar "trabajo" de "buscame trabajo DE react" deja la preposición
      // colgada, y el rol termina siendo "de react developer".
      .map((q) => q.replace(/^\s*(?:de|como|para)\s+/i, '').trim())
      .filter((q) => q.length > 2)
  )
}

/**
 * A cuál se refiere: por número, por posición, o por empresa.
 *
 * Devuelve `null` si no nombró ninguna, y la lista de candidatas si nombró algo
 * que matchea con varias. **No adivina.** Postularse a la vacante equivocada no
 * se deshace: se le escribió a un reclutador real con el CV de otro puesto.
 */
export function resolverVacante(
  texto: string,
  vacantes: VacanteEnPantalla[]
): { id: string } | { ambiguas: VacanteEnPantalla[]; termino: string } | null {
  if (vacantes.length === 0) return null

  const t = normalizar(texto)

  // "la 2", "#2", "la numero 2"
  const porNumero = /\b(?:la|el|#|numero|nro\.?)\s*(\d{1,2})\b/.exec(t) ?? /\b(\d{1,2})\b/.exec(t)
  if (porNumero !== null) {
    const i = Number(porNumero[1]) - 1
    if (i >= 0 && i < vacantes.length) return { id: vacantes[i].id }
  }

  if (/\b(primera|primero|1ra|1ro)\b/.test(t)) return { id: vacantes[0].id }
  if (/\b(ultima|ultimo)\b/.test(t)) return { id: vacantes[vacantes.length - 1].id }
  if (/\b(segunda|segundo)\b/.test(t) && vacantes.length > 1) return { id: vacantes[1].id }
  if (/\b(tercera|tercero)\b/.test(t) && vacantes.length > 2) return { id: vacantes[2].id }

  // Por nombre de empresa o de puesto. Se compara contra el texto entero.
  const porNombre = vacantes.filter((v) => {
    const empresa = normalizar(v.company)
    const puesto = normalizar(v.title)
    return (
      (empresa.length > 2 && t.includes(empresa)) ||
      empresa.split(/\s+/).some((p) => p.length > 3 && t.includes(p)) ||
      (puesto.length > 3 && t.includes(puesto))
    )
  })

  if (porNombre.length === 1) return { id: porNombre[0].id }
  if (porNombre.length > 1) return { ambiguas: porNombre, termino: texto.trim() }

  // "esa", "esta", "la que dijiste": con UNA sola en pantalla no hay duda.
  if (/\b(esa|esta|ese|este|la que|esa misma)\b/.test(t) && vacantes.length === 1) {
    return { id: vacantes[0].id }
  }

  return null
}

/**
 * El pedido, resuelto.
 *
 * `vacantes` es lo que el usuario está VIENDO. Se pasa por parámetro y no se
 * lee de ningún lado: "la primera" significa la primera de la pantalla, y la
 * pantalla la conoce el llamador.
 */
export function interpretar(texto: string, vacantes: VacanteEnPantalla[]): IntentJob {
  const t = normalizar(texto)
  if (t === '') return { kind: 'ayuda' }
  if (PIDE_AYUDA.test(t)) return { kind: 'ayuda' }

  const conVacante = (kind: 'postular' | 'mostrar' | 'enviar' | 'descartar'): IntentJob => {
    const r = resolverVacante(texto, vacantes)
    if (r === null) {
      // Con UNA sola en pantalla, "postulate" sin más no es ambiguo.
      if (vacantes.length === 1) return { kind, id: vacantes[0].id }
      return { kind: 'ambiguo', candidatas: vacantes, termino: texto.trim() }
    }
    if ('ambiguas' in r) return { kind: 'ambiguo', candidatas: r.ambiguas, termino: r.termino }
    return { kind, id: r.id }
  }

  // El orden importa: "mandá el CV a la 1" es postular, no enviar un correo
  // suelto. Lo más específico primero.
  if (PIDE_POSTULAR.test(t)) return conVacante('postular')
  if (PIDE_DESCARTAR.test(t)) return conVacante('descartar')
  if (PIDE_ENVIAR.test(t)) return conVacante('enviar')
  if (PIDE_MOSTRAR.test(t)) return conVacante('mostrar')

  if (PIDE_BUSCAR.test(t)) {
    return { kind: 'buscar', queries: queriesDe(texto), ubicacion: ubicacionDe(texto) }
  }

  /*
   * Lo que no es un comando NO es un error: es conversación.
   *
   * "¿por qué descartaste esa?" no lo puede contestar una regla, y responder
   * "no entendí" a algo perfectamente razonable es la forma más rápida de que
   * el usuario deje de escribirle al agente.
   */
  return { kind: 'conversar', texto: texto.trim() }
}
