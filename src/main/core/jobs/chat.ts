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
export interface JobOnScreen {
  id: string
  company: string
  title: string
  score: number
}

export type JobIntent =
  /** Buscar vacantes nuevas. `queries` vacío = usar lo que digan las reglas. */
  | { kind: 'search'; queries: string[]; location: string | null }
  /** Postularse a una concreta: ya se resolvió a cuál se refiere. */
  | { kind: 'apply'; id: string }
  /**
   * "postulame a todas las que pasaron".
   *
   * Es un comando aparte y no un `apply` repetido, porque postularse en serie
   * NO es postularse trece veces: cada `apply` en modo `review` deja el
   * navegador abierto y al frente para que el usuario revise antes de enviar
   * (`apply-runner.ts` → `browser.reveal()`), así que trece serían trece
   * ventanas peleándose el foco. Lo que sí se puede hacer en lote es lo lento:
   * armar los CV y las cartas a medida.
   */
  | { kind: 'apply-all' }
  /** Mostrar la evidencia de lo último que se hizo con esa vacante. */
  | { kind: 'show'; id: string }
  /** Mandar de verdad lo que quedó frenado en `review`. */
  | { kind: 'send'; id: string }
  | { kind: 'discard'; id: string }
  /** Dijo algo que apunta a varias vacantes, o a ninguna. */
  | { kind: 'ambiguous'; candidates: JobOnScreen[]; term: string }
  /** No es un comando: es conversación. Va al modelo con el contexto. */
  | { kind: 'chat'; text: string }
  | { kind: 'help' }

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

const WANTS_SEARCH =
  /\b(busca|buscame|buscar|barrido|barre|rastrea|rastrear|vacantes?|trabajos?|ofertas?)\b/

/*
 * `postul\w*` y no la lista de formas.
 *
 * Estaba enumerado —`postula|postulate|postularme`— y "postulame" no estaba:
 * `\bpostula\b` no matchea "postulame" porque después viene otra letra. El
 * usuario escribió "postulame tu a todas las que pasaron" y el router lo mandó
 * a `chat`, que contestó "eso todavía no lo sé contestar". No hay palabra en
 * castellano que empiece con "postul" y quiera decir otra cosa.
 *
 * `aplic\w*` NO: "aplicación" es lo que uno dice para pedir la evidencia
 * ("mostrame la aplicación"), y ahí sí hay ambigüedad real.
 */
const WANTS_APPLY = /\b(postul\w*|aplica|aplicar|aplicame|manda el cv)\b/

/** "a todas", "todas las que pasaron". Convierte el comando en masivo. */
const WANTS_ALL = /\b(todas|todos)\b/

const WANTS_SHOW =
  /\b(mostra|mostrame|muestra|muestrame|ver|veamos|pasame|dame|abri|abrime|captura|evidencia|como quedo|como se hizo)\b/

const WANTS_SEND = /\b(envia|enviar|enviala|manda|mandala|mandalo|confirma|dale enviar)\b/

const WANTS_DISCARD = /\b(descarta|descartar|descartala|no me interesa|olvidala|esa no|sacala)\b/

const WANTS_HELP = /\b(ayuda|que podes hacer|que sabes hacer|como funciona|help)\b/

/**
 * "Colombia", "remoto", "en LATAM" — lo que suena a lugar dentro del pedido.
 *
 * Se extrae con una preposición delante a propósito: sin el "en", cualquier
 * palabra capitalizada del texto se convertiría en ubicación y una búsqueda de
 * "React" terminaría filtrando por un país que no existe.
 */
function locationOf(text: string): string | null {
  const m = /\b(?:en|para|desde)\s+([a-záéíóúñ][\wáéíóúñ\s]{2,24})$/i.exec(text.trim())
  return m === null ? null : m[1].trim()
}

/**
 * Qué roles pidió buscar. Vacío = lo que digan las reglas.
 *
 * Devolver vacío NO es un fallo: las reglas del agente ya dicen qué roles
 * busca. Inventar un default acá sería pisar lo que el usuario escribió en su
 * `.md`, que es justo lo que ese archivo viene a evitar.
 *
 * ## El verbo NO introduce un rol
 *
 * `busca(?:me)?` estaba en la lista de conectores, y con eso *todo* lo que
 * viniera después del verbo se trataba como un puesto. "buscame trabajo, hacé
 * un barrido" salía como `['hacé un barrido']` y eso viajaba tal cual al CLI
 * de LinkedIn: veintiún resultados que no tenían nada que ver con el perfil,
 * cero calificadas, y un mensaje diciendo que ninguna llegaba al piso de 65.
 * Tres días así.
 *
 * Solo `de`, `como` y `para` presentan un rol. El verbo presenta la ACCIÓN, y
 * "buscame trabajo" a secas no nombra ningún puesto: devolver vacío ahí es la
 * respuesta correcta, porque abajo están las reglas del usuario esperando.
 */
function queriesOf(text: string): string[] {
  // La ubicación se corta ANTES de buscar el rol: `para` presenta las dos
  // cosas, y sin esto "buscame trabajo para Colombia" termina preguntándole a
  // LinkedIn por el puesto "Colombia".
  const withoutPlace = text
    .trim()
    .replace(/\b(?:en|para|desde)\s+[a-záéíóúñ][\wáéíóúñ\s]{2,24}$/i, '')

  const m = /\b(?:de|como|para)\s+(.+)$/i.exec(withoutPlace)
  if (m === null) return []

  const raw = m[1]
    .replace(/\b(trabajo|trabajos|vacante|vacantes|oferta|ofertas|empleo)\b/gi, '')
    .trim()

  return (
    raw
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
export function resolveJob(
  text: string,
  jobs: JobOnScreen[]
): { id: string } | { ambiguous: JobOnScreen[]; term: string } | null {
  if (jobs.length === 0) return null

  const t = normalize(text)

  // "la 2", "#2", "la numero 2"
  const byNumber = /\b(?:la|el|#|numero|nro\.?)\s*(\d{1,2})\b/.exec(t) ?? /\b(\d{1,2})\b/.exec(t)
  if (byNumber !== null) {
    const i = Number(byNumber[1]) - 1
    if (i >= 0 && i < jobs.length) return { id: jobs[i].id }
  }

  if (/\b(primera|primero|1ra|1ro)\b/.test(t)) return { id: jobs[0].id }
  if (/\b(ultima|ultimo)\b/.test(t)) return { id: jobs[jobs.length - 1].id }
  if (/\b(segunda|segundo)\b/.test(t) && jobs.length > 1) return { id: jobs[1].id }
  if (/\b(tercera|tercero)\b/.test(t) && jobs.length > 2) return { id: jobs[2].id }

  // Por nombre de empresa o de puesto. Se compara contra el texto entero.
  const byName = jobs.filter((v) => {
    const company = normalize(v.company)
    const title = normalize(v.title)
    return (
      (company.length > 2 && t.includes(company)) ||
      company.split(/\s+/).some((p) => p.length > 3 && t.includes(p)) ||
      (title.length > 3 && t.includes(title))
    )
  })

  if (byName.length === 1) return { id: byName[0].id }
  if (byName.length > 1) return { ambiguous: byName, term: text.trim() }

  // "esa", "esta", "la que dijiste": con UNA sola en pantalla no hay duda.
  if (/\b(esa|esta|ese|este|la que|esa misma)\b/.test(t) && jobs.length === 1) {
    return { id: jobs[0].id }
  }

  return null
}

/**
 * El pedido, resuelto.
 *
 * `jobs` es lo que el usuario está VIENDO. Se pasa por parámetro y no se
 * lee de ningún lado: "la primera" significa la primera de la pantalla, y la
 * pantalla la conoce el llamador.
 */
export function interpret(text: string, jobs: JobOnScreen[]): JobIntent {
  const t = normalize(text)
  if (t === '') return { kind: 'help' }
  if (WANTS_HELP.test(t)) return { kind: 'help' }

  const withJob = (kind: 'apply' | 'show' | 'send' | 'discard'): JobIntent => {
    const r = resolveJob(text, jobs)
    if (r === null) {
      // Con UNA sola en pantalla, "postulate" sin más no es ambiguo.
      if (jobs.length === 1) return { kind, id: jobs[0].id }
      return { kind: 'ambiguous', candidates: jobs, term: text.trim() }
    }
    if ('ambiguous' in r) return { kind: 'ambiguous', candidates: r.ambiguous, term: r.term }
    return { kind, id: r.id }
  }

  // El orden importa: "mandá el CV a la 1" es postular, no enviar un correo
  // suelto. Lo más específico primero.
  // "a todas" no apunta a UNA vacante, así que no pasa por `resolveJob`: sin
  // esto caía en `ambiguous` y contestaba "¿a cuál?" a alguien que ya dijo
  // que a todas.
  if (WANTS_APPLY.test(t)) {
    return WANTS_ALL.test(t) ? { kind: 'apply-all' } : withJob('apply')
  }
  if (WANTS_DISCARD.test(t)) return withJob('discard')
  if (WANTS_SEND.test(t)) return withJob('send')
  if (WANTS_SHOW.test(t)) return withJob('show')

  if (WANTS_SEARCH.test(t)) {
    return { kind: 'search', queries: queriesOf(text), location: locationOf(text) }
  }

  /*
   * Lo que no es un comando NO es un error: es conversación.
   *
   * "¿por qué descartaste esa?" no lo puede contestar una regla, y responder
   * "no entendí" a algo perfectamente razonable es la forma más rápida de que
   * el usuario deje de escribirle al agente.
   */
  return { kind: 'chat', text: text.trim() }
}
