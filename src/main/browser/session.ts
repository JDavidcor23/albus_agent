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
