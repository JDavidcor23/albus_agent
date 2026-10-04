import { BrowserWindow, session } from 'electron'

/**
 * La partición es lo que hace que todo esto funcione sin pedirle al usuario
 * que relance su Chrome con un flag de depuración.
 *
 * `persist:` le dice a Electron que las cookies van al disco, dentro del
 * perfil de la app. El usuario loguea LinkedIn UNA vez dentro de Albus y la
 * sesión sobrevive a cerrar la aplicación, igual que en un navegador normal.
 */
export const PARTITION = 'persist:albus-jobs'

/** El HTML carga rápido; el modal de Easy Apply lo pinta React después. */
export const SETTLE_MS = 2500

/** Después de un click hay transición y validación antes del próximo paso. */
export const CLICK_TIMEOUT_MS = 1800

/**
 * Techo para una navegación entera, no para un click.
 *
 * "Apply" en una vacante externa sale de LinkedIn al ATS de la empresa —
 * Greenhouse, Lever, Workday— que carga bastante más lento que un modal. Es un
 * techo, no una espera: si la página termina antes, se sigue enseguida.
 */
export const NAVIGATION_TIMEOUT_MS = 20_000

export const LINKEDIN_COOKIE = { domain: '.linkedin.com', name: 'li_at' }

/**
 * La cookie de sesión de Google EN EL NAVEGADOR de Albus.
 *
 * Ojo: no tiene nada que ver con el OAuth de Gmail/Drive. Aquello es un
 * refresh token para hablarle a la API. Esto es estar logueado en el navegador,
 * que es lo que hace que un "Continue with Google" de otro sitio se resuelva
 * sin escribir nada.
 *
 * Es la pieza que convierte "conectar Notion" en un click: sin sesión de Google
 * en el navegador, Notion pide un código por mail y ahí hay que meter la mano.
 */
export const GOOGLE_COOKIE = { domain: '.google.com', name: 'SID' }

export async function hasGoogleBrowserSession(): Promise<boolean> {
  const cookies = await jobsSession().cookies.get(GOOGLE_COOKIE)
  return cookies.length > 0
}

/**
 * Abre Google para que entre una vez. Igual que el de LinkedIn: no se
 * automatiza el login, se espera a que aparezca la cookie.
 */
export function openGoogleLoginWindow(timeoutMs = 5 * 60_000): Promise<boolean> {
  return waitForSession(
    'https://accounts.google.com/ServiceLogin?continue=https://www.google.com',
    'Albus — entrá a Google (una sola vez)',
    hasGoogleBrowserSession,
    timeoutMs
  )
}

export function jobsSession(): Electron.Session {
  return session.fromPartition(PARTITION)
}

export async function hasLinkedInSession(): Promise<boolean> {
  const cookies = await jobsSession().cookies.get(LINKEDIN_COOKIE)
  return cookies.length > 0
}

/**
 * Udemy no tiene UNA cookie canónica como el `li_at` de LinkedIn: según el
 * flujo de login quedan `access_token`, `dj_session_id` o las dos. Se prueban
 * en orden y alcanza con que aparezca alguna.
 *
 * Elegir una sola y errarle sería lo peor de los dos mundos: el agente se
 * pinta apagado con la sesión puesta, y el usuario vuelve a loguear para nada.
 */
const UDEMY_COOKIES = ['access_token', 'dj_session_id'] as const

export async function hasUdemySession(): Promise<boolean> {
  for (const name of UDEMY_COOKIES) {
    const cookies = await jobsSession().cookies.get({ domain: '.udemy.com', name })
    if (cookies.length > 0) return true
  }
  return false
}

/**
 * Drops every Udemy cookie from the partition. Returns how many it dropped.
 *
 * Logging in again is impossible while the stale cookie is still there, and
 * that is not a corner case — it is what an expired session always looks like.
 * `hasUdemySession` only proves the cookie EXISTS, so the login command
 * short-circuits on it, and `waitForSession` polls the very same probe: even
 * forcing the window open, the poll would see the stale cookie 1.5s later and
 * close the window before the user finished typing their address.
 *
 * So re-login means: throw the old session away FIRST, then open the window.
 *
 * Scoped to udemy.com on purpose. This partition also holds LinkedIn and
 * Google — Notion's "Continue with Google" leans on the latter — and clearing
 * the whole jar to fix Udemy would silently log the user out of the rest.
 */
export async function clearUdemySession(): Promise<number> {
  const jar = jobsSession().cookies
  const cookies = await jar.get({ domain: 'udemy.com' })

  for (const cookie of cookies) {
    // `cookies.remove` takes a URL, not a domain: a leading dot is not a host,
    // and the path matters — two cookies can share a name under different paths.
    const host = cookie.domain?.replace(/^\./, '') ?? 'www.udemy.com'
    const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`
    await jar.remove(url, cookie.name)
  }

  return cookies.length
}

/** Igual que LinkedIn y por la misma razón: la contraseña la escribe él. */
export function openUdemyLoginWindow(timeoutMs = 5 * 60_000): Promise<boolean> {
  return waitForSession(
    'https://www.udemy.com/join/login-popup/',
    'Albus — iniciá sesión en Udemy (una sola vez)',
    hasUdemySession,
    timeoutMs
  )
}

/**
 * Abre LinkedIn a la vista para que el usuario loguee a mano. Resuelve cuando
 * aparece la cookie de sesión o cuando cierra la ventana.
 *
 * Esto pasa UNA vez. No automatizamos el login: meterle usuario y contraseña
 * por script a LinkedIn es exactamente el patrón que su antifraude marca, y
 * además implicaría que Albus guarde la contraseña. Que la escriba él.
 */
export function openLoginWindow(timeoutMs = 5 * 60_000): Promise<boolean> {
  return waitForSession(
    'https://www.linkedin.com/login',
    'Albus — iniciá sesión en LinkedIn (una sola vez)',
    hasLinkedInSession,
    timeoutMs
  )
}

/**
 * Abre una URL, espera a que aparezca la cookie de sesión y cierra sola.
 *
 * El patrón es el mismo para todos los sitios y por la misma razón: el login
 * lo hace el usuario. Automatizarlo implicaría que Albus guarde su contraseña
 * — y en la mitad de los sitios ni siquiera hay contraseña, hay un código que
 * llega al mail, que para completarlo habría que leerle la casilla.
 */
function waitForSession(
  url: string,
  title: string,
  hasCookie: () => Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    autoHideMenuBar: true,
    title,
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  void win.loadURL(url)

  return new Promise((resolve) => {
    let done = false

    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearInterval(poll)
      clearTimeout(limit)
      if (!win.isDestroyed()) win.destroy()
      resolve(ok)
    }

    const poll = setInterval(() => {
      void hasCookie().then((has) => {
        if (has) finish(true)
      })
    }, 1500)

    const limit = setTimeout(() => finish(false), timeoutMs)

    win.on('closed', () => {
      void hasCookie().then((has) => finish(has))
    })
  })
}
