import { app } from 'electron'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBrowserPage } from '../browser/page'
import { achieveGoal, smartClick, stepWithModel, type RunModel } from '../connections/navigate-llm'

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

let passed = 0
let failed = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    console.log(`  FALLA ${name}`)
    console.log(`          esperado ${JSON.stringify(expected)}`)
    console.log(`          real     ${JSON.stringify(actual)}`)
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
 * DOM — y `clickText` devolvía **ok**. Ese falso positivo es lo peor que puede
 * pasar: el que llama cree que avanzó y se saltea el escalón del agente.
 */
const FIXTURE_TRAP = `<!doctype html>
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
function modelThatPicks(pick: (items: { cid: string; text: string }[]) => string | null): RunModel {
  return async (prompt: string) => {
    // Se parsea el mismo prompt que ve el modelo real: si el inventario no
    // llegó al prompt, esto no encuentra nada y el assert falla. Es a propósito.
    const items = [...prompt.matchAll(/^(c\d+)\t\w+\t[^\t]*\t(.*)$/gm)].map((m) => ({
      cid: m[1],
      text: m[2]
    }))
    const cid = pick(items)
    return JSON.stringify({ cid, action: 'click', reason: 'fixture' })
  }
}

export async function runNavSelfTest(): Promise<boolean> {
  console.log('\n══ AUTOCHEQUEO DE NAVEGACIÓN (el modelo mira la página) ══')

  const tmp = join(app.getPath('userData'), 'nav-selftest')
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  const file = join(tmp, 'fixture.html')
  await writeFile(file, FIXTURE, 'utf8')

  const browser = createBrowserPage({ visible: false })

  try {
    await browser.open(pathToFileURL(file).href)

    // ── 1 · el inventario ve lo que el click por texto no puede ver ─────────
    console.log('\n── assert 1 · el inventario ve la página, incluso lo que no tiene texto')

    const inv = await browser.inventory()

    check('el inventario trae items', inv.items.length > 0, true)
    check(
      've el botón renombrado',
      inv.items.some((i) => i.text.includes('Crear conexión')),
      true
    )
    check(
      've el menú SIN texto, por su aria-label',
      inv.items.some((i) => i.text.includes('Más acciones')),
      true
    )
    check(
      'marca el botón deshabilitado como tal',
      inv.items.find((i) => i.text.includes('Guardar'))?.disabled,
      true
    )
    check(
      'el campo de texto entra como "type", no como "click"',
      inv.items.find((i) => i.text.includes('Nombre de la integración'))?.action,
      'type'
    )
    check(
      'cada item trae coordenadas para cruzar con la captura',
      inv.items.every((i) => typeof i.rect.x === 'number' && i.rect.w > 0),
      true
    )

    // ── 2 · el camino viejo falla, que es EL bug que rompió Notion ──────────
    console.log('\n── assert 2 · el click por texto conocido falla contra un botón renombrado')

    let failedAsExpected = false
    try {
      await browser.clickText(['new integration', 'nueva integración'], false, 1500)
    } catch {
      failedAsExpected = true
    }
    check('“new integration” no existe en esta página', failedAsExpected, true)

    // ── 3 · el modelo mirando SÍ lo resuelve ───────────────────────────────
    console.log('\n── assert 3 · mirando la página, el mismo objetivo se resuelve')

    const r = await smartClick(
      browser,
      ['new integration', 'nueva integración'],
      { goal: 'Crear una integración nueva.' },
      modelThatPicks((items) => items.find((i) => i.text.includes('Crear conexión'))?.cid ?? null),
      null,
      1200
    )

    check('el escalón del modelo resolvió el paso', r.ok, true)
    check('y dice que lo resolvió mirando', r.detail.includes('mirando la pantalla'), true)
    check(
      'el click llegó de verdad: apareció el botón de confirmar',
      (await browser.inventory()).items.some((i) => i.text.includes('Create connection')),
      true
    )

    // ── 4 · el modelo no puede inventar dónde clickear ──────────────────────
    console.log('\n── assert 4 · un id inventado se rechaza ANTES de tocar la página')

    const invented = await stepWithModel(
      browser,
      { goal: 'Cualquier cosa.' },
      modelThatPicks(() => 'c9999')
    )
    check('un cid fuera del inventario no se ejecuta', invented.ok, false)
    check('y se dice exactamente por qué', invented.detail.includes('inventó el id'), true)

    // ── 5 · "no sé" es una respuesta válida ────────────────────────────────
    console.log('\n── assert 5 · decir que no sabe es correcto; clickear cualquier cosa no')

    const dontKnow = await stepWithModel(
      browser,
      { goal: 'Algo que no está.' },
      modelThatPicks(() => null)
    )
    check('un null no clickea nada', dontKnow.ok, false)

    // ── 6 · lo deshabilitado no se aprieta ─────────────────────────────────
    console.log('\n── assert 6 · un botón deshabilitado no se clickea aunque lo elijan')

    const disabledPick = await stepWithModel(
      browser,
      { goal: 'Guardar.' },
      modelThatPicks((items) => items.find((i) => i.text.includes('Guardar'))?.cid ?? null)
    )
    check('no se ejecuta sobre un deshabilitado', disabledPick.ok, false)
    check('y se explica', disabledPick.detail.includes('deshabilitado'), true)

    // ── 7 · la miniatura viaja en data:, no como ruta ───────────────────────
    console.log('\n── assert 7 · la captura sale en data: porque el CSP bloquea file://')

    const thumb = await browser.thumbnail(320)
    check('empieza con el data URI de una imagen', thumb.startsWith('data:image/'), true)
    check('y trae bytes de verdad', thumb.length > 1000, true)

    // ── 8 · el falso positivo que saltaba el escalón del agente ─────────────
    console.log('\n── assert 8 · "create" no puede clickear el <th> "Created"')

    const trap = join(tmp, 'trampa.html')
    await writeFile(trap, FIXTURE_TRAP, 'utf8')
    await browser.open(pathToFileURL(trap).href)

    const which = await browser.clickText(['create'], false, 2000)
    check('elige el botón que crea, no el encabezado de la tabla', which, 'Create connection')
    check(
      'el <th> "Created" ni entra al inventario, tenga el tabindex que tenga',
      (await browser.inventory()).items.some((i) => i.text.trim() === 'Created'),
      false
    )

    // ── 9 · el BUCLE: un objetivo puede necesitar varias acciones ───────────
    console.log('\n── assert 9 · escribir el nombre NO crea la integración; falta confirmar')

    await browser.open(pathToFileURL(file).href)

    // Un modelo falso que hace lo mismo que haría el real: abre, escribe,
    // confirma. Si el bucle no existiera, se quedaría en la primera acción.
    const turns: string[] = []
    const loopingModel: RunModel = async (prompt: string) => {
      const items = [...prompt.matchAll(/^(c\d+)\t(\w+)\t[^\t]*\t(.*)$/gm)].map((m) => ({
        cid: m[1],
        action: m[2],
        text: m[3]
      }))
      const find = (t: string): string | null => items.find((i) => i.text.includes(t))?.cid ?? null

      // El secreto ya visible = objetivo cumplido.
      if (prompt.includes('ntn_')) {
        turns.push('done')
        return JSON.stringify({ cid: null, action: 'done', reason: 'ya está creada' })
      }

      const confirm = find('Create connection')
      if (confirm !== null) {
        turns.push('confirm')
        return JSON.stringify({ cid: confirm, action: 'click', reason: 'confirmar' })
      }

      const field = items.find((i) => i.text.includes('Nombre de la integración'))
      if (field !== undefined && !prompt.includes('escribí')) {
        turns.push('type')
        return JSON.stringify({ cid: field.cid, action: 'type', reason: 'el nombre' })
      }

      turns.push('open')
      return JSON.stringify({ cid: find('Crear conexión'), action: 'click', reason: 'abrir' })
    }

    const achieved = await achieveGoal(
      browser,
      { goal: 'Crear la integración "Albus Agent" de punta a punta.', value: 'Albus Agent' },
      loopingModel,
      { maxSteps: 6 }
    )

    check('el objetivo se cumplió', achieved.ok, true)
    check('el modelo cerró con "done", no por agotar intentos', achieved.done, true)
    check('hizo falta más de una acción', turns.length > 1, true)
    check(
      'el token quedó visible: la confirmación se apretó de verdad',
      (await browser.extractPattern('ntn_[A-Za-z0-9]{20,}')) !== null,
      true
    )

    // ── 10 · "imposible" corta el bucle en vez de gastar los N intentos ─────
    console.log('\n── assert 10 · "no se puede desde acá" no se reintenta')

    let calls = 0
    const givesUp: RunModel = async () => {
      calls++
      return JSON.stringify({ cid: null, action: 'impossible', reason: 'falta crearla antes' })
    }

    const impossible = await achieveGoal(browser, { goal: 'Algo que no se puede.' }, givesUp, {
      maxSteps: 5
    })
    check('devuelve que no se puede', impossible.impossible, true)
    check('y preguntó UNA sola vez, no cinco', calls, 1)

    // ── 12 · el caso React: sin tabindex, sin onclick, sin role ─────────────
    console.log('\n── assert 12 · la fila de una tabla React entra al inventario')

    const spa = join(tmp, 'spa.html')
    await writeFile(spa, FIXTURE_SPA, 'utf8')
    await browser.open(pathToFileURL(spa).href)

    const spaInv = await browser.inventory()
    const row = spaInv.items.find((i) => i.text.includes('Albus Agent'))

    check('la fila de "Albus Agent" TIENE un id para clickear', row !== undefined, true)
    check('y es una acción de click', row?.action, 'click')
    check(
      'el menú "···" hecho con divs también entra, por su aria-label',
      spaInv.items.some((i) => i.text.includes('Abrir menú')),
      true
    )
    check(
      'el texto con cursor:default NO entra como accionable',
      spaInv.items.some((i) => i.text.includes('Texto que no se clickea')),
      false
    )
    check(
      'los encabezados siguen afuera',
      spaInv.items.some((i) => i.text.trim() === 'Created'),
      false
    )

    // Se toma el elemento más interno, no la fila Y sus tres celdas: si no, el
    // inventario se llena de formas distintas de decir lo mismo.
    const duplicates = spaInv.items.filter((i) => i.text.includes('Albus Agent')).length
    check('no entra la fila Y sus celdas por separado', duplicates, 1)

    // Y el click llega de verdad: el id sirve, no es sólo un renglón lindo.
    const clicked = await browser.clickById(row!.cid)
    check('el click por ese id no explota', clicked.includes('Albus Agent'), true)

    // ── 13 · dos overlays apilados: gana el de arriba ───────────────────────
    console.log('\n── assert 13 · con un flyout sobre un menú, el inventario es el del flyout')

    const stacked = join(tmp, 'apilado.html')
    await writeFile(
      stacked,
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
    await browser.open(pathToFileURL(stacked).href)

    const stackedInv = await browser.inventory()

    check('reconoce que hay un overlay', stackedInv.inModal, true)
    check(
      'el inventario ES el del flyout de arriba (z-index 20)',
      stackedInv.items.some((i) => i.text.includes('Albus Agent')),
      true
    )
    check(
      'y NO el del menú de abajo, que era el bucle',
      stackedInv.items.some((i) => i.text.includes('Connections · None')),
      false
    )
    check(
      'el fondo tampoco entra',
      stackedInv.items.some((i) => i.text.includes('Botón del fondo')),
      false
    )

    // ── 14 · el permiso que el agente NO puede dar ──────────────────────────
    console.log('\n── assert 14 · lo que el agente no puede, se le pide al humano y se verifica')

    const { connectable: findService } = await import('../connections/services')
    const notion = findService('notion')!

    check('Notion declara cómo verificarse por API', typeof notion.verify, 'function')
    check('y qué pedirle al humano si el agente no puede', notion.askHuman !== undefined, true)
    check(
      'las instrucciones son pasos concretos, no un párrafo',
      (notion.askHuman?.instructions.length ?? 0) >= 3,
      true
    )
    check(
      'y avisan que Albus se entera solo: no hay botón de "ya está"',
      notion.askHuman?.instructions.join(' ').includes('solo'),
      true
    )

    // ── 11 · un servicio es DATOS, no un archivo de código ──────────────────
    console.log('\n── assert 11 · sumar un servicio son cinco líneas en una tabla')

    const { CONNECTABLE, connectable } = await import('../connections/services')
    const { goalText, goalUrl } = await import('../connections/connection-agent')
    const ids = Object.keys(CONNECTABLE)

    check('hay más de un servicio conectable con el MISMO motor', ids.length > 1, true)
    check('y Supabase es uno, sin haber escrito supabase-auto.ts', ids.includes('supabase'), true)

    // Todos cumplen la misma forma. Si alguno necesitara un campo propio,
    // el diseño ya estaría filtrando código específico por la puerta de atrás.
    const wellFormed = ids.every((id) => {
      const s = connectable(id)
      return (
        s !== null &&
        s.url.startsWith('https://') &&
        s.goals.length > 0 &&
        s.goals.every((o) => goalText(o).length > 40) &&
        s.secretPattern.length > 3
      )
    })
    check('todos tienen url + objetivos + patrón, y nada más', wellFormed, true)

    // El objetivo dice QUÉ lograr, no qué apretar. Un selector CSS o una línea
    // de JavaScript adentro sería código disfrazado de dato — y volvería a
    // atar el objetivo al HTML de hoy del servicio, que es lo que se rompía.
    const CODE = /querySelector|document\.|getElementById|\[data-|\.css-|<\/?\w+>/
    const noSelectors = ids.every((id) =>
      connectable(id)!.goals.every((o) => !CODE.test(goalText(o)))
    )
    check('ningún objetivo trae selectores ni HTML: son intenciones', noSelectors, true)

    /**
     * Y el que hubiera evitado la falla real: un objetivo que manda a OTRA
     * página tiene que traer su `url` como campo, para que navegue el motor.
     * Escrita adentro del texto, el agente contesta —con razón— que desde ahí
     * ningún elemento lo lleva a esa página: navegar no es una acción suya.
     */
    const navigationDeclared = ids.every((id) =>
      connectable(id)!.goals.every(
        (o) => goalUrl(o) !== null || !/\bir a\b.*https?:\/\//i.test(goalText(o))
      )
    )
    check('ningún objetivo le pide al agente que "vaya a" una URL', navigationDeclared, true)
    check(
      'el de compartir la base de Notion declara su url',
      goalUrl(connectable('notion')!.goals[1]) !== null,
      true
    )
  } finally {
    await browser.close()
  }

  const total = passed + failed
  console.log('\n' + '='.repeat(60))
  console.log(
    `NAVEGACIÓN CON MODELO   ${passed}/${total} ${failed === 0 ? '✓' : `· ${failed} FALLA(S)`}`
  )
  console.log('='.repeat(60) + '\n')

  return failed === 0
}
