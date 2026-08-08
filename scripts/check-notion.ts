/**
 * ¿Notion está conectado de verdad, ahora mismo?
 *
 *   npx tsx scripts/check-notion.ts
 *
 * Responde la única pregunta que importa cuando la UI dice una cosa y el log
 * dice otra: **¿la API contesta?** Tener el token no alcanza — si la base no
 * está compartida con la integración, Notion devuelve 404 y el espejo nunca se
 * escribe. Las dos situaciones se ven casi iguales desde afuera y se arreglan
 * distinto, así que acá se separan.
 *
 * No abre navegador, no gasta cuota, no escribe nada.
 */

import { readFileSync, existsSync } from 'node:fs'
import { parsearYml, rutaAlbusYml } from '../src/main/connections/albus-yml'
import { setNotionTokenResolver, notionDatabaseId, DEFAULT_DATABASE_ID } from '../src/main/notion/client'
import { knownPostLinks } from '../src/main/notion/applications'

/**
 * A qué bases llega ESTE token, según Notion.
 *
 * Es la respuesta a "¿y cómo sabe qué proyecto elegir?": no hay que adivinar
 * ni hardcodear un id. `POST /v1/search` devuelve exactamente lo que la
 * integración puede tocar — y esa lista es la que hay que mostrarle al usuario
 * para que elija, en vez de tener una constante que solo sirve en una cuenta.
 */
async function listarAccesibles(token: string): Promise<void> {
  try {
    const res = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'notion-version': '2022-06-28',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ filter: { property: 'object', value: 'database' }, page_size: 25 })
    })

    const cuerpo = (await res.json()) as {
      results?: { id: string; title?: { plain_text?: string }[] }[]
    }
    const bases = cuerpo.results ?? []

    if (bases.length === 0) {
      console.log('\n  A qué bases llega este token: NINGUNA todavía.')
      console.log('  (Es coherente con el 404: falta compartir aunque sea una.)\n')
      return
    }

    console.log(`\n  A qué bases llega este token (${bases.length}):`)
    for (const b of bases) {
      const nombre = b.title?.map((t) => t.plain_text ?? '').join('') || '(sin título)'
      console.log(`    · ${nombre.padEnd(34)} ${b.id.replace(/-/g, '')}`)
    }
    console.log('')
  } catch (error: unknown) {
    console.log(`\n  (no pude listar las bases accesibles: ${String(error)})\n`)
  }
}

async function main(): Promise<void> {
  console.log('\n══ ¿NOTION ESTÁ CONECTADO? ══\n')

  // 1. ¿Hay token, y de dónde sale?
  const ruta = rutaAlbusYml()
  const hayArchivo = existsSync(ruta)
  const yml = hayArchivo ? parsearYml(readFileSync(ruta, 'utf8')) : {}
  const delYml = yml.NOTION_TOKEN ?? ''
  const delEnv = process.env.NOTION_TOKEN ?? ''
  const token = delYml.trim() !== '' ? delYml : delEnv

  console.log(`albus.yml:  ${hayArchivo ? ruta : 'no existe todavía'}`)
  console.log(
    `token:      ${
      token.trim() === ''
        ? 'NO HAY'
        : `${token.slice(0, 8)}… (${token.length} caracteres) — de ${delYml.trim() !== '' ? 'albus.yml' : '.env'}`
    }`
  )

  if (token.trim() === '') {
    console.log('\n→ Falta conectar Notion. Abrí Albus → Conexiones → conectar Notion.\n')
    process.exit(1)
  }

  // El cliente lee el entorno por defecto; acá se le pasa el de albus.yml.
  setNotionTokenResolver(() => token)

  const base = notionDatabaseId() || DEFAULT_DATABASE_ID
  console.log(`base:       ${base}`)

  // 2. ¿La API contesta? Es la única prueba que vale.
  try {
    const urls = await knownPostLinks()
    console.log(`\n✓ CONECTADO — la base responde: ${urls.size} postulación(es) registradas\n`)
    process.exit(0)
  } catch (error: unknown) {
    const m = error instanceof Error ? error.message : String(error)
    console.log(`\n✕ el token existe pero la base NO responde:\n  ${m}\n`)

    // Un 404 con token válido significa una cosa sola, y tiene un arreglo de
    // diez segundos. Decirlo es la diferencia entre eso y volver a correr todo.
    if (/404|could not find|not found/i.test(m)) {
      console.log('  Es el caso típico: el token sirve, pero la integración NO tiene acceso a la base.')

      // A qué SÍ tiene acceso. Es la respuesta a "¿y cómo sabe qué proyecto
      // elegir?": no hay que adivinar ni hardcodear nada — el token mismo
      // dice a qué llega, y de ahí sale la lista para elegir.
      await listarAccesibles(token)

      console.log('  Arreglo manual (10 segundos):')
      console.log(`    1. Abrí https://www.notion.so/${base.replace(/-/g, '')}`)
      console.log('    2. Menú "···" arriba a la derecha → Connections')
      console.log('    3. Elegí "Albus Agent" → confirmar\n')
    } else if (/unauthorized|401|invalid/i.test(m)) {
      console.log('  El token fue rechazado: está vencido o es de otra integración.')
      console.log('  Volvé a conectar Notion desde Albus.\n')
    }

    process.exit(1)
  }
}

void main()
