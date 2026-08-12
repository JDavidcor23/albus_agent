import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { albusYmlPath as pathInDataDir, migrateLegacyData } from '../paths'

/**
 * `albus.yml` — las llaves de la app, en un solo archivo legible.
 *
 * ## Por qué no es el `.env`
 *
 * Pedido del usuario, textual: *"que todos los tokens se guarden dentro de
 * albus.yml, es como un .env pero que no se llame .env"*. El motivo es de
 * herramientas: tiene el `.env` bloqueado para los agentes, y necesita un
 * archivo que la app —y quien la esté ayudando— pueda leer y escribir.
 *
 * ## El precio, dicho de frente
 *
 * Esto es TEXTO PLANO. `connections.json` cifraba con `safeStorage` (DPAPI en
 * Windows), que ata el secreto a la cuenta del sistema: copiado a otra máquina
 * no servía para nada. Un `.yml` sí sirve. Por eso:
 *
 * - va al `.gitignore` (y hay un chequeo que lo verifica),
 * - lo cifrado que ya existía se SIGUE leyendo, no se rompe nada,
 * - pero lo nuevo se escribe acá, que es lo que se pidió.
 *
 * ## Por qué un parser propio y no `js-yaml`
 *
 * Lo que se guarda es `CLAVE: valor`, una por línea. Traer una dependencia de
 * YAML completo —anclas, listas, multilínea— para eso es superficie de ataque
 * gratis en el proceso que tiene el service role key. Si algún día hace falta
 * anidar, se cambia; hoy no hace falta.
 */

const FILENAME = 'albus.yml'

/**
 * `userData/albus.yml`, SIEMPRE — igual que las reglas de los agentes y todo
 * lo demás que el usuario escribe o la app genera. Ver `paths.ts`.
 *
 * Antes vivía en la raíz del repo en desarrollo. Estaba mal: *"si algún día
 * quiero sacar esto, se va a guardar en el código fuente"*. Si quedó uno viejo
 * ahí, se muda solo la primera vez que se lee.
 */
/**
 * La migración se dispara acá y no solo al leer: cualquiera que pida la ruta
 * —un script de diagnóstico, por ejemplo— tiene que encontrar el archivo ya
 * mudado. Si no, `notion:check` reporta "no hay token" sobre uno que existe.
 */
export function albusYmlPath(): string {
  migrateIfNeeded()
  return pathInDataDir()
}

/**
 * Dónde estaba antes: en la raíz del repo.
 *
 * Se sigue mirando UNA vez para mudarlo. Cambiar de lugar un archivo con el
 * token adentro sin migrarlo es hacerle perder la conexión al usuario sin
 * decirle por qué.
 */
function legacyPath(): string {
  return join(process.cwd(), FILENAME)
}

let migrated = false

function migrateIfNeeded(): void {
  if (migrated) return
  migrated = true

  /*
   * Primero la mudanza de carpeta, después la del repo.
   *
   * Son dos migraciones distintas y encadenadas: `%APPDATA%` → `Documentos/
   * albus_agent` (la de `paths.ts`) y raíz-del-repo → carpeta de datos (la de
   * acá). Esta función es la puerta por la que entran los SCRIPTS, que nunca
   * arrancan la app: sin esta línea, `notion:check` leería la carpeta nueva vacía
   * y diría "no hay token".
   */
  migrateLegacyData()

  const next = pathInDataDir()
  const previous = legacyPath()

  if (next === previous || existsSync(next) || !existsSync(previous)) return

  try {
    mkdirSync(dirname(next), { recursive: true })
    writeFileSync(next, readFileSync(previous, 'utf8'), 'utf8')
    // El viejo se borra: dejar dos archivos con el mismo token es garantizar
    // que en un mes nadie sepa cuál manda.
    unlinkSync(previous)
    console.log(`[albus.yml] mudado del repo a ${next}`)
  } catch (error: unknown) {
    console.warn(`[albus.yml] no pude mudarlo: ${String(error)}`)
  }
}

/**
 * Parser mínimo: `CLAVE: valor`, `#` comenta, comillas opcionales.
 *
 * Los valores NO se interpretan: un token es un string y punto. Convertir
 * `true` a booleano o recortar un `0123` a número es exactamente el tipo de
 * ayuda que corrompe una credencial en silencio.
 */
export function parseYml(text: string): Record<string, string> {
  const output: Record<string, string> = {}

  for (const line of text.split(/\r?\n/)) {
    const clean = line.trim()
    if (clean === '' || clean.startsWith('#')) continue

    const cut = clean.indexOf(':')
    if (cut <= 0) continue

    const key = clean.slice(0, cut).trim()
    let value = clean.slice(cut + 1).trim()

    // Un `#` dentro de un valor entrecomillado es parte del valor, no un
    // comentario. Sin comillas, sí corta.
    const quoted = /^(['"])(.*)\1$/.exec(value)
    if (quoted !== null) value = quoted[2]
    else {
      const hash = value.indexOf(' #')
      if (hash !== -1) value = value.slice(0, hash).trim()
    }

    if (key !== '') output[key] = value
  }

  return output
}

/** Se serializa a mano por la misma razón que se parsea a mano. */
function serialize(data: Record<string, string>): string {
  const header = [
    '# Las llaves de Albus. Este archivo NO se commitea: está en .gitignore.',
    '# Lo escribe la app cuando conectás un servicio, y lo podés editar a mano.',
    ''
  ].join('\n')

  const body = Object.entries(data)
    .sort(([a], [b]) => a.localeCompare(b))
    // Se entrecomilla siempre: un token puede traer `#`, `:` o espacios, y
    // adivinar cuándo hace falta es cómo se corrompe un valor.
    .map(([k, v]) => `${k}: "${v.replace(/"/g, '\\"')}"`)
    .join('\n')

  return `${header}${body}\n`
}

export function readAlbusYml(): Record<string, string> {
  migrateIfNeeded()

  const path = albusYmlPath()
  if (!existsSync(path)) return {}

  try {
    return parseYml(readFileSync(path, 'utf8'))
  } catch (error: unknown) {
    // Un archivo ilegible se trata como vacío. Perder una llave es molesto;
    // que la app no arranque por una comilla suelta es peor.
    console.warn(`[albus.yml] no se pudo leer (${String(error)}), lo ignoro`)
    return {}
  }
}

export function writeToAlbusYml(key: string, value: string): void {
  const data = readAlbusYml()
  data[key] = value

  const path = albusYmlPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serialize(data), 'utf8')
  console.log(`[albus.yml] ${key} guardado en ${path}`)
}

export function deleteFromAlbusYml(key: string): void {
  const data = readAlbusYml()
  if (!(key in data)) return

  delete data[key]
  const path = albusYmlPath()
  writeFileSync(path, serialize(data), 'utf8')
}

/** `null` si no está o está vacío. Una clave vacía es como no tenerla. */
export function fromAlbusYml(key: string): string | null {
  const v = readAlbusYml()[key]
  return v !== undefined && v.trim() !== '' ? v : null
}
