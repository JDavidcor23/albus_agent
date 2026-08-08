import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { rutaAlbusYml as rutaEnDatos } from '../paths'

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

const NOMBRE = 'albus.yml'

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
export function rutaAlbusYml(): string {
  migrarSiHaceFalta()
  return rutaEnDatos()
}

/**
 * Dónde estaba antes: en la raíz del repo.
 *
 * Se sigue mirando UNA vez para mudarlo. Cambiar de lugar un archivo con el
 * token adentro sin migrarlo es hacerle perder la conexión al usuario sin
 * decirle por qué.
 */
function rutaVieja(): string {
  return join(process.cwd(), NOMBRE)
}

let migrado = false

function migrarSiHaceFalta(): void {
  if (migrado) return
  migrado = true

  const nueva = rutaEnDatos()
  const vieja = rutaVieja()

  if (nueva === vieja || existsSync(nueva) || !existsSync(vieja)) return

  try {
    mkdirSync(dirname(nueva), { recursive: true })
    writeFileSync(nueva, readFileSync(vieja, 'utf8'), 'utf8')
    // El viejo se borra: dejar dos archivos con el mismo token es garantizar
    // que en un mes nadie sepa cuál manda.
    unlinkSync(vieja)
    console.log(`[albus.yml] mudado del repo a ${nueva}`)
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
export function parsearYml(texto: string): Record<string, string> {
  const salida: Record<string, string> = {}

  for (const linea of texto.split(/\r?\n/)) {
    const limpia = linea.trim()
    if (limpia === '' || limpia.startsWith('#')) continue

    const corte = limpia.indexOf(':')
    if (corte <= 0) continue

    const clave = limpia.slice(0, corte).trim()
    let valor = limpia.slice(corte + 1).trim()

    // Un `#` dentro de un valor entrecomillado es parte del valor, no un
    // comentario. Sin comillas, sí corta.
    const comillado = /^(['"])(.*)\1$/.exec(valor)
    if (comillado !== null) valor = comillado[2]
    else {
      const almohadilla = valor.indexOf(' #')
      if (almohadilla !== -1) valor = valor.slice(0, almohadilla).trim()
    }

    if (clave !== '') salida[clave] = valor
  }

  return salida
}

/** Se serializa a mano por la misma razón que se parsea a mano. */
function serializar(datos: Record<string, string>): string {
  const cabecera = [
    '# Las llaves de Albus. Este archivo NO se commitea: está en .gitignore.',
    '# Lo escribe la app cuando conectás un servicio, y lo podés editar a mano.',
    ''
  ].join('\n')

  const cuerpo = Object.entries(datos)
    .sort(([a], [b]) => a.localeCompare(b))
    // Se entrecomilla siempre: un token puede traer `#`, `:` o espacios, y
    // adivinar cuándo hace falta es cómo se corrompe un valor.
    .map(([k, v]) => `${k}: "${v.replace(/"/g, '\\"')}"`)
    .join('\n')

  return `${cabecera}${cuerpo}\n`
}

export function leerAlbusYml(): Record<string, string> {
  migrarSiHaceFalta()

  const ruta = rutaAlbusYml()
  if (!existsSync(ruta)) return {}

  try {
    return parsearYml(readFileSync(ruta, 'utf8'))
  } catch (error: unknown) {
    // Un archivo ilegible se trata como vacío. Perder una llave es molesto;
    // que la app no arranque por una comilla suelta es peor.
    console.warn(`[albus.yml] no se pudo leer (${String(error)}), lo ignoro`)
    return {}
  }
}

export function escribirEnAlbusYml(clave: string, valor: string): void {
  const datos = leerAlbusYml()
  datos[clave] = valor

  const ruta = rutaAlbusYml()
  mkdirSync(dirname(ruta), { recursive: true })
  writeFileSync(ruta, serializar(datos), 'utf8')
  console.log(`[albus.yml] ${clave} guardado en ${ruta}`)
}

export function borrarDeAlbusYml(clave: string): void {
  const datos = leerAlbusYml()
  if (!(clave in datos)) return

  delete datos[clave]
  const ruta = rutaAlbusYml()
  writeFileSync(ruta, serializar(datos), 'utf8')
}

/** `null` si no está o está vacío. Una clave vacía es como no tenerla. */
export function deAlbusYml(clave: string): string | null {
  const v = leerAlbusYml()[clave]
  return v !== undefined && v.trim() !== '' ? v : null
}
