/**
 * JavaScript que corre DENTRO de la página. Son strings constantes: nada de
 * acá se arma con datos del modelo, y los únicos valores que entran lo hacen
 * por `JSON.stringify` desde el main (ver page.ts).
 *
 * Vive separado del adaptador porque es lo único del módulo que no es
 * TypeScript de verdad — es texto que viaja al renderer de otra página — y
 * mezclarlo con la lógica del puerto invita a interpolar algo que no se debe.
 */

/**
 * Lee el formulario visible y estampa `data-albus-fid` en cada control. El id
 * es nuestro: no dependemos de los selectores del sitio, que en LinkedIn son
 * hashes que cambian entre deploys.
 */
export const READ_FORM = `(() => {
  const visible = (el) => {
    if (!el) return false
    if (el.disabled) return false
    if (el.type === 'hidden') return false
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none'
  }

  const text = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : '')

  const label = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim()

    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const parts = by.split(/\\s+/).map((id) => text(document.getElementById(id))).filter(Boolean)
      if (parts.length) return parts.join(' ')
    }

    if (el.id) {
      const escaped = window.CSS && CSS.escape ? CSS.escape(el.id) : el.id
      const l = document.querySelector('label[for="' + escaped + '"]')
      if (l) return text(l)
    }

    const own = el.closest('label')
    if (own) return text(own)

    // Greenhouse y Workday envuelven cada campo en un div con el label arriba.
    let n = el.parentElement
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
      const l = n.querySelector('label, legend, .artdeco-text-input--label')
      if (l && text(l)) return text(l)
    }

    // Última chance: el fieldset que lo agrupa (típico de los radios).
    const fs = el.closest('fieldset')
    if (fs) {
      const lg = fs.querySelector('legend')
      if (lg && text(lg)) return text(lg)
    }

    return el.placeholder || el.name || ''
  }

  /**
   * La etiqueta de un GRUPO de radios es la pregunta, no el texto del primer
   * botón. Sin esto, "¿Estás autorizado a trabajar?" se lee como "Sí" y
   * ninguna regla la reconoce.
   */
  const groupLabel = (el) => {
    const fs = el.closest('fieldset')
    if (fs) {
      const lg = fs.querySelector('legend')
      if (lg && text(lg)) return text(lg)
    }
    const group = el.closest('[role=radiogroup], [role=group]')
    if (group) {
      if (group.getAttribute('aria-label')) return group.getAttribute('aria-label').trim()
      const by = group.getAttribute('aria-labelledby')
      if (by) {
        const t = text(document.getElementById(by))
        if (t) return t
      }
    }
    return label(el)
  }

  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'textarea') return 'textarea'
    if (tag === 'select') return 'select'
    const t = (el.type || 'text').toLowerCase()
    const known = ['text','number','tel','email','url','date','file','checkbox','radio']
    return known.includes(t) ? t : 'unknown'
  }

  document.querySelectorAll('[data-albus-fid]').forEach((el) => el.removeAttribute('data-albus-fid'))

  /*
   * Si hay un modal abierto, el formulario es ESE. Sin esto, en LinkedIn el
   * buscador del header entra como campo del formulario y se lleva un turno del
   * modelo para nada.
   *
   * Pero el modal tiene que ser uno DE VERDAD, y esto costó una corrida entera.
   *
   * Acá había un querySelector pelado que tomaba el PRIMER [role=dialog] del
   * documento, sin mirar si era visible, si tenía tamaño ni si tenía algo adentro.
   * En la página de carreras de Monks el agente cerró el modal de idioma y el
   * banner de cookies; sus contenedores siguen en el DOM, vacíos y sin
   * aria-hidden. root pasó a ser uno de esos, y READ_FORM devolvió CERO campos y
   * CERO botones sobre una página que tenía el formulario de Greenhouse completo:
   * first_name, last_name, email, phone y Submit. El agente los veía en su
   * inventario y este lector no veía nada.
   *
   * Tres filtros, y ninguno es cosmético:
   *   1. visible y con tamaño — un contenedor de 0x0 no es un modal
   *   2. que CONTENGA algún control — un diálogo sin un input ni un botón no es
   *      el formulario, es un cascarón que quedó
   *   3. el ÚLTIMO del DOM entre los que quedan, que es el que se pintó encima
   *
   * INVENTORY, en este mismo archivo, ya hacía todo esto desde que Notion enseñó
   * la lección. Este lector nunca la recibió.
   */
  const dialogs = [...document.querySelectorAll('[role=dialog]:not([aria-hidden=true]), dialog[open]')]
    .filter((el) => {
      const r = el.getBoundingClientRect()
      if (r.width < 40 || r.height < 40) return false
      const s = getComputedStyle(el)
      if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false
      return el.querySelector('input, select, textarea, button') !== null
    })

  const modal = dialogs.length > 0 ? dialogs[dialogs.length - 1] : null
  const root = modal || document

  const noise = (el) => !!el.closest('header, nav, [role=navigation], [role=search], [role=banner]')

  /*
   * El PIE tiene sus propios formularios, y llenarlos hace daño de verdad.
   *
   * En la página de Monks el bucle escribió el nombre, el apellido y el mail del
   * candidato en el widget de NEWSLETTER del pie, y apretó su "Continue to the next
   * step." dos veces avanzando ese wizard. Se veía en la traza: el campo 8 cambiaba
   * en cada vuelta —"First name*", "Last name*", "Work Email*"— junto a un botón
   * "Subscribe". Y como la firma del formulario cambiaba, la detección de
   * estancamiento nunca se disparó: tres vueltas, tres llamadas al modelo, y los
   * datos del usuario en una lista de marketing.
   *
   * Se aplica SOLO a los campos, no a los botones: un campo de formulario en el pie
   * del sitio nunca es parte de una postulación, pero un botón sí puede estarlo —
   * hay ATS que dejan el submit en una barra pegada abajo. La asimetría es
   * deliberada.
   */
  const inFooter = (el) => !!el.closest('footer, [role=contentinfo]')

  const controls = [...root.querySelectorAll('input, select, textarea')]
    .filter(visible)
    .filter((el) => modal || (!noise(el) && !inFooter(el)))
    .filter((el) => (el.type || '').toLowerCase() !== 'search')

  const fields = []
  const seenRadios = new Set()
  let n = 0

  for (const el of controls) {
    const kind = kindOf(el)

    if (kind === 'radio') {
      const group = el.name || ''
      if (group && seenRadios.has(group)) continue
      if (group) seenRadios.add(group)

      const siblings = group
        ? [...document.querySelectorAll('input[type=radio][name="' + group.replace(/"/g, '\\\\"') + '"]')]
        : [el]

      const fid = 'f' + n++
      el.setAttribute('data-albus-fid', fid)

      fields.push({
        id: fid,
        selector: '[data-albus-fid="' + fid + '"]',
        kind: 'radio',
        label: groupLabel(el),
        name: group,
        placeholder: '',
        required: siblings.some((h) => h.required),
        value: (siblings.find((h) => h.checked) || {}).value || '',
        options: siblings.map((h) => ({ value: h.value, label: label(h) || h.value })),
        maxLength: null
      })
      continue
    }

    const fid = 'f' + n++
    el.setAttribute('data-albus-fid', fid)

    fields.push({
      id: fid,
      selector: '[data-albus-fid="' + fid + '"]',
      kind: kind,
      label: label(el),
      name: el.name || '',
      placeholder: el.placeholder || '',
      required: !!el.required || el.getAttribute('aria-required') === 'true',
      value: kind === 'checkbox' ? String(el.checked) : (el.value || ''),
      options: kind === 'select'
        ? [...el.options].map((o) => ({ value: o.value, label: text(o) || o.value }))
        : [],
      maxLength: el.maxLength && el.maxLength > 0 ? el.maxLength : null
    })
  }

  /*
   * Los <a> cuentan como botones. Esta línea es la razón por la que no se podía
   * postular a una vacante externa.
   *
   * LinkedIn resuelve "Solicitar ahora" con un ANCHOR y target="_blank" hacia el
   * ATS de la empresa — es exactamente el caso para el que existe el
   * setWindowOpenHandler de browser/page.ts. Pero acá se juntaban solo button,
   * input[type=submit] y [role=button], así que el bucle NUNCA veía ese link,
   * nunca lo clickeaba, y el handler que sabe seguirlo no llegaba a dispararse
   * jamás: las dos mitades de la misma función nunca se encontraron. El síntoma
   * era una ventana abierta y quieta, y un "no encontré el botón para avanzar"
   * sobre una página que tenía el botón a la vista.
   *
   * INVENTORY, en este mismo archivo, incluye a[href] desde siempre y explica en
   * su comentario por qué enumerar selectores no termina nunca. Este extractor
   * se quedó con tres.
   *
   * Acá NO se filtra por texto: el que clasifica es el main (classifyButton), y
   * lo que no caiga en next/submit/apply no se aprieta jamás. Un link de más
   * cuesta un renglón de log; un link de menos cuesta la postulación entera.
   */
  const candidates = [...root.querySelectorAll('button, a[href], input[type=submit], [role=button]')]
    .filter(visible)
    .filter((el) => modal || !noise(el))

  const buttons = []
  let b = 0
  for (const el of candidates) {
    // Recortado: un <a> puede envolver una tarjeta entera de empleo y traer un
    // párrafo. classifyButton ancla sus regex al principio, así que el arranque
    // es todo lo que decide — y el resto solo ensucia el log y el payload.
    const lbl = (text(el) || el.value || el.getAttribute('aria-label') || '').slice(0, 120)
    if (!lbl) continue
    const bid = 'b' + b++
    el.setAttribute('data-albus-fid', bid)
    buttons.push({ selector: '[data-albus-fid="' + bid + '"]', label: lbl, kind: 'other' })
  }

  return JSON.stringify({
    url: location.href,
    title: document.title,
    // Si se leyó un modal o el documento entero. Va en la traza: "cero campos y
    // cero botones" es incontestable sin saber DÓNDE se miró, y ya costó una
    // corrida creer que la página estaba vacía cuando el root estaba mal.
    inModal: !!modal,
    fields: fields,
    buttons: buttons
  })
})()`

/**
 * Setear `.value` a mano no alcanza: React guarda su propio valor en el nodo y
 * al re-renderizar pisa lo que escribimos. Hay que llamar al setter nativo del
 * prototipo y después disparar los eventos que React escucha.
 */
export function fillScript(selector: string, value: string): string {
  const sel = JSON.stringify(selector)
  const val = JSON.stringify(value)

  return `(() => {
    const el = document.querySelector(${sel})
    if (!el) return JSON.stringify({ ok: false, error: 'no existe el campo' })

    const value = ${val}
    const dispatch = (n) => {
      n.dispatchEvent(new Event('input', { bubbles: true }))
      n.dispatchEvent(new Event('change', { bubbles: true }))
    }

    const setNative = (n, v) => {
      const proto = n instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : n instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && desc.set) desc.set.call(n, v)
      else n.value = v
    }

    const kind = (el.type || el.tagName).toLowerCase()

    if (kind === 'radio') {
      const group = el.name
      const list = group
        ? [...document.querySelectorAll('input[type=radio][name="' + group.replace(/"/g, '\\\\"') + '"]')]
        : [el]
      const chosen = list.find((r) => r.value === value)
        || list.find((r) => (r.labels && r.labels[0] ? r.labels[0].textContent : '').trim() === value)
      if (!chosen) return JSON.stringify({ ok: false, error: 'ninguna opción coincide' })
      chosen.click()
      return JSON.stringify({ ok: true })
    }

    if (kind === 'checkbox') {
      const desired = value === 'true' || value === 'Yes' || value === 'yes'
      if (el.checked !== desired) el.click()
      return JSON.stringify({ ok: true })
    }

    if (el instanceof HTMLSelectElement) {
      const byValue = [...el.options].find((o) => o.value === value)
      const byText = [...el.options].find((o) => (o.textContent || '').trim() === value)
      const option = byValue || byText
      if (!option) return JSON.stringify({ ok: false, error: 'ninguna opción coincide' })
      setNative(el, option.value)
      dispatch(el)
      return JSON.stringify({ ok: true })
    }

    if (el.isContentEditable) {
      el.focus()
      el.textContent = value
      dispatch(el)
      return JSON.stringify({ ok: true })
    }

    el.focus()
    setNative(el, value)
    dispatch(el)
    el.blur()
    return JSON.stringify({ ok: true, written: el.value === value })
  })()`
}

/**
 * Un click COMO EL DE UNA PERSONA: la secuencia completa de eventos.
 *
 * `el.click()` dispara UN evento: `click`. Y eso alcanza para un `<button>` de
 * toda la vida, pero no para los componentes con los que está hecha la web hoy —
 * Radix, Headless UI, react-select, MUI— que seleccionan en `pointerdown` o
 * `mousedown` y ni escuchan `click`.
 *
 * El síntoma es el peor posible: el click "funciona" —no tira error, el elemento
 * existía— y la página no hace nada. Pasó con las preguntas de opción múltiple del
 * formulario de Monks: el agente eligió la opción D, la vio seguir ahí, la volvió a
 * clickear pensando que le había pegado al `<li>` en vez de al `<button
 * role=option>`, y a la tercera se rindió pidiéndole al usuario que cerrara el
 * modal a mano. Estaba haciendo todo bien; el click era el que mentía.
 *
 * También explica los "el click no navegó" del bucle determinista.
 *
 * (Sin backticks: esto vive DENTRO de un template literal.)
 */
const REAL_CLICK = `
  const realClick = (el) => {
    el.scrollIntoView({ block: 'center' })

    const r = el.getBoundingClientRect()
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2
    }

    // PointerEvent no existe en todos los contextos; si falta, los de mouse solos
    // ya cubren a la mayoría de las librerías.
    const pointer = (type) => {
      try {
        el.dispatchEvent(new PointerEvent(type, Object.assign({}, opts, {
          pointerId: 1, pointerType: 'mouse', isPrimary: true
        })))
      } catch (e) { /* seguimos con los de mouse */ }
    }

    try { if (el.focus) el.focus() } catch (e) { /* un elemento no enfocable no es un error */ }

    pointer('pointerover')
    el.dispatchEvent(new MouseEvent('mouseover', opts))
    pointer('pointerdown')
    el.dispatchEvent(new MouseEvent('mousedown', opts))
    pointer('pointerup')
    el.dispatchEvent(new MouseEvent('mouseup', opts))

    // El 'click' sintético SÍ ejecuta la acción por defecto —navega un <a>, tilda
    // un checkbox—, así que NO se llama además a el.click(): duplicar el evento
    // hace que un dropdown se abra y se cierre en el mismo gesto.
    el.dispatchEvent(new MouseEvent('click', opts))
  }
`

export function clickScript(selector: string): string {
  const sel = JSON.stringify(selector)
  return `(() => {
    ${REAL_CLICK}
    const el = document.querySelector(${sel})
    if (!el) return JSON.stringify({ ok: false, error: 'no existe el botón' })
    realClick(el)
    return JSON.stringify({ ok: true })
  })()`
}

/** Cuántos campos ve un frame. Sirve para elegir dónde está el formulario. */
export const COUNT_FIELDS = `(() => document.querySelectorAll('input, select, textarea').length)()`

/**
 * Click por TEXTO visible.
 *
 * Notion es una SPA con clases generadas: `.css-1x7fj2b` cambia en cada
 * deploy y un selector así se rompe sin avisar. El texto del botón —"New
 * integration", "Show", "Copy"— es lo único que sobrevive a un rediseño, y si
 * cambia también, cambió la UI de verdad y queremos enterarnos.
 */
export function clickTextScript(texts: string[], exact = false): string {
  const list = JSON.stringify(texts.map((t) => t.toLowerCase()))
  return `(() => {
    const wanted = ${list}
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return false
      const s = getComputedStyle(el)
      return s.visibility !== 'hidden' && s.display !== 'none'
    }

    /**
     * Un encabezado de tabla NO es un botón, aunque tenga tabindex.
     *
     * Buscando "create" para guardar una integración, este script clickeó el
     * <th> "Created" de la tabla de atrás — y devolvió ok. Un falso positivo
     * es peor que no encontrar nada: el que llama cree que avanzó.
     */
    const actionable = (el) => {
      if (el.closest('thead, th')) return false
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false
      return true
    }

    const candidates = [...document.querySelectorAll(
      'button, a, [role=button], [role=menuitem], [role=option], div[tabindex], span[role]'
    )].filter(visible).filter(actionable)

    const normal = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase()

    const press = (hit) => {
      hit.scrollIntoView({ block: 'center' })
      hit.click()
      return JSON.stringify({ ok: true, text: (hit.textContent || '').trim().slice(0, 80) })
    }

    /**
     * Por precisión, no por orden de aparición: exacto gana sobre "empieza
     * con", y ese gana sobre "lo contiene". Sin esta escala, "create" elige
     * "Created" antes que "Create connection" solo porque está más arriba.
     */
    for (const b of wanted) {
      const hit = candidates.find((el) => normal(el) === b)
      if (hit) return press(hit)
    }

    if (${exact ? 'true' : 'false'}) {
      return JSON.stringify({ ok: false, error: 'no encontré exacto ' + wanted.join(' / ') })
    }

    for (const b of wanted) {
      const hit = candidates.find((el) => normal(el).startsWith(b))
      if (hit) return press(hit)
    }

    for (const b of wanted) {
      const hit = candidates.find((el) => normal(el).includes(b))
      if (hit) return press(hit)
    }

    return JSON.stringify({ ok: false, error: 'no encontré ' + wanted.join(' / ') })
  })()`
}

/**
 * `INVENTORY`: todo lo que se puede clickear o escribir, con un id nuestro.
 *
 * Esto es lo que el modelo MIRA. La diferencia con `clickText` es de fondo:
 * `clickText` va con una lista de textos esperados y falla si el sitio no dice
 * exactamente eso. El inventario no espera nada — describe lo que HAY y deja
 * que el modelo elija. Cuando Notion le cambie el nombre a su botón, el
 * inventario lo sigue viendo; la lista de strings no.
 *
 * Se estampa `data-albus-cid` en cada elemento, igual que `READ_FORM` con los
 * campos: el id es nuestro y sobrevive a los hashes de clase de la SPA.
 *
 * `rect` va a propósito: es lo que le permite al modelo cruzar este texto con
 * la captura de pantalla. Sin coordenadas, mirar la imagen no alcanza para
 * decidir cuál de dos botones que dicen lo mismo es el bueno.
 *
 * Las claves que emite son el contrato de `Inventory` / `InventoryItem` en
 * `core/jobs/ports.ts`, y `action` vale exactamente `'click'` o `'type'`: es
 * lo que consume el enum de zod de `connections/navigate-llm.ts`. Este archivo
 * es texto para el navegador, así que el typecheck no puede verificarlo — si
 * las tres partes no dicen lo mismo, falla en ejecución y en silencio.
 */
export const INVENTORY = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return false
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false
    return r.bottom > 0 && r.right > 0
  }

  /*
   * innerText y no textContent.
   *
   * textContent pega todo sin respirar: una fila de tabla salía como
   * "AAlbus AgentRead, update, and insertJorge Diaz's Notion" — una sola
   * palabra ilegible donde había cuatro columnas. innerText devuelve el texto
   * COMO SE VE, con los saltos que el layout produce, y eso se convierte en
   * separadores. Cuesta un reflow; vale lo que cuesta, porque de esto depende
   * que quien elige entienda qué está eligiendo.
   */
  const text = (el) => {
    const raw = el.innerText !== undefined && el.innerText !== null ? el.innerText : el.textContent
    return (raw || '')
      .split('\\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' · ')
      .replace(/\\s+/g, ' ')
      .trim()
  }

  document.querySelectorAll('[data-albus-cid]').forEach((el) => el.removeAttribute('data-albus-cid'))

  /*
   * El overlay que está ARRIBA DE TODO, no el primero que aparezca.
   *
   * Esto tomaba el primer [role=dialog] del documento y descartaba el resto.
   * Notion abre el menú "···" y encima de él el flyout de Connections: dos
   * overlays apilados. Mirando solo el primero, el inventario listaba las
   * opciones del menú de fondo y NO las del flyout abierto — el agente lo dijo
   * exacto: "el flyout ya está abierto pero el inventario no lo incluye; no
   * hay ningún id para Albus Agent". Y se quedaba clickeando en círculos.
   *
   * Gana el z-index más alto; si empatan, el último del DOM, que es el que se
   * pintó después. Se incluyen menús y listboxes, no solo dialogs: casi nadie
   * le pone role=dialog a un flyout.
   */
  const layer = (el) => {
    const s = getComputedStyle(el)
    const z = parseInt(s.zIndex, 10)
    return Number.isNaN(z) ? 0 : z
  }

  const overlays = [...document.querySelectorAll(
    '[role=dialog]:not([aria-hidden=true]), dialog[open], [role=menu], [role=listbox], [aria-modal=true]'
  )].filter((el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 40 || r.height < 40) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'
  })

  let modal = null
  for (const el of overlays) {
    // >= y no >: ante z-index iguales gana el último recorrido, que es el que
    // se montó después — el flyout que acaba de abrirse sobre el menú.
    if (modal === null || layer(el) >= layer(modal)) modal = el
  }

  const root = modal || document

  /*
   * Lo semánticamente interactivo. Es la mitad barata del problema.
   *
   * La otra mitad —y la que rompía todo— es que React NO deja rastro en el
   * DOM: registra los handlers por delegación, así que [onclick] no existe y
   * [tabindex] solo aparece si alguien se acordó de ponerlo. En Notion, la
   * FILA de una integración no tiene ni uno ni otro, y el agente reportaba
   * "su fila no está en el inventario". Enumerar selectores no iba a terminar
   * nunca: siempre falta uno.
   */
  const CLICK_SELECTOR = [
    'button', 'a[href]', '[role=button]', '[role=menuitem]', '[role=option]',
    '[role=tab]', '[role=switch]', '[role=checkbox]', '[role=row]', '[role=gridcell]',
    '[role=link]', '[role=treeitem]', '[role=listitem]', 'summary', 'tr', 'li',
    'input[type=submit]', 'input[type=button]', 'input[type=checkbox]', 'input[type=radio]',
    '[onclick]', '[tabindex]:not([tabindex="-1"])'
  ].join(', ')

  const TYPE_SELECTOR = 'input:not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, select, [contenteditable=true]'

  /*
   * Un encabezado de tabla NO es un control, aunque tenga tabindex.
   *
   * El TH "Created" de Notion entraba al inventario por el selector de
   * tabindex, y desde ahí el agente lo podía elegir para "crear" algo. Un
   * BUTTON adentro de un th sí vale —son los de ordenar—; el th pelado no.
   *
   * (Sin backticks: este comentario vive DENTRO de un template literal.)
   */
  const isTableHeader = (el) => {
    const t = el.tagName
    if (t === 'TH' || t === 'THEAD') return true
    if (!el.closest('thead')) return false
    return !['BUTTON', 'A'].includes(t) && el.getAttribute('role') !== 'button'
  }

  const items = []
  let n = 0

  const add = (el, action) => {
    if (el.hasAttribute('data-albus-cid')) return
    if (isTableHeader(el)) return
    const r = el.getBoundingClientRect()
    const cid = 'c' + n++
    el.setAttribute('data-albus-cid', cid)

    /*
     * La etiqueta hereda del ancestro cercano.
     *
     * Un menú de tres puntos suele ser un div con aria-label="Más acciones"
     * que adentro tiene un span con "···". Si se toma el span y se lee solo su
     * propio aria-label, queda un item que dice "···" y nada más — ilegible
     * para quien tiene que elegir.
     */
    const inherited = (attr) => {
      let node = el
      for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
        const v = node.getAttribute && node.getAttribute(attr)
        if (v) return v
      }
      return ''
    }

    // Todo lo que identifica al elemento para un humano que mira la pantalla.
    const label = [
      text(el).slice(0, 120),
      inherited('aria-label'),
      inherited('title'),
      el.placeholder || '',
      el.getAttribute('name') || ''
    ].filter(Boolean).join(' | ')

    items.push({
      cid: cid,
      action: action,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || (el.type || ''),
      text: label.slice(0, 200),
      value: action === 'type' ? String(el.value || '').slice(0, 60) : '',
      href: (el.getAttribute('href') || '').slice(0, 120),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    })
  }

  for (const el of root.querySelectorAll(CLICK_SELECTOR)) {
    if (visible(el)) add(el, 'click')
  }
  for (const el of root.querySelectorAll(TYPE_SELECTOR)) {
    if (visible(el)) add(el, 'type')
  }

  /*
   * La red de seguridad: "cursor: pointer".
   *
   * Es la señal que un humano usa para saber que algo se clickea, y la única
   * que las SPAs SÍ dejan en el DOM — porque la necesitan para que se vea
   * bien. Ningún framework la puede evitar. Donde los selectores fallan, esto
   * agarra: la fila de una integración en Notion, una tarjeta de LinkedIn, un
   * ítem de menú hecho con divs.
   *
   * Se toma el MÁS EXTERNO de cada grupo: una fila de tabla clickeable con
   * tres celdas adentro es UNA cosa que se puede apretar, no cuatro. Como el
   * recorrido va en orden de documento, alcanza con saltear todo lo que tenga
   * un ancestro ya marcado.
   *
   * Con el límite del 60% de la pantalla: un contenedor gigante con pointer
   * —el wrapper de toda la app— no es un control, y si entrara taparía a todo
   * lo de adentro.
   */
  const viewportArea = (window.innerWidth || 1280) * (window.innerHeight || 900)

  const pointerCandidates = [...root.querySelectorAll(
    'div, span, li, tr, td, p, h1, h2, h3, section, article, label, img, svg'
  )].filter(visible)

  for (const el of pointerCandidates) {
    if (el.hasAttribute('data-albus-cid')) continue
    if (el.parentElement && el.parentElement.closest('[data-albus-cid]')) continue
    if (getComputedStyle(el).cursor !== 'pointer') continue

    const r = el.getBoundingClientRect()
    if (r.width * r.height > viewportArea * 0.6) continue

    if (text(el) !== '' || el.getAttribute('aria-label')) add(el, 'click')
  }

  // Sin texto y sin ser un campo no le dice nada a nadie: gasta tokens al pedo.
  const useful = items.filter((i) => i.text !== '' || i.action === 'type')

  /*
   * El recorte por CERCANÍA A LA PANTALLA, no por orden en el DOM.
   *
   * Con la red de pointer entran bastantes más elementos, y cortar los últimos
   * 30 del documento puede tirar justo el botón que importa —que suele estar
   * abajo, después de todo el menú lateral—. Lo que está a la vista primero.
   */
  const height = window.innerHeight || 900
  const onScreen = (i) => i.rect.y >= -50 && i.rect.y <= height
  const sorted = [
    ...useful.filter(onScreen),
    ...useful.filter((i) => !onScreen(i))
  ]

  return JSON.stringify({
    url: location.href,
    title: document.title,
    inModal: !!modal,
    /*
     * document.body puede ser NULL. No es defensivo de más: pasó.
     *
     * Entre que se clickea un link y que el documento nuevo tiene body hay un
     * hueco. El agente clickeó "Solicitar", el navegador arrancó hacia monks.com,
     * y el inventario siguiente corrió justo ahí: TypeError leyendo innerText de
     * null. El paso del agente se contó como fallido y la postulación murió con la
     * página nueva ya cargada en la ventana.
     *
     * (Sin backticks: este comentario vive DENTRO de un template literal.)
     */
    text: ((document.body && document.body.innerText) || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 2500),
    truncated: sorted.length > 150,
    items: sorted.slice(0, 150)
  })
})()`

/**
 * Click por el id que estampó el inventario.
 *
 * El modelo devuelve un `cid` —un valor de una lista cerrada que generamos
 * nosotros—, nunca un selector ni JavaScript. Si inventa uno que no existe,
 * esto falla ruidoso en vez de clickear cualquier cosa.
 */
export function clickByIdScript(cid: string): string {
  const id = JSON.stringify(cid)
  return `(() => {
    ${REAL_CLICK}
    const el = document.querySelector('[data-albus-cid=' + JSON.stringify(${id}) + ']')
    if (!el) return JSON.stringify({ ok: false, error: 'ese id ya no está en la página' })

    // innerText y no textContent, por lo mismo que en el inventario: si no, el
    // log dice clickeé "AAlbus AgentRead, update, and insert contentJorge Diaz"
    // y el usuario no reconoce qué apretó.
    const raw = el.innerText !== undefined && el.innerText !== null ? el.innerText : el.textContent
    const seen = (raw || '').split('\\n').map((l) => l.trim()).filter(Boolean).join(' · ')

    realClick(el)
    return JSON.stringify({ ok: true, text: seen.slice(0, 80) })
  })()`
}

/** Escribe en el elemento que el inventario marcó con ese id. */
export function typeByIdScript(cid: string, value: string): string {
  const id = JSON.stringify(cid)
  const val = JSON.stringify(value)
  return `(() => {
    const el = document.querySelector('[data-albus-cid=' + JSON.stringify(${id}) + ']')
    if (!el) return JSON.stringify({ ok: false, error: 'ese id ya no está en la página' })

    const value = ${val}
    if (el.isContentEditable) {
      el.focus()
      el.textContent = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return JSON.stringify({ ok: true })
    }

    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    el.focus()
    if (desc && desc.set) desc.set.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return JSON.stringify({ ok: true, written: el.value === value })
  })()`
}

/** ¿Está alguno de estos textos en la página? Para esperar a que cargue. */
export function hasTextScript(texts: string[]): string {
  const list = JSON.stringify(texts.map((t) => t.toLowerCase()))
  return `(() => {
    // document.body es null mientras el documento navega, y esto justamente se
    // llama en bucle esperando que una página cargue. Ver el comentario en INVENTORY.
    const body = ((document.body && document.body.innerText) || '').toLowerCase()
    const which = ${list}.find((t) => body.includes(t)) || ''
    return JSON.stringify({ ok: which !== '', which: which })
  })()`
}

/**
 * Saca de la página el primer texto que matchee el patrón. Se usa para leer el
 * token que Notion pinta en pantalla después de crear la integración.
 *
 * El patrón viaja como string y se compila del otro lado. NO se interpola nada
 * del usuario: los patrones son el `secretPattern` de `connections/services.ts`.
 */
export function extractPatternScript(pattern: string, flags = ''): string {
  return `(() => {
    const re = new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)})

    // Primero los inputs: Notion muestra el secreto dentro de un <input readonly>,
    // y su valor NO está en innerText.
    for (const el of document.querySelectorAll('input, textarea')) {
      const v = el.value || ''
      const m = v.match(re)
      if (m) return JSON.stringify({ ok: true, value: m[0], where: 'input' })
    }

    // Null mientras navega. Ver el comentario en INVENTORY.
    const text = (document.body && document.body.innerText) || ''
    const m = text.match(re)
    return m
      ? JSON.stringify({ ok: true, value: m[0], where: 'text' })
      : JSON.stringify({ ok: false, error: 'no encontré el patrón en la página' })
  })()`
}

/** Escribe en el primer input visible que matchee el placeholder o la etiqueta. */
export function typeByLabelScript(hints: string[], value: string): string {
  return `(() => {
    const hints = ${JSON.stringify(hints.map((p) => p.toLowerCase()))}
    const val = ${JSON.stringify(value)}
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 || r.height > 0
    }

    const fields = [...document.querySelectorAll('input[type=text], input:not([type]), textarea')]
      .filter(visible)

    const matches = (el) => {
      const s = [el.placeholder, el.getAttribute('aria-label'), el.name, el.id]
        .filter(Boolean).join(' ').toLowerCase()
      return hints.some((p) => s.includes(p))
    }

    const el = fields.find(matches) || fields[0]
    if (!el) return JSON.stringify({ ok: false, error: 'no hay dónde escribir' })

    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    el.focus()
    if (desc && desc.set) desc.set.call(el, val)
    else el.value = val
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return JSON.stringify({ ok: true })
  })()`
}
