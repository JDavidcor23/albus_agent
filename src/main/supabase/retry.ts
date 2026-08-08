/**
 * Reintento del único fallo transitorio conocido de Supabase en este proyecto.
 *
 * ## Qué se investigó antes de escribir esto
 *
 * El síntoma era `JWT issued at future` cortando un lote entero. Lo medido:
 *
 * - El reloj de la máquina está bien: 0 s de desfase contra el servidor de
 *   Supabase y +0.005 s contra el NTP. **No es el reloj local**, y no podría
 *   serlo: interceptando el fetch se ve que supabase-js manda `apikey`,
 *   `authorization` y `x-client-info`, y NINGÚN dato de tiempo. El cliente no
 *   tiene forma de hacer que el servidor hable de un `iat`.
 * - La cadena `issued at future` no está en `node_modules`: viene del servidor.
 * - 400 requests con `fetch` crudo y 42 por el cliente adentro de Electron:
 *   cero fallas. Es transitorio, no determinista.
 *
 * ## La cadena causal
 *
 * La clave del proyecto es `sb_secret_…`, del formato nuevo, que **no es un
 * JWT**. PostgREST solo entiende JWT. Así que el borde de Supabase resuelve la
 * clave y acuña un JWT de vida corta con `iat` = su reloj, y PostgREST lo
 * valida contra el suyo. Cuando esos dos nodos están corridos unos segundos,
 * PostgREST ve un `iat` adelantado y rechaza. Es desfase interno de ellos.
 *
 * ## Por qué un reintento y no un arreglo
 *
 * Porque la causa está del otro lado de una frontera que no controlamos. La
 * regla del proyecto es que un fallo transitorio no puede costar el lote: un
 * solo hipo de infraestructura dejaba a 48 extracciones sin procesar y al
 * usuario con un cartel rojo.
 *
 * El reintento es **angosto a propósito**. Una key revocada, un token vencido o
 * un 500 salen enseguida y sin disfraz: reintentar esos sería esconder un
 * problema real detrás de tres segundos de espera.
 */

/**
 * Los únicos mensajes que se reintentan. Angosto por diseño.
 *
 * `JWT expired` NO está: un token vencido es un problema de configuración que
 * hay que ver, no un hipo. `Invalid API key` tampoco, por lo mismo.
 */
export const IS_TRANSIENT = /issued at future|JWTIssuedAtFuture/i

/** Uno más sería esperar 3.5 s por algo que se resuelve en el primer reintento. */
const MAX_RETRIES = 2

/** Esperas entre intentos. El desfase que vimos se corrige en menos de un segundo. */
const WAITS_MS = [250, 750]

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Envuelve un `fetch` y reintenta solo el transitorio de arriba.
 *
 * `waitFactor` existe para los chequeos: en 0 corren sin dormir. En producción
 * queda en 1 y nadie lo pasa.
 */
export function createFetchWithRetry(fetchBase: typeof fetch, waitFactor = 1): typeof fetch {
  return async function fetchWithRetry(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    let last: Response | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetchBase(input, init)

      // El camino feliz no paga nada: ni se mira el cuerpo.
      if (res.status !== 401 && res.status !== 400) return res

      // `clone()` y no `text()` directo: el cuerpo se lee una sola vez y el que
      // llamó lo necesita entero. Sin el clone, supabase-js recibe un stream
      // ya consumido y el error se vuelve "body used already".
      let body = ''
      try {
        body = await res.clone().text()
      } catch {
        return res
      }

      if (!IS_TRANSIENT.test(body)) return res

      last = res

      if (attempt < MAX_RETRIES) {
        const wait = WAITS_MS[attempt] * waitFactor
        console.warn(
          `[supabase] transitorio del servidor ("JWT issued at future"), ` +
            `reintento ${attempt + 1}/${MAX_RETRIES} en ${wait} ms`
        )
        if (wait > 0) await sleep(wait)
      }
    }

    // Se agotaron los reintentos: devolvemos el error real, no uno inventado.
    console.error(
      '[supabase] el transitorio no se resolvió en 3 intentos. ' +
        'Si se repite, es desfase de reloj entre los nodos de Supabase: reportarlo con la hora exacta.'
    )
    return last as Response
  } as typeof fetch
}
