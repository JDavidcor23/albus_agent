import { createBrowserPage } from '../browser/page'
import { clearUdemySession, hasUdemySession, openUdemyLoginWindow } from '../browser/session'
import { runUdemy, type UdemyStepEvent } from '../udemy/run'
import { WHO_AM_I } from '../udemy/page-scripts'
import { courseDir } from '../udemy/store'

/**
 * El módulo de Udemy contra el curso de verdad.
 *
 *   npm run udemy:login
 *   npm run udemy -- "https://www.udemy.com/course/xxx/learn/lecture/123"
 *   npm run udemy -- "https://www.udemy.com/course/xxx/learn/" 3
 *
 * ## Por qué esto existe además de `udemy:check`
 *
 * `check-udemy.ts` prueba el dominio y corre en un segundo, pero NO puede
 * probar lo único que de verdad puede estar mal: los selectores. El DOM de
 * Udemy es de Udemy, y la única forma de saber si `[data-purpose=
 * "transcript-cue"]` sigue existiendo es abrirlo y mirar.
 *
 * Mismo reparto que `check-video.ts`: los asserts para lo que se puede probar
 * sin el mundo afuera, y una corrida real para el cableado.
 *
 * ## Empezá con el tope puesto
 *
 * El segundo argumento limita cuántas lecciones baja. Correrlo primero con `1`
 * cuesta veinte segundos y dice si los selectores andan; descubrir que no
 * andan en la lección 50 cuesta la tarde.
 */
export interface UdemyCommandOptions {
  limit: number
  everySeconds: number
  sections: number[]
}

export async function runUdemyCommand(
  courseUrl: string,
  { limit, everySeconds, sections }: UdemyCommandOptions
): Promise<boolean> {
  if (!(await hasUdemySession())) {
    console.error('\n[udemy] no hay sesión. Corré `npm run udemy:login` primero.\n')
    return false
  }

  console.log(`\n══ UDEMY — ${courseUrl} ══`)
  console.log(sections.length > 0 ? `secciones: ${sections.join(', ')}` : 'secciones: todas')
  console.log(limit > 0 ? `tope: ${limit} lecciones` : 'sin tope: todas las pendientes')
  console.log(`muestreo: cada ${everySeconds}s (se guarda solo lo que cambió)\n`)

  // Visible a propósito: el video tiene que renderizar para poder capturarlo, y
  // además el usuario ve qué está pasando en vez de mirar una barra de progreso.
  const browser = createBrowserPage({ visible: true })

  const seen = new Set<string>()
  const onStep = (s: UdemyStepEvent): void => {
    const line = `[${s.stage}] ${s.label}${s.total > 0 ? `  (${s.done + 1}/${s.total})` : ''}`
    if (seen.has(line)) return
    seen.add(line)
    console.log(`  ${line}`)
  }

  try {
    const summary = await runUdemy({ browser, courseUrl, limit, everySeconds, sections, onStep })

    console.log(`\n── resultado\n`)
    console.log(`  curso:      ${summary.courseTitle}`)
    console.log(`  carpeta:    ${courseDir(summary.courseSlug)}`)
    console.log(`  lecciones:  ${summary.lectures}`)
    console.log(`  capturas:   ${summary.shots}`)

    if (summary.failed.length > 0) {
      console.log(`\n  ${summary.failed.length} fallaron (la corrida siguió igual):`)
      for (const f of summary.failed) console.log(`    - ${f.lecture}: ${f.why}`)
    }

    console.log()
    return summary.lectures > 0
  } catch (error: unknown) {
    console.error(`\n[udemy] la corrida falló: ${String(error)}\n`)
    return false
  } finally {
    await browser.close()
  }
}

/**
 * ¿Udemy me trata como una persona logueada, y como CUÁL?
 *
 * `hasUdemySession()` solo mira si existe una cookie. Una cookie vencida sigue
 * en el frasco y la sonda no nota la diferencia — así que "hay sesión" puede
 * ser mentira, y la forma de enterarse sería cincuenta archivos vacíos.
 *
 * Esto abre la página y pregunta. Cuesta unos segundos y una navegación; por
 * eso no reemplaza a la sonda de cookie en el registro de agentes (esa corre
 * cada vez que se abre la pestaña y no puede pegarle a Udemy en cada pintada),
 * pero sí es lo que hay que correr antes de largar una corrida larga.
 */
export async function udemyWhoAmICommand(): Promise<boolean> {
  const browser = createBrowserPage({ visible: true })

  try {
    await browser.open('https://www.udemy.com/home/my-courses/learning/')
    await new Promise((r) => setTimeout(r, 2500))

    const raw = await browser.runScript(WHO_AM_I)
    const who = JSON.parse(raw) as { ok: boolean; name: string; url: string; loginForm: boolean }

    console.log(`\n── sesión de Udemy\n`)
    console.log(`  cookie presente:  ${(await hasUdemySession()) ? 'sí' : 'no'}`)
    console.log(`  logueado:         ${who.ok ? 'SÍ' : 'NO'}`)
    console.log(`  cuenta:           ${who.name || '(no pude leer el nombre)'}`)
    console.log(`  terminó en:       ${who.url}`)

    if (who.loginForm) {
      console.log('\n  Hay un formulario de login en pantalla: la cookie está vencida.')
      console.log('  Corré `npm run udemy:login -- --no-sandbox` y entrá de nuevo.\n')
      return false
    }

    if (!who.ok) {
      console.log('\n  No encontré el menú de cuenta. Mirá la ventana que quedó abierta:')
      console.log('  si ves tus cursos, la sesión está y lo que cambió son los selectores')
      console.log('  de WHO_AM_I en `udemy/page-scripts.ts`.\n')
      return false
    }

    console.log('\n  Listo para correr.\n')
    return true
  } catch (error: unknown) {
    console.error(`\n[udemy] no pude verificar: ${String(error)}\n`)
    return false
  } finally {
    await browser.close()
  }
}

/**
 * El login, una sola vez. La contraseña la escribe el usuario.
 *
 * `force` is what you run when the session expired. Without it there is no way
 * out: the guard below sees the stale cookie and returns early, so the window
 * never opens — and an expired session is exactly when you need it to.
 */
export async function udemyLoginCommand(force = false): Promise<boolean> {
  if (force) {
    const dropped = await clearUdemySession()
    console.log(`\n[udemy] sesión anterior borrada (${dropped} cookies de udemy.com).`)
    console.log('        LinkedIn y Google no se tocaron.')
  } else if (await hasUdemySession()) {
    console.log('\n[udemy] ya hay una COOKIE de sesión guardada.')
    console.log('        Ojo: eso no prueba que siga viva ni de qué cuenta es.')
    console.log('        Para verificarlo de verdad: npm run udemy:whoami -- --no-sandbox')
    console.log('        Si venció y querés entrar de nuevo: npm run udemy:login -- --force\n')
    return true
  }

  console.log('\n[udemy] abriendo Udemy. Entrá a mano; la ventana se cierra sola.\n')
  const ok = await openUdemyLoginWindow()
  console.log(ok ? '\n[udemy] sesión guardada.\n' : '\n[udemy] no se detectó la sesión.\n')
  return ok
}
