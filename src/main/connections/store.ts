import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deleteFromAlbusYml, fromAlbusYml, writeToAlbusYml } from './albus-yml'

/**
 * De dónde salen las credenciales de Albus, y en qué orden.
 *
 * | # | Dónde | Quién escribe |
 * |---|---|---|
 * | 1 | `albus.yml` | la app y el usuario a mano |
 * | 2 | `connections.json` (cifrado) | legado: lo que ya estaba guardado |
 * | 3 | `.env` | quien lo configuró así de entrada |
 *
 * **Se escribe SIEMPRE en `albus.yml`.** Un solo lugar donde escribir es lo que
 * evita la pregunta "¿cuál de los tres está usando?" — y por eso también es el
 * primero al leer: si el usuario acaba de editarlo, tiene que ganar.
 *
 * `connections.json` se sigue LEYENDO para no romperle nada a quien ya tenía
 * sus tokens ahí, pero no se escribe más. Cifraba con `safeStorage` (DPAPI en
 * Windows), que ata el secreto a la cuenta del sistema: era más seguro que un
 * `.yml` en claro, y eso está dicho de frente en `albus-yml.ts`. La decisión de
 * producto fue tener un archivo legible y editable, con el `.gitignore` como
 * red — no que fuera indescifrable.
 */

export type ServiceId = 'notion' | 'google'

interface Stored {
  /** base64 del blob cifrado por safeStorage. */
  [key: string]: string
}

function filePath(): string {
  return join(app.getPath('userData'), 'connections.json')
}

function readRaw(): Stored {
  const path = filePath()
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Stored) : {}
  } catch {
    // Archivo corrupto: se trata como vacío. Perder un token guardado es
    // molesto; que la app no arranque por eso es peor.
    console.warn('[connections] el archivo de conexiones no se pudo leer, lo ignoro')
    return {}
  }
}

function writeRaw(data: Stored): void {
  const path = filePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
}

/**
 * Sin cifrado disponible NO se guarda en claro. Un token de Notion en texto
 * plano dentro de userData es una credencial regalada; mejor decirle al usuario
 * que use el `.env`, donde al menos sabe que está.
 */
export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/**
 * Guardar va a `albus.yml`, siempre. No hay condición ni fallback.
 *
 * Antes esto tiraba si el SO no ofrecía cifrado, y era correcto: guardar en
 * claro sin avisar es regalar una credencial. Ahora el archivo en claro ES la
 * decisión tomada, con el `.gitignore` como red, así que no hay nada que
 * negociar en tiempo de ejecución.
 */
export function saveSecret(key: string, value: string): void {
  writeToAlbusYml(ymlKey(key), value)
}

export function deleteSecret(key: string): void {
  deleteFromAlbusYml(ymlKey(key))

  // También del legado: si no, "desconectar" borra de un lado y el token
  // reaparece al reiniciar desde el otro.
  const data = readRaw()
  delete data[key]
  writeRaw(data)
}

/** `null` si no está guardado o si el blob ya no descifra (otra máquina). */
export function readSecret(key: string): string | null {
  // Primero `albus.yml`: es donde se escribe, y si el usuario lo editó a mano
  // hace treinta segundos tiene que ganar sobre cualquier cosa vieja.
  const inYml = fromAlbusYml(ymlKey(key))
  if (inYml !== null) return inYml

  const data = readRaw()
  const encrypted = data[key]
  if (encrypted === undefined) return null

  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    console.warn(`[connections] "${key}" no descifra en esta máquina, lo ignoro`)
    return null
  }
}

/**
 * Lo guardado gana sobre el `.env`: es lo último que el usuario tocó, y si
 * acaba de pegar un token nuevo en la UI espera que ese sea el que se use.
 */
export function secretOrEnv(key: string, envVar: string): string | null {
  const saved = readSecret(key)
  if (saved !== null && saved.trim() !== '') return saved

  const fromEnv = process.env[envVar]
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : null
}

/**
 * De dónde salió el secreto. La UI lo muestra para que no haya sorpresas.
 *
 * `albus.yml` se distingue del resto: es el único que el usuario puede abrir y
 * editar, y saber que el valor sale de ahí es la diferencia entre arreglarlo en
 * diez segundos y no entender por qué la app usa un token viejo.
 */
export function secretSource(key: string, envVar: string): 'yml' | 'app' | 'env' | 'none' {
  if (fromAlbusYml(ymlKey(key)) !== null) return 'yml'

  const data = readRaw()
  if (data[key] !== undefined && readSecret(key) !== null) return 'app'

  const fromEnv = process.env[envVar]
  return fromEnv !== undefined && fromEnv.trim() !== '' ? 'env' : 'none'
}

export const KEYS = {
  notionToken: 'notion.token',
  googleRefreshToken: 'google.refresh_token'
} as const

/**
 * `notion.token` → `NOTION_TOKEN`.
 *
 * En el `.yml` las llaves se ven como las del `.env` a propósito: son las que
 * el usuario ya conoce, y así copiar una del `.env` al `.yml` funciona sin
 * traducir nada.
 */
function ymlKey(key: string): string {
  return key.replace(/\./g, '_').toUpperCase()
}
