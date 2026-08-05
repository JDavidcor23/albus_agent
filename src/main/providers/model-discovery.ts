import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LlmModel } from '../core/extraction/llm-port'

/**
 * Cómo se supo qué modelos hay. Va a la UI: no es lo mismo que el CLI los haya
 * listado a que los hayamos adivinado y confirmado uno por uno.
 */
export type DiscoveryMethod =
  /** Candidatos conocidos, todavía sin verificar contra el CLI. Gratis e instantáneo. */
  | 'seed'
  /** El CLI tiene un comando que los enumera. Verdad de la fuente. */
  | 'listed'
  /** Se probó cada candidato contra el CLI. Verificado, pero la lista de
   *  candidatos es nuestra: un alias nuevo que no esté ahí no aparece. */
  | 'probed'
  /** Del disco, de una corrida anterior con la misma versión del CLI. */
  | 'cached'

export interface Discovery {
  models: LlmModel[]
  method: DiscoveryMethod
  checkedAt: string
  /** Versión del CLI con la que se averiguó. Invalida el caché al cambiar. */
  cliVersion: string
}

interface CacheFile {
  [claveProveedorVersion: string]: Discovery
}

/**
 * Carpeta del caché.
 *
 * `electron` se importa a mano y de forma tolerante en vez de con un import
 * arriba: los scripts de `scripts/` corren con tsx, fuera de Electron, y un
 * `import { app } from 'electron'` en el tope hacía explotar el módulo entero
 * con "Cannot read properties of undefined (reading 'getPath')" — bloqueando el
 * uso del registry de proveedores desde cualquier script.
 *
 * Esto es un CACHÉ de qué modelos ofrece cada CLI. Perderlo solo cuesta una
 * consulta de más, así que degradar a tmp fuera de Electron es aceptable.
 */
function cacheDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { app?: { getPath(n: string): string } }
    const dir = electron.app?.getPath('userData')
    if (dir) return dir
  } catch {
    // No estamos en Electron.
  }
  return join(tmpdir(), 'albus-agent')
}

function cachePath(): string {
  return join(cacheDir(), 'model-discovery.json')
}

function readCache(): CacheFile {
  const ruta = cachePath()
  if (!existsSync(ruta)) return {}
  try {
    return JSON.parse(readFileSync(ruta, 'utf8')) as CacheFile
  } catch {
    return {}
  }
}

function writeCache(cache: CacheFile): void {
  mkdirSync(cacheDir(), { recursive: true })
  writeFileSync(cachePath(), JSON.stringify(cache, null, 2), 'utf8')
}

export function getCached(providerId: string, cliVersion: string): Discovery | null {
  const entrada = readCache()[`${providerId}@${cliVersion}`]
  return entrada ?? null
}

export function putCached(providerId: string, d: Discovery): void {
  const cache = readCache()
  cache[`${providerId}@${d.cliVersion}`] = d
  writeCache(cache)
}
