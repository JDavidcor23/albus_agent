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

  const texto = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : '')

  const etiqueta = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim()

    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const partes = by.split(/\\s+/).map((id) => texto(document.getElementById(id))).filter(Boolean)
      if (partes.length) return partes.join(' ')
    }

    if (el.id) {
      const escapado = window.CSS && CSS.escape ? CSS.escape(el.id) : el.id
      const l = document.querySelector('label[for="' + escapado + '"]')
      if (l) return texto(l)
    }

    const propio = el.closest('label')
    if (propio) return texto(propio)

    // Greenhouse y Workday envuelven cada campo en un div con el label arriba.
    let n = el.parentElement
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
      const l = n.querySelector('label, legend, .artdeco-text-input--label')
      if (l && texto(l)) return texto(l)
    }

    // Última chance: el fieldset que lo agrupa (típico de los radios).
    const fs = el.closest('fieldset')
    if (fs) {
      const lg = fs.querySelector('legend')
      if (lg && texto(lg)) return texto(lg)
    }

    return el.placeholder || el.name || ''
  }

  /**
   * La etiqueta de un GRUPO de radios es la pregunta, no el texto del primer
   * botón. Sin esto, "¿Estás autorizado a trabajar?" se lee como "Sí" y
   * ninguna regla la reconoce.
   */
  const etiquetaGrupo = (el) => {
    const fs = el.closest('fieldset')
    if (fs) {
      const lg = fs.querySelector('legend')
      if (lg && texto(lg)) return texto(lg)
    }
    const grupo = el.closest('[role=radiogroup], [role=group]')
    if (grupo) {
      if (grupo.getAttribute('aria-label')) return grupo.getAttribute('aria-label').trim()
      const by = grupo.getAttribute('aria-labelledby')
      if (by) {
        const t = texto(document.getElementById(by))
        if (t) return t
      }
    }
    return etiqueta(el)
  }

  const tipo = (el) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'textarea') return 'textarea'
    if (tag === 'select') return 'select'
    const t = (el.type || 'text').toLowerCase()
    const conocidos = ['text','number','tel','email','url','date','file','checkbox','radio']
    return conocidos.includes(t) ? t : 'unknown'
  }

  document.querySelectorAll('[data-albus-fid]').forEach((el) => el.removeAttribute('data-albus-fid'))

  /**
   * Si hay un modal abierto, el formulario es ESE. Sin esto, en LinkedIn el
   * buscador del header entra como campo del formulario y se lleva un turno
   * del modelo para nada.
   */
  const modal = document.querySelector('[role=dialog]:not([aria-hidden=true]), dialog[open]')
  const raiz = modal || document

  const ruido = (el) => !!el.closest('header, nav, [role=navigation], [role=search], [role=banner]')

  const controles = [...raiz.querySelectorAll('input, select, textarea')]
    .filter(visible)
    .filter((el) => modal || !ruido(el))
    .filter((el) => (el.type || '').toLowerCase() !== 'search')

  const fields = []
  const radiosVistos = new Set()
  let n = 0

  for (const el of controles) {
    const kind = tipo(el)

    if (kind === 'radio') {
      const grupo = el.name || ''
      if (grupo && radiosVistos.has(grupo)) continue
      if (grupo) radiosVistos.add(grupo)

      const hermanos = grupo
        ? [...document.querySelectorAll('input[type=radio][name="' + grupo.replace(/"/g, '\\\\"') + '"]')]
        : [el]

      const fid = 'f' + n++
      el.setAttribute('data-albus-fid', fid)

      fields.push({
        id: fid,
        selector: '[data-albus-fid="' + fid + '"]',
        kind: 'radio',
        label: etiquetaGrupo(el),
        name: grupo,
        placeholder: '',
        required: hermanos.some((h) => h.required),
        value: (hermanos.find((h) => h.checked) || {}).value || '',
        options: hermanos.map((h) => ({ value: h.value, label: etiqueta(h) || h.value })),
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
      label: etiqueta(el),
      name: el.name || '',
      placeholder: el.placeholder || '',
      required: !!el.required || el.getAttribute('aria-required') === 'true',
      value: kind === 'checkbox' ? String(el.checked) : (el.value || ''),
      options: kind === 'select'
        ? [...el.options].map((o) => ({ value: o.value, label: texto(o) || o.value }))
        : [],
      maxLength: el.maxLength && el.maxLength > 0 ? el.maxLength : null
    })
  }

  const candidatos = [...raiz.querySelectorAll('button, input[type=submit], [role=button]')]
    .filter(visible)
    .filter((el) => modal || !ruido(el))

  const buttons = []
  let b = 0
  for (const el of candidatos) {
    const label = texto(el) || el.value || el.getAttribute('aria-label') || ''
    if (!label) continue
    const bid = 'b' + b++
    el.setAttribute('data-albus-fid', bid)
    buttons.push({ selector: '[data-albus-fid="' + bid + '"]', label: label, kind: 'other' })
  }

  return JSON.stringify({
    url: location.href,
    title: document.title,
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

    const valor = ${val}
    const disparar = (n) => {
      n.dispatchEvent(new Event('input', { bubbles: true }))
      n.dispatchEvent(new Event('change', { bubbles: true }))
    }

    const setNativo = (n, v) => {
      const proto = n instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : n instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && desc.set) desc.set.call(n, v)
      else n.value = v
    }

    const tipo = (el.type || el.tagName).toLowerCase()

    if (tipo === 'radio') {
      const grupo = el.name
      const lista = grupo
        ? [...document.querySelectorAll('input[type=radio][name="' + grupo.replace(/"/g, '\\\\"') + '"]')]
        : [el]
      const elegido = lista.find((r) => r.value === valor)
        || lista.find((r) => (r.labels && r.labels[0] ? r.labels[0].textContent : '').trim() === valor)
      if (!elegido) return JSON.stringify({ ok: false, error: 'ninguna opción coincide' })
      elegido.click()
      return JSON.stringify({ ok: true })
    }

    if (tipo === 'checkbox') {
      const deseado = valor === 'true' || valor === 'Yes' || valor === 'yes'
      if (el.checked !== deseado) el.click()
      return JSON.stringify({ ok: true })
    }

    if (el instanceof HTMLSelectElement) {
      const porValor = [...el.options].find((o) => o.value === valor)
      const porTexto = [...el.options].find((o) => (o.textContent || '').trim() === valor)
      const opcion = porValor || porTexto
      if (!opcion) return JSON.stringify({ ok: false, error: 'ninguna opción coincide' })
      setNativo(el, opcion.value)
      disparar(el)
      return JSON.stringify({ ok: true })
    }

    if (el.isContentEditable) {
      el.focus()
      el.textContent = valor
      disparar(el)
      return JSON.stringify({ ok: true })
    }

    el.focus()
    setNativo(el, valor)
    disparar(el)
    el.blur()
    return JSON.stringify({ ok: true, escrito: el.value === valor })
  })()`
}

export function clickScript(selector: string): string {
  const sel = JSON.stringify(selector)
  return `(() => {
    const el = document.querySelector(${sel})
    if (!el) return JSON.stringify({ ok: false, error: 'no existe el botón' })
    el.scrollIntoView({ block: 'center' })
    el.click()
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
export function clickTextoScript(textos: string[], exacto = false): string {
  const lista = JSON.stringify(textos.map((t) => t.toLowerCase()))
  return `(() => {
    const buscados = ${lista}
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
    const accionable = (el) => {
      if (el.closest('thead, th')) return false
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false
      return true
    }

    const candidatos = [...document.querySelectorAll(
      'button, a, [role=button], [role=menuitem], [role=option], div[tabindex], span[role]'
    )].filter(visible).filter(accionable)

    const normal = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase()

    const apretar = (hit) => {
      hit.scrollIntoView({ block: 'center' })
      hit.click()
      return JSON.stringify({ ok: true, texto: (hit.textContent || '').trim().slice(0, 80) })
    }

    /**
     * Por precisión, no por orden de aparición: exacto gana sobre "empieza
     * con", y ese gana sobre "lo contiene". Sin esta escala, "create" elige
     * "Created" antes que "Create connection" solo porque está más arriba.
     */
    for (const b of buscados) {
      const hit = candidatos.find((el) => normal(el) === b)
      if (hit) return apretar(hit)
    }

    if (${exacto ? 'true' : 'false'}) {
      return JSON.stringify({ ok: false, error: 'no encontré exacto ' + buscados.join(' / ') })
    }

    for (const b of buscados) {
      const hit = candidatos.find((el) => normal(el).startsWith(b))
      if (hit) return apretar(hit)
    }

    for (const b of buscados) {
      const hit = candidatos.find((el) => normal(el).includes(b))
      if (hit) return apretar(hit)
    }

    return JSON.stringify({ ok: false, error: 'no encontré ' + buscados.join(' / ') })
  })()`
}

/**
 * El INVENTARIO: todo lo que se puede clickear o escribir, con un id nuestro.
 *
 * Esto es lo que el modelo MIRA. La diferencia con `clickTexto` es de fondo:
 * `clickTexto` va con una lista de textos esperados y falla si el sitio no dice
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
 */
export const INVENTARIO = `(() => {
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
  const texto = (el) => {
    const crudo = el.innerText !== undefined && el.innerText !== null ? el.innerText : el.textContent
    return (crudo || '')
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
  const capa = (el) => {
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
    if (modal === null || capa(el) >= capa(modal)) modal = el
  }

  const raiz = modal || document

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
  const SELECTOR_CLICK = [
    'button', 'a[href]', '[role=button]', '[role=menuitem]', '[role=option]',
    '[role=tab]', '[role=switch]', '[role=checkbox]', '[role=row]', '[role=gridcell]',
    '[role=link]', '[role=treeitem]', '[role=listitem]', 'summary', 'tr', 'li',
    'input[type=submit]', 'input[type=button]', 'input[type=checkbox]', 'input[type=radio]',
    '[onclick]', '[tabindex]:not([tabindex="-1"])'
  ].join(', ')

  const SELECTOR_ESCRIBIR = 'input:not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, select, [contenteditable=true]'

  /*
   * Un encabezado de tabla NO es un control, aunque tenga tabindex.
   *
   * El TH "Created" de Notion entraba al inventario por el selector de
   * tabindex, y desde ahí el agente lo podía elegir para "crear" algo. Un
   * BUTTON adentro de un th sí vale —son los de ordenar—; el th pelado no.
   *
   * (Sin backticks: este comentario vive DENTRO de un template literal.)
   */
  const esEncabezado = (el) => {
    const t = el.tagName
    if (t === 'TH' || t === 'THEAD') return true
    if (!el.closest('thead')) return false
    return !['BUTTON', 'A'].includes(t) && el.getAttribute('role') !== 'button'
  }

  const items = []
  let n = 0

  const agregar = (el, accion) => {
    if (el.hasAttribute('data-albus-cid')) return
    if (esEncabezado(el)) return
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
    const heredado = (attr) => {
      let n = el
      for (let i = 0; i < 3 && n; i++, n = n.parentElement) {
        const v = n.getAttribute && n.getAttribute(attr)
        if (v) return v
      }
      return ''
    }

    // Todo lo que identifica al elemento para un humano que mira la pantalla.
    const etiqueta = [
      texto(el).slice(0, 120),
      heredado('aria-label'),
      heredado('title'),
      el.placeholder || '',
      el.getAttribute('name') || ''
    ].filter(Boolean).join(' | ')

    items.push({
      cid: cid,
      accion: accion,
      tag: el.tagName.toLowerCase(),
      rol: el.getAttribute('role') || (el.type || ''),
      texto: etiqueta.slice(0, 200),
      valor: accion === 'escribir' ? String(el.value || '').slice(0, 60) : '',
      href: (el.getAttribute('href') || '').slice(0, 120),
      deshabilitado: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    })
  }

  for (const el of raiz.querySelectorAll(SELECTOR_CLICK)) {
    if (visible(el)) agregar(el, 'click')
  }
  for (const el of raiz.querySelectorAll(SELECTOR_ESCRIBIR)) {
    if (visible(el)) agregar(el, 'escribir')
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
  const areaVentana = (window.innerWidth || 1280) * (window.innerHeight || 900)

  const candidatosPointer = [...raiz.querySelectorAll(
    'div, span, li, tr, td, p, h1, h2, h3, section, article, label, img, svg'
  )].filter(visible)

  for (const el of candidatosPointer) {
    if (el.hasAttribute('data-albus-cid')) continue
    if (el.parentElement && el.parentElement.closest('[data-albus-cid]')) continue
    if (getComputedStyle(el).cursor !== 'pointer') continue

    const r = el.getBoundingClientRect()
    if (r.width * r.height > areaVentana * 0.6) continue

    if (texto(el) !== '' || el.getAttribute('aria-label')) agregar(el, 'click')
  }

  // Sin texto y sin ser un campo no le dice nada a nadie: gasta tokens al pedo.
  const utiles = items.filter((i) => i.texto !== '' || i.accion === 'escribir')

  /*
   * El recorte por CERCANÍA A LA PANTALLA, no por orden en el DOM.
   *
   * Con la red de pointer entran bastantes más elementos, y cortar los últimos
   * 30 del documento puede tirar justo el botón que importa —que suele estar
   * abajo, después de todo el menú lateral—. Lo que está a la vista primero.
   */
  const alto = window.innerHeight || 900
  const enPantalla = (i) => i.rect.y >= -50 && i.rect.y <= alto
  const ordenados = [
    ...utiles.filter(enPantalla),
    ...utiles.filter((i) => !enPantalla(i))
  ]

  return JSON.stringify({
    url: location.href,
    title: document.title,
    enModal: !!modal,
    texto: (document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 2500),
    recortado: ordenados.length > 150,
    items: ordenados.slice(0, 150)
  })
})()`

/**
 * Click por el id que estampó el inventario.
 *
 * El modelo devuelve un `cid` —un valor de una lista cerrada que generamos
 * nosotros—, nunca un selector ni JavaScript. Si inventa uno que no existe,
 * esto falla ruidoso en vez de clickear cualquier cosa.
 */
export function clickPorIdScript(cid: string): string {
  const id = JSON.stringify(cid)
  return `(() => {
    const el = document.querySelector('[data-albus-cid=' + JSON.stringify(${id}) + ']')
    if (!el) return JSON.stringify({ ok: false, error: 'ese id ya no está en la página' })

    // innerText y no textContent, por lo mismo que en el inventario: si no, el
    // log dice clickeé "AAlbus AgentRead, update, and insert contentJorge Diaz"
    // y el usuario no reconoce qué apretó.
    const crudo = el.innerText !== undefined && el.innerText !== null ? el.innerText : el.textContent
    const visto = (crudo || '').split('\\n').map((l) => l.trim()).filter(Boolean).join(' · ')

    el.scrollIntoView({ block: 'center' })
    el.click()
    return JSON.stringify({ ok: true, texto: visto.slice(0, 80) })
  })()`
}

/** Escribe en el elemento que el inventario marcó con ese id. */
export function escribirPorIdScript(cid: string, valor: string): string {
  const id = JSON.stringify(cid)
  const val = JSON.stringify(valor)
  return `(() => {
    const el = document.querySelector('[data-albus-cid=' + JSON.stringify(${id}) + ']')
    if (!el) return JSON.stringify({ ok: false, error: 'ese id ya no está en la página' })

    const valor = ${val}
    if (el.isContentEditable) {
      el.focus()
      el.textContent = valor
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
    if (desc && desc.set) desc.set.call(el, valor)
    else el.value = valor
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return JSON.stringify({ ok: true, escrito: el.value === valor })
  })()`
}

/** ¿Está alguno de estos textos en la página? Para esperar a que cargue. */
export function hayTextoScript(textos: string[]): string {
  const lista = JSON.stringify(textos.map((t) => t.toLowerCase()))
  return `(() => {
    const cuerpo = (document.body.innerText || '').toLowerCase()
    const cual = ${lista}.find((t) => cuerpo.includes(t)) || ''
    return JSON.stringify({ ok: cual !== '', cual: cual })
  })()`
}

/**
 * Saca de la página el primer texto que matchee el patrón. Se usa para leer el
 * token que Notion pinta en pantalla después de crear la integración.
 *
 * El patrón viaja como string y se compila del otro lado. NO se interpola nada
 * del usuario: los patrones son constantes de `notion-auto.ts`.
 */
export function extraerPatronScript(patron: string, bandera = ''): string {
  return `(() => {
    const re = new RegExp(${JSON.stringify(patron)}, ${JSON.stringify(bandera)})

    // Primero los inputs: Notion muestra el secreto dentro de un <input readonly>,
    // y su valor NO está en innerText.
    for (const el of document.querySelectorAll('input, textarea')) {
      const v = el.value || ''
      const m = v.match(re)
      if (m) return JSON.stringify({ ok: true, valor: m[0], donde: 'input' })
    }

    const texto = document.body.innerText || ''
    const m = texto.match(re)
    return m
      ? JSON.stringify({ ok: true, valor: m[0], donde: 'texto' })
      : JSON.stringify({ ok: false, error: 'no encontré el patrón en la página' })
  })()`
}

/** Escribe en el primer input visible que matchee el placeholder o la etiqueta. */
export function escribirPorEtiquetaScript(pistas: string[], valor: string): string {
  return `(() => {
    const pistas = ${JSON.stringify(pistas.map((p) => p.toLowerCase()))}
    const val = ${JSON.stringify(valor)}
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 || r.height > 0
    }

    const campos = [...document.querySelectorAll('input[type=text], input:not([type]), textarea')]
      .filter(visible)

    const coincide = (el) => {
      const s = [el.placeholder, el.getAttribute('aria-label'), el.name, el.id]
        .filter(Boolean).join(' ').toLowerCase()
      return pistas.some((p) => s.includes(p))
    }

    const el = campos.find(coincide) || campos[0]
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
