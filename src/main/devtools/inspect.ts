import { createBrowserPage } from '../browser/page'

/**
 * Mirar lo que el agente mira, en una página de verdad, sin conectar nada.
 *
 *   npm run nav:inspect -- https://www.notion.so/profile/integrations
 *
 * ## Para qué
 *
 * Cuando una conexión falla con "eso no está en la página", hay dos culpables
 * posibles y se parecen mucho: o el agente eligió mal, o el inventario nunca
 * le mostró el elemento. Discutirlo a ciegas cuesta una corrida completa por
 * cada hipótesis — y la corrida abre un navegador, gasta cuota y toca la
 * cuenta del usuario.
 *
 * Esto abre la página con la MISMA sesión, imprime el inventario tal cual lo
 * recibiría el agente, y se va. No clickea, no escribe, no guarda nada.
 */
export async function inspectPage(url: string): Promise<boolean> {
  console.log(`\n══ QUÉ VE EL AGENTE EN ${url} ══\n`)

  const browser = createBrowserPage({ visible: true })

  try {
    await browser.open(url)

    // La SPA puede seguir montando. Se mira dos veces con una pausa: si la
    // segunda trae más, lo que importaba llegó tarde y conviene saberlo.
    const first = await browser.inventory()
    await new Promise((r) => setTimeout(r, 2500))
    const inv = await browser.inventory()

    console.log(`título:  ${inv.title}`)
    console.log(`url:     ${inv.url}`)
    console.log(`modal:   ${inv.inModal ? 'SÍ — el inventario es solo del modal' : 'no'}`)
    console.log(`items:   ${inv.items.length}${inv.truncated ? ' (RECORTADO: hay más)' : ''}`)

    if (first.items.length !== inv.items.length) {
      console.log(
        `⚠ la página seguía montando: ${first.items.length} items al abrir, ${inv.items.length} 2,5 s después`
      )
    }

    console.log('\n── elementos que el agente puede elegir ─────────────────────')
    for (const i of inv.items) {
      const off = i.disabled ? ' [OFF]' : ''
      const pos = `(${i.rect.x},${i.rect.y})`
      console.log(`  ${i.cid.padEnd(5)} ${i.action.padEnd(8)} <${i.tag}>${off} ${pos}  ${i.text.slice(0, 90)}`)
    }

    console.log('\n── texto visible (primeros 1200) ────────────────────────────')
    console.log(inv.text.slice(0, 1200))

    /**
     * El chequeo que de verdad importa: cosas que están en el TEXTO pero no
     * tienen id. Es exactamente el síntoma que reportó el agente —"aparece en
     * el texto de la página pero su fila no está en el inventario"— y acá se
     * ve sin gastar una corrida.
     */
    const withId = inv.items.map((i) => i.text.toLowerCase()).join(' ')
    const orphans = inv.text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 3 && l.length < 60)
      .filter((l) => !withId.includes(l.toLowerCase()))

    if (orphans.length > 0) {
      console.log('\n── ⚠ visible pero SIN id para clickear ──────────────────────')
      console.log('   (si lo que buscás está acá, el agujero es del inventario)')
      for (const l of orphans.slice(0, 25)) console.log(`   · ${l}`)
    }

    console.log('')
    return true
  } catch (error: unknown) {
    console.error(`\nFALLA: ${String(error)}\n`)
    return false
  } finally {
    await browser.close()
  }
}
