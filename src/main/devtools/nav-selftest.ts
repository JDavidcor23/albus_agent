import { app } from 'electron'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBrowserPage } from '../browser/page'
import {
  clickInteligente,
  lograrObjetivo,
  pasoConModelo,
  type CorrerModelo
} from '../connections/navigate-llm'

/**
 * Los asserts de "mirar la página en vez de adivinarla".
 *
 *   npm run nav:check
 *
 * Corre contra un HTML propio que imita lo que rompió la conexión de Notion:
 * un botón que NO dice lo que la automatización esperaba, y un menú de tres
 * puntos sin ninguna letra adentro. Contra ese fixture, el camino viejo tiene
 * que fallar y el nuevo tiene que resolverlo.
 *
 * El modelo se reemplaza por uno falso y determinista: lo que se está probando
 * es el ARNÉS —que el inventario vea, que el id se valide, que el click caiga
 * donde debe—, no si Claude acierta. Un assert que depende de la respuesta de
 * un LLM no es un assert, es una encuesta.
 */

let pasados = 0
let fallados = 0

function check(nombre: string, real: unknown, esperado: unknown): void {
  const ok = JSON.stringify(real) === JSON.stringify(esperado)
  if (ok) {
    pasados++
    console.log(`  ok    ${nombre}`)
  } else {
    fallados++
    console.log(`  FALLA ${nombre}`)
    console.log(`          esperado ${JSON.stringify(esperado)}`)
    console.log(`          real     ${JSON.stringify(real)}`)
  }
}

/**
 * El caso real que rompió Notion, reducido a lo mínimo:
 *
 * - El botón de crear NO dice "New integration": dice "Crear conexión". Es lo
 *   que pasa cuando el sitio renombra o traduce.
 * - El menú "⋯" no tiene texto: sólo un aria-label. Un click por texto no lo
 *   puede encontrar NUNCA, por más strings que se le agreguen a la lista.
 * - Hay un botón "Eliminar workspace" para verificar que el arnés no lo toque.
 */
const FIXTURE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Integraciones — fixture</title></head>
<body>
  <header><button id="ruido">Buscar</button></header>
  <main>
    <h1>Tus integraciones</h1>
    <button id="crear" class="x1">Crear conexión</button>
    <button id="menu" aria-label="Más acciones"></button>
    <button id="peligro">Eliminar workspace</button>
    <button id="apagado" disabled>Guardar</button>
    <input id="nombre" placeholder="Nombre de la integración" />

    <div id="secreto" style="display:none">ntn_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8</div>
  </main>
  <script>
    // Dos pasos, como el modal real: el nombre NO alcanza, hay que confirmar.
    document.getElementById('crear').addEventListener('click', () => {
      const b = document.createElement('button')
      b.id = 'confirmar'
      b.textContent = 'Create connection'
      b.addEventListener('click', () => {
        if (document.getElementById('nombre').value.trim() === '') return
        document.getElementById('secreto').style.display = 'block'
        b.remove()
      })
      document.querySelector('main').appendChild(b)
    })
  </script>
</body></html>`

/**
 * La trampa exacta que rompió Notion: un encabezado de tabla que dice
 * "Created", junto al botón "Create connection" que sí había que apretar.
 *
 * Buscando "create" con `includes()`, ganaba el `<th>` por estar antes en el
 * DOM — y `clickTexto` devolvía **ok**. Ese falso positivo es lo peor que puede
 * pasar: el que llama cree que avanzó y se saltea el escalón del agente.
 */
const FIXTURE_TRAMPA = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Trampa</title></head>
<body>
  <table><thead><tr>
    <th tabindex="0">Connection</th><th tabindex="0">Owner</th><th tabindex="0">Created</th>
  </tr></thead><tbody><tr><td>No connections yet</td></tr></tbody></table>
  <button id="bueno">Create connection</button>
</body></html>`

/**
 * El caso que hizo fallar la tercera corrida real: la FILA de una integración
 * en una tabla estilo React.
 *
 * No tiene `tabindex`, no tiene atributo `onclick`, no tiene `role`. React
 * registra el handler por delegación y no deja NADA en el DOM. Lo único que la
 * delata es `cursor: pointer`, que sí está porque si no el usuario no sabría
 * que se puede clickear.
 *
 * El agente lo dijo textual: "su fila no está en el inventario de elementos
 * clickeables; no hay un id para abrirla sin inventar uno".
 */
const FIXTURE_SPA = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Connections</title>
<style>
  .fila { cursor: pointer; padding: 8px; }
  .celda { cursor: pointer; }
  .estatico { cursor: default; }
</style></head>
<body>
  <h1>Connections</h1>
  <table>
    <thead><tr><th>Connection</th><th>Owner</th><th>Created</th></tr></thead>
    <tbody>
      <!-- Sin tabindex, sin onclick, sin role. Solo cursor:pointer. -->
      <tr class="fila"><td class="celda">Albus Agent</td><td>Jorge Diaz</td><td>hoy</td></tr>
      <tr class="fila"><td class="celda">Otra integración</td><td>Jorge Diaz</td><td>ayer</td></tr>
    </tbody>
  </table>
  <p class="estatico">Texto que no se clickea y no debe entrar como acción.</p>
  <div class="fila" aria-label="Abrir menú"><span class="celda">···</span></div>
</body></html>`

/** Un modelo falso: elige por una regla fija, sin red y sin cuota. */
function modeloDe(elegir: (items: { cid: string; texto: string }[]) => string | null): CorrerModelo {
  return async (prompt: string) => {
    // Se parsea el mismo prompt que ve el modelo real: si el inventario no
    // llegó al prompt, esto no encuentra nada y el assert falla. Es a propósito.
    const items = [...prompt.matchAll(/^(c\d+)\t\w+\t[^\t]*\t(.*)$/gm)].map((m) => ({
      cid: m[1],
      texto: m[2]
    }))
    const cid = elegir(items)
    return JSON.stringify({ cid, accion: 'click', razon: 'fixture' })
  }
}

export async function runNavSelfTest(): Promise<boolean> {
  console.log('\n══ AUTOCHEQUEO DE NAVEGACIÓN (el modelo mira la página) ══')

  const tmp = join(app.getPath('userData'), 'nav-selftest')
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  const archivo = join(tmp, 'fixture.html')
  await writeFile(archivo, FIXTURE, 'utf8')

  const browser = createBrowserPage({ visible: false })

  try {
    await browser.open(pathToFileURL(archivo).href)

    // ── 1 · el inventario ve lo que el click por texto no puede ver ─────────
    console.log('\n── assert 1 · el inventario ve la página, incluso lo que no tiene texto')

    const inv = await browser.inventario()

    check('el inventario trae items', inv.items.length > 0, true)
    check(
      've el botón renombrado',
      inv.items.some((i) => i.texto.includes('Crear conexión')),
      true
    )
    check(
      've el menú SIN texto, por su aria-label',
      inv.items.some((i) => i.texto.includes('Más acciones')),
      true
    )
    check(
      'marca el botón deshabilitado como tal',
      inv.items.find((i) => i.texto.includes('Guardar'))?.deshabilitado,
      true
    )
    check(
      'el campo de texto entra como "escribir", no como "click"',
      inv.items.find((i) => i.texto.includes('Nombre de la integración'))?.accion,
      'escribir'
    )
    check(
      'cada item trae coordenadas para cruzar con la captura',
      inv.items.every((i) => typeof i.rect.x === 'number' && i.rect.w > 0),
      true
    )

    // ── 2 · el camino viejo falla, que es EL bug que rompió Notion ──────────
    console.log('\n── assert 2 · el click por texto conocido falla contra un botón renombrado')

    let falloComoSeEsperaba = false
    try {
      await browser.clickTexto(['new integration', 'nueva integración'], false, 1500)
    } catch {
      falloComoSeEsperaba = true
    }
    check('“new integration” no existe en esta página', falloComoSeEsperaba, true)

    // ── 3 · el modelo mirando SÍ lo resuelve ───────────────────────────────
    console.log('\n── assert 3 · mirando la página, el mismo objetivo se resuelve')

    const r = await clickInteligente(
      browser,
      ['new integration', 'nueva integración'],
      { objetivo: 'Crear una integración nueva.' },
      modeloDe((items) => items.find((i) => i.texto.includes('Crear conexión'))?.cid ?? null),
      null,
      1200
    )

    check('el escalón del modelo resolvió el paso', r.ok, true)
    check('y dice que lo resolvió mirando', r.detalle.includes('mirando la pantalla'), true)
    check(
      'el click llegó de verdad: apareció el botón de confirmar',
      (await browser.inventario()).items.some((i) => i.texto.includes('Create connection')),
      true
    )

    // ── 4 · el modelo no puede inventar dónde clickear ──────────────────────
    console.log('\n── assert 4 · un id inventado se rechaza ANTES de tocar la página')

    const inventado = await pasoConModelo(
      browser,
      { objetivo: 'Cualquier cosa.' },
      modeloDe(() => 'c9999')
    )
    check('un cid fuera del inventario no se ejecuta', inventado.ok, false)
    check('y se dice exactamente por qué', inventado.detalle.includes('inventó el id'), true)

    // ── 5 · "no sé" es una respuesta válida ────────────────────────────────
    console.log('\n── assert 5 · decir que no sabe es correcto; clickear cualquier cosa no')

    const nose = await pasoConModelo(browser, { objetivo: 'Algo que no está.' }, modeloDe(() => null))
    check('un null no clickea nada', nose.ok, false)

    // ── 6 · lo deshabilitado no se aprieta ─────────────────────────────────
    console.log('\n── assert 6 · un botón deshabilitado no se clickea aunque lo elijan')

    const apagado = await pasoConModelo(
      browser,
      { objetivo: 'Guardar.' },
      modeloDe((items) => items.find((i) => i.texto.includes('Guardar'))?.cid ?? null)
    )
    check('no se ejecuta sobre un deshabilitado', apagado.ok, false)
    check('y se explica', apagado.detalle.includes('deshabilitado'), true)

    // ── 7 · la miniatura viaja en data:, no como ruta ───────────────────────
    console.log('\n── assert 7 · la captura sale en data: porque el CSP bloquea file://')

    const mini = await browser.capturaMiniatura(320)
    check('empieza con el data URI de una imagen', mini.startsWith('data:image/'), true)
    check('y trae bytes de verdad', mini.length > 1000, true)

    // ── 8 · el falso positivo que saltaba el escalón del agente ─────────────
    console.log('\n── assert 8 · "create" no puede clickear el <th> "Created"')

    const trampa = join(tmp, 'trampa.html')
    await writeFile(trampa, FIXTURE_TRAMPA, 'utf8')
    await browser.open(pathToFileURL(trampa).href)

    const cual = await browser.clickTexto(['create'], false, 2000)
    check('elige el botón que crea, no el encabezado de la tabla', cual, 'Create connection')
    check(
      'el <th> "Created" ni entra al inventario, tenga el tabindex que tenga',
      (await browser.inventario()).items.some((i) => i.texto.trim() === 'Created'),
      false
    )

    // ── 9 · el BUCLE: un objetivo puede necesitar varias acciones ───────────
    console.log('\n── assert 9 · escribir el nombre NO crea la integración; falta confirmar')

    await browser.open(pathToFileURL(archivo).href)

    // Un modelo falso que hace lo mismo que haría el real: abre, escribe,
    // confirma. Si el bucle no existiera, se quedaría en la primera acción.
    const vueltas: string[] = []
    const modeloEnBucle: CorrerModelo = async (prompt: string) => {
      const items = [...prompt.matchAll(/^(c\d+)\t(\w+)\t[^\t]*\t(.*)$/gm)].map((m) => ({
        cid: m[1],
        accion: m[2],
        texto: m[3]
      }))
      const buscar = (t: string): string | null =>
        items.find((i) => i.texto.includes(t))?.cid ?? null

      // El secreto ya visible = objetivo cumplido.
      if (prompt.includes('ntn_')) {
        vueltas.push('listo')
        return JSON.stringify({ cid: null, accion: 'listo', razon: 'ya está creada' })
      }

      const confirmar = buscar('Create connection')
      if (confirmar !== null) {
        vueltas.push('confirmar')
        return JSON.stringify({ cid: confirmar, accion: 'click', razon: 'confirmar' })
      }

      const campo = items.find((i) => i.texto.includes('Nombre de la integración'))
      if (campo !== undefined && !prompt.includes('escribí')) {
        vueltas.push('escribir')
        return JSON.stringify({ cid: campo.cid, accion: 'escribir', razon: 'el nombre' })
      }

      vueltas.push('abrir')
      return JSON.stringify({ cid: buscar('Crear conexión'), accion: 'click', razon: 'abrir' })
    }

    const logrado = await lograrObjetivo(
      browser,
      { objetivo: 'Crear la integración "Albus Agent" de punta a punta.', valor: 'Albus Agent' },
      modeloEnBucle,
      { maxPasos: 6 }
    )

    check('el objetivo se cumplió', logrado.ok, true)
    check('el modelo cerró con "listo", no por agotar intentos', logrado.listo, true)
    check('hizo falta más de una acción', vueltas.length > 1, true)
    check(
      'el token quedó visible: la confirmación se apretó de verdad',
      (await browser.extraerPatron('ntn_[A-Za-z0-9]{20,}')) !== null,
      true
    )

    // ── 10 · "imposible" corta el bucle en vez de gastar los N intentos ─────
    console.log('\n── assert 10 · "no se puede desde acá" no se reintenta')

    let llamadas = 0
    const seRinde: CorrerModelo = async () => {
      llamadas++
      return JSON.stringify({ cid: null, accion: 'imposible', razon: 'falta crearla antes' })
    }

    const imposible = await lograrObjetivo(browser, { objetivo: 'Algo que no se puede.' }, seRinde, {
      maxPasos: 5
    })
    check('devuelve que no se puede', imposible.imposible, true)
    check('y preguntó UNA sola vez, no cinco', llamadas, 1)

    // ── 12 · el caso React: sin tabindex, sin onclick, sin role ─────────────
    console.log('\n── assert 12 · la fila de una tabla React entra al inventario')

    const spa = join(tmp, 'spa.html')
    await writeFile(spa, FIXTURE_SPA, 'utf8')
    await browser.open(pathToFileURL(spa).href)

    const invSpa = await browser.inventario()
    const fila = invSpa.items.find((i) => i.texto.includes('Albus Agent'))

    check('la fila de "Albus Agent" TIENE un id para clickear', fila !== undefined, true)
    check('y es una acción de click', fila?.accion, 'click')
    check(
      'el menú "···" hecho con divs también entra, por su aria-label',
      invSpa.items.some((i) => i.texto.includes('Abrir menú')),
      true
    )
    check(
      'el texto con cursor:default NO entra como accionable',
      invSpa.items.some((i) => i.texto.includes('Texto que no se clickea')),
      false
    )
    check(
      'los encabezados siguen afuera',
      invSpa.items.some((i) => i.texto.trim() === 'Created'),
      false
    )

    // Se toma el elemento más interno, no la fila Y sus tres celdas: si no, el
    // inventario se llena de formas distintas de decir lo mismo.
    const duplicados = invSpa.items.filter((i) => i.texto.includes('Albus Agent')).length
    check('no entra la fila Y sus celdas por separado', duplicados, 1)

    // Y el click llega de verdad: el id sirve, no es sólo un renglón lindo.
    const clickeado = await browser.clickPorId(fila!.cid)
    check('el click por ese id no explota', clickeado.includes('Albus Agent'), true)

    // ── 13 · dos overlays apilados: gana el de arriba ───────────────────────
    console.log('\n── assert 13 · con un flyout sobre un menú, el inventario es el del flyout')

    const apilado = join(tmp, 'apilado.html')
    await writeFile(
      apilado,
      `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Apilados</title></head>
       <body>
         <button id="fondo">Botón del fondo</button>
         <div role="menu" style="position:fixed;z-index:10;width:300px;height:300px;background:#222">
           <button>Move to</button><button>Trash</button><button>Connections · None</button>
         </div>
         <div role="menu" style="position:fixed;left:320px;z-index:20;width:300px;height:300px;background:#333">
           <button>Search for connections</button><button>Albus Agent</button>
         </div>
       </body></html>`,
      'utf8'
    )
    await browser.open(pathToFileURL(apilado).href)

    const invApilado = await browser.inventario()

    check('reconoce que hay un overlay', invApilado.enModal, true)
    check(
      'el inventario ES el del flyout de arriba (z-index 20)',
      invApilado.items.some((i) => i.texto.includes('Albus Agent')),
      true
    )
    check(
      'y NO el del menú de abajo, que era el bucle',
      invApilado.items.some((i) => i.texto.includes('Connections · None')),
      false
    )
    check(
      'el fondo tampoco entra',
      invApilado.items.some((i) => i.texto.includes('Botón del fondo')),
      false
    )

    // ── 14 · el permiso que el agente NO puede dar ──────────────────────────
    console.log('\n── assert 14 · lo que el agente no puede, se le pide al humano y se verifica')

    const { conectable: conServicio } = await import('../connections/servicios')
    const notion = conServicio('notion')!

    check('Notion declara cómo verificarse por API', typeof notion.verificar, 'function')
    check('y qué pedirle al humano si el agente no puede', notion.pedirAlHumano !== undefined, true)
    check(
      'las instrucciones son pasos concretos, no un párrafo',
      (notion.pedirAlHumano?.instrucciones.length ?? 0) >= 3,
      true
    )
    check(
      'y avisan que Albus se entera solo: no hay botón de "ya está"',
      notion.pedirAlHumano?.instrucciones.join(' ').includes('solo'),
      true
    )

    // ── 11 · un servicio es DATOS, no un archivo de código ──────────────────
    console.log('\n── assert 11 · sumar un servicio son cinco líneas en una tabla')

    const { CONECTABLES, conectable } = await import('../connections/servicios')
    const { textoObjetivo, urlObjetivo } = await import('../connections/agente-conexion')
    const ids = Object.keys(CONECTABLES)

    check('hay más de un servicio conectable con el MISMO motor', ids.length > 1, true)
    check('y Supabase es uno, sin haber escrito supabase-auto.ts', ids.includes('supabase'), true)

    // Todos cumplen la misma forma. Si alguno necesitara un campo propio,
    // el diseño ya estaría filtrando código específico por la puerta de atrás.
    const bienFormados = ids.every((id) => {
      const s = conectable(id)
      return (
        s !== null &&
        s.url.startsWith('https://') &&
        s.objetivos.length > 0 &&
        s.objetivos.every((o) => textoObjetivo(o).length > 40) &&
        s.patronSecreto.length > 3
      )
    })
    check('todos tienen url + objetivos + patrón, y nada más', bienFormados, true)

    // El objetivo dice QUÉ lograr, no qué apretar. Un selector CSS o una línea
    // de JavaScript adentro sería código disfrazado de dato — y volvería a
    // atar el objetivo al HTML de hoy del servicio, que es lo que se rompía.
    const CODIGO = /querySelector|document\.|getElementById|\[data-|\.css-|<\/?\w+>/
    const sinSelectores = ids.every((id) =>
      conectable(id)!.objetivos.every((o) => !CODIGO.test(textoObjetivo(o)))
    )
    check('ningún objetivo trae selectores ni HTML: son intenciones', sinSelectores, true)

    /**
     * Y el que hubiera evitado la falla real: un objetivo que manda a OTRA
     * página tiene que traer su `url` como campo, para que navegue el motor.
     * Escrita adentro del texto, el agente contesta —con razón— que desde ahí
     * ningún elemento lo lleva a esa página: navegar no es una acción suya.
     */
    const navegacionDeclarada = ids.every((id) =>
      conectable(id)!.objetivos.every(
        (o) => urlObjetivo(o) !== null || !/\bir a\b.*https?:\/\//i.test(textoObjetivo(o))
      )
    )
    check('ningún objetivo le pide al agente que "vaya a" una URL', navegacionDeclarada, true)
    check(
      'el de compartir la base de Notion declara su url',
      urlObjetivo(conectable('notion')!.objetivos[1]) !== null,
      true
    )
  } finally {
    await browser.close()
  }

  const total = pasados + fallados
  console.log('\n' + '='.repeat(60))
  console.log(
    `NAVEGACIÓN CON MODELO   ${pasados}/${total} ${fallados === 0 ? '✓' : `· ${fallados} FALLA(S)`}`
  )
  console.log('='.repeat(60) + '\n')

  return fallados === 0
}
