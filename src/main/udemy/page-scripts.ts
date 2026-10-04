/**
 * JavaScript que corre DENTRO de la página de Udemy.
 *
 * Mismas reglas que `browser/page-scripts.ts`: son strings constantes, y los
 * únicos valores que entran lo hacen por `JSON.stringify`. Nada de acá se arma
 * con datos de un modelo — esto corre con la sesión del usuario puesta.
 *
 * ## Por qué NINGÚN selector está solo
 *
 * Udemy redisena y renombra clases sin avisar. Un `querySelector('#algo')` es
 * una apuesta a que no lo hagan, y esa apuesta ya se perdió dos veces en este
 * repo — está escrito en el README: *"automatizar el sitio de otro con
 * `click('#submit-btn')` es una bet que perdimos dos veces, y la escribimos"*.
 *
 * Así que acá hay LISTAS de candidatos y gana el primero que traiga contenido
 * de verdad. Y cuando ninguno anda, el script **no devuelve vacío en
 * silencio**: devuelve `ok: false` con un `debug` de lo que sí había en la
 * página. Un cero que puede significar "no hay nada" o "cambió el DOM" es el
 * peor resultado posible, porque se descubre cincuenta lecciones después.
 */

/**
 * El índice del curso: qué lecciones hay y cuáles tienen el tilde de vista.
 *
 * Devuelve el texto crudo de cada fila. Partirlo en número y título es trabajo
 * de `core/udemy/curriculum.ts`, que se prueba sin navegador.
 */
export const READ_CURRICULUM = `(() => {
  const ITEM_SELECTORS = [
    '[data-purpose^="curriculum-item-"]',
    'li[class*="curriculum-item-link--curriculum-item"]',
    '[class*="section--section"] li',
    '[data-purpose="curriculum-section-container"] li'
  ]

  /*
   * Las cabeceras de sección no se pueden pedir por CSS —no hay selector "que
   * diga Section 3"— así que se pide un conjunto amplio de candidatos y se
   * filtra por TEXTO. Es la misma regla que el resto del archivo: el texto que
   * el usuario lee es lo estable; las clases generadas, no.
   */
  const HEADER_SELECTORS = [
    '[data-purpose^="section-heading"]',
    '[class*="section--section-title"]',
    'button[aria-expanded]',
    'h3',
    'h2'
  ]

  const SECTION_RE = /^(?:section|secci[oó]n)\\s+(\\d+)/i

  const clean = (el) => (el && el.innerText ? el.innerText.replace(/\\u00a0/g, ' ').trim() : '')
  const firstLine = (el) => (clean(el).split('\\n')[0] || '').trim()

  /*
   * "Ya la vi" tiene tres formas segun el deploy: un checkbox marcado, un
   * boton con aria-checked, o una clase con "completed". Se aceptan las tres:
   * equivocarse para el lado de "no la vi" hace que la leccion NO se baje, y
   * eso es un vacio silencioso.
   */
  const seen = (el) => {
    const box = el.querySelector('input[type="checkbox"]')
    if (box && box.checked) return true
    const toggle = el.querySelector('[aria-checked]')
    if (toggle && toggle.getAttribute('aria-checked') === 'true') return true
    return /completed|progress-toggle-checked/i.test(el.className || '')
  }

  for (const sel of ITEM_SELECTORS) {
    const items = [...document.querySelectorAll(sel)]
    if (items.length < 3) continue

    /*
     * Items y cabeceras JUNTOS, en orden de documento.
     *
     * querySelectorAll con selectores separados por coma devuelve en orden
     * del árbol, no agrupado por selector. Eso es lo que permite decir "esta
     * cabecera manda sobre todas las filas que vienen abajo": es la única
     * forma de saber a qué sección pertenece una lección, porque el texto de
     * la fila no lo dice.
     */
    const itemSet = new Set(items)
    const combined = [...document.querySelectorAll(sel + ',' + HEADER_SELECTORS.join(','))]

    let section = 0
    const sections = {}
    const rows = []

    for (const el of combined) {
      // El item se chequea PRIMERO: un <li> puede tener adentro un
      // button[aria-expanded] y matchear las dos listas.
      if (itemSet.has(el)) {
        const text = clean(el)
        if (text.length > 0) rows.push({ text: text, completed: seen(el), section: section })
        continue
      }

      const m = SECTION_RE.exec(firstLine(el))
      if (m) {
        section = Number(m[1])
        // El contenedor de la sección y su <h3> dan la misma cabecera: el
        // primero que llega gana y el segundo no pisa nada.
        if (!sections[section]) sections[section] = firstLine(el)
      }
    }

    if (rows.length >= 3) {
      return JSON.stringify({ ok: true, selector: sel, rows: rows, sections: sections })
    }
  }

  const debug = [...document.querySelectorAll('[data-purpose]')]
    .map((e) => e.getAttribute('data-purpose'))
    .filter((p) => /curriculum|section|item/i.test(p || ''))
    .slice(0, 25)

  return JSON.stringify({ ok: false, rows: [], debug })
})()`

/**
 * Quién está logueado, de verdad.
 *
 * ## Por qué no alcanza con la cookie
 *
 * `hasUdemySession()` mira si EXISTE una cookie con ese nombre. Eso responde
 * "hay una cookie", no "hay una sesión": una cookie vencida sigue en el frasco
 * y la sonda diría exactamente lo mismo. El agente arrancaría, abriría
 * cincuenta lecciones contra la pantalla de login y escribiría cincuenta
 * archivos vacíos — y el que lo mandó a correr se entera al volver.
 *
 * Así que esto pregunta lo que importa: **¿la página me trata como una persona
 * logueada?** Se mira el menú de cuenta, que solo existe cuando hay sesión, y
 * de paso se saca el nombre para que el usuario confirme que es SU cuenta y no
 * la de otro perfil que quedó pegado en la partición.
 */
export const WHO_AM_I = `(() => {
  const ACCOUNT = [
    '[data-purpose="user-dropdown"]',
    '[data-purpose="header-user-menu"]',
    'a[href*="/user/"] img',
    '[class*="user-avatar"]',
    'header [class*="avatar"]'
  ]

  const NAME = [
    '[data-purpose="display-name"]',
    '[class*="user-profile-dropdown"] [class*="name"]',
    'a[href*="/user/"] img[alt]'
  ]

  let logged = false
  for (const sel of ACCOUNT) {
    if (document.querySelector(sel)) { logged = true; break }
  }

  let name = ''
  for (const sel of NAME) {
    const el = document.querySelector(sel)
    if (!el) continue
    name = (el.getAttribute('alt') || el.innerText || '').trim()
    if (name) break
  }

  /*
   * La pantalla de login es la señal NEGATIVA y manda sobre todo lo demas: si
   * está, no hay sesión aunque quede algún resto de avatar en el DOM.
   */
  const loginForm = !!document.querySelector('input[name="email"], form[action*="login"]')
  const url = location.href

  return JSON.stringify({
    ok: logged && !loginForm,
    name: name,
    url: url,
    loginForm: loginForm
  })
})()`

/** El título del curso, para nombrar la carpeta. */
export const COURSE_TITLE = `(() => {
  const SELECTORS = [
    '[data-purpose="course-title-link"]',
    'a[class*="course-title"]',
    'h1[class*="course-title"]'
  ]
  for (const sel of SELECTORS) {
    const el = document.querySelector(sel)
    const t = el && el.innerText ? el.innerText.trim() : ''
    if (t) return JSON.stringify({ ok: true, title: t })
  }
  const fromDoc = (document.title || '').replace(/\\s*\\|\\s*Udemy.*$/i, '').trim()
  return JSON.stringify({ ok: fromDoc.length > 0, title: fromDoc })
})()`

/**
 * Las cues del panel de transcripción.
 *
 * El panel tiene que estar abierto: abrirlo es un click y vive en `run.ts`,
 * no acá. Este script LEE, y que lea o no es la señal de si el panel está.
 */
export const READ_TRANSCRIPT = `(() => {
  const PANELS = [
    '[data-purpose="transcript-panel"]',
    '[data-purpose="transcript-cue-container"]',
    '[class*="transcript--transcript-panel"]',
    '[class*="transcript--cue-container"]',
    '[class*="transcript-panel"]',
    'section[aria-label*="ranscript"]',
    'div[aria-label*="ranscript"]'
  ]

  const CUES = [
    '[data-purpose="transcript-cue"]',
    '[class*="transcript--cue-container"] > *',
    '[class*="cue--cue"]',
    'p'
  ]

  let panel = null
  let panelSel = ''
  for (const sel of PANELS) {
    const el = document.querySelector(sel)
    if (el && el.innerText && el.innerText.trim().length > 40) {
      panel = el
      panelSel = sel
      break
    }
  }

  if (!panel) {
    const debug = [...document.querySelectorAll('[class*=transcript],[data-purpose*=transcript]')]
      .map((e) => e.tagName + '|' + (e.className || '') + '|' + (e.getAttribute('data-purpose') || ''))
      .slice(0, 15)
    return JSON.stringify({ ok: false, cues: [], debug })
  }

  for (const sel of CUES) {
    const nodes = [...panel.querySelectorAll(sel)]
      .map((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim())
      .filter((t) => t.length > 0)

    if (nodes.length >= 3) {
      return JSON.stringify({ ok: true, panel: panelSel, cue: sel, cues: nodes })
    }
  }

  return JSON.stringify({
    ok: false,
    cues: [],
    debug: [panelSel + ' existe pero sin lineas: ' + panel.innerHTML.slice(0, 400)]
  })
})()`

/**
 * Hace clic en la cue que contiene `needle`. El video SALTA a ese momento.
 *
 * Este es el truco que hace que la captura sea automática: no hay que calcular
 * un timestamp ni pedirle a nadie que mueva la barra. La cue del transcript ES
 * el control de posición, y el texto exacto de esa cue ya lo tenemos porque lo
 * leímos nosotros.
 *
 * El `needle` va por `JSON.stringify` porque es lo único que viene de afuera.
 */
export function clickCueScript(needle: string): string {
  return `(() => {
    const needle = ${JSON.stringify(needle)}
    const PANELS = [
      '[data-purpose="transcript-panel"]',
      '[class*="transcript--cue-container"]',
      '[class*="transcript-panel"]'
    ]

    let panel = null
    for (const sel of PANELS) {
      const el = document.querySelector(sel)
      if (el && el.innerText && el.innerText.trim().length > 40) { panel = el; break }
    }
    if (!panel) return JSON.stringify({ ok: false, why: 'sin panel' })

    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim()
    const target = [...panel.querySelectorAll('*')]
      .filter((n) => n.children.length === 0 || n.getAttribute('data-purpose') === 'transcript-cue')
      .find((n) => norm(n.innerText).indexOf(needle.slice(0, 60)) !== -1)

    if (!target) return JSON.stringify({ ok: false, why: 'no encontre la cue' })

    /* El elemento clickeable puede ser un ancestro: se prueba hacia arriba. */
    let node = target
    for (let i = 0; i < 4 && node; i++, node = node.parentElement) {
      if (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button' || node.onclick) break
    }
    ;(node || target).scrollIntoView({ block: 'center' })
    ;(node || target).click()

    return JSON.stringify({ ok: true })
  })()`
}

/**
 * Tapa lo que arruina una captura: los subtítulos y los controles del player.
 *
 * Esto salió de mirar una captura real. La slide decía *"Note: CCP — one EBS
 * can be only mounted to one EC2 instance. Associate Level: multi-attach
 * feature…"* y el subtítulo de Udemy, encima, tapaba justo la parte del
 * multi-attach — o sea, tapaba la EXCEPCIÓN a la regla que la slide enseñaba.
 * La captura salía y parecía correcta.
 *
 * ## Por qué CSS y no clickear el botón de subtítulos
 *
 * Clickear el botón depende de encontrarlo, de que el menú abra, y de que el
 * estado quede como uno cree. Una regla de CSS con `!important` no depende de
 * nada de eso, no cambia la preferencia del usuario, y se va sola cuando la
 * página navega. El texto del transcript ya lo tenemos del panel: no hace
 * falta quemado sobre la imagen.
 */
export const HIDE_OVERLAYS = `(() => {
  const ID = 'albus-hide-overlays'
  if (document.getElementById(ID)) return JSON.stringify({ ok: true, already: true })

  const style = document.createElement('style')
  style.id = ID
  style.textContent = [
    '[class*="captions-display"],',
    '[class*="captions-container"],',
    '[data-purpose="captions-cue-text"],',
    '[class*="video-player--controls"],',
    '[class*="control-bar"],',
    '[data-purpose="video-controls"]',
    '{ opacity: 0 !important; visibility: hidden !important; }'
  ].join(' ')

  document.head.appendChild(style)
  return JSON.stringify({ ok: true, already: false })
})()`

/** Pausa el video. Una captura de un frame en movimiento sale con motion blur. */
export const PAUSE_VIDEO = `(() => {
  const v = document.querySelector('video')
  if (!v) return JSON.stringify({ ok: false, why: 'sin <video>' })
  v.pause()
  return JSON.stringify({ ok: true, time: v.currentTime })
})()`

/**
 * Cuánto dura el video, para saber qué momentos muestrear.
 *
 * `duration` puede ser `NaN` mientras el player todavía no cargó los metadatos.
 * Se devuelve tal cual y decide `sampleTimes`, que ya trata un número no finito
 * como "no hay nada que muestrear". Inventar un default acá —diez minutos, por
 * decir— haría barrer un video de dos y capturar ocho veces la pantalla final.
 */
export const VIDEO_DURATION = `(() => {
  const v = document.querySelector('video')
  if (!v) return JSON.stringify({ ok: false, duration: 0 })
  const d = v.duration
  return JSON.stringify({ ok: Number.isFinite(d) && d > 0, duration: Number.isFinite(d) ? d : 0 })
})()`

/**
 * Salta el video a un momento. **Esto es lo que evita tener que mirar la clase.**
 *
 * Barrer seis minutos con muestreo cada cinco segundos son 78 saltos de unos
 * 200 ms: veinte segundos de reloj contra seis minutos de reproducción. Es la
 * diferencia entre bajar cincuenta clases en una tarde o en una semana.
 *
 * Pausa antes de saltar: un video corriendo sigue avanzando mientras se toma la
 * captura, y el frame sale movido y en otro momento del que se pidió.
 */
export function seekToScript(seconds: number): string {
  return `(() => {
    const v = document.querySelector('video')
    if (!v) return JSON.stringify({ ok: false })
    v.pause()
    v.currentTime = ${JSON.stringify(seconds)}
    return JSON.stringify({ ok: true })
  })()`
}

/**
 * ¿Ya llegó al momento pedido y hay imagen para capturar?
 *
 * `readyState >= 2` es HAVE_CURRENT_DATA: hay un frame decodificado en esa
 * posición. Sin este chequeo la captura sale del frame ANTERIOR, y el error es
 * silencioso — una imagen válida, de otro momento.
 */
export function seekDoneScript(seconds: number): string {
  return `(() => {
    const v = document.querySelector('video')
    if (!v) return JSON.stringify({ ok: false })
    const near = Math.abs(v.currentTime - ${JSON.stringify(seconds)}) < 0.75
    return JSON.stringify({ ok: near && v.readyState >= 2, at: v.currentTime })
  })()`
}

/** El rectángulo del <video>, para recortar la captura y no guardar la UI. */
export const VIDEO_RECT = `(() => {
  const v = document.querySelector('video')
  if (!v) return JSON.stringify({ ok: false })
  const r = v.getBoundingClientRect()
  return JSON.stringify({
    ok: true,
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height)
  })
})()`
