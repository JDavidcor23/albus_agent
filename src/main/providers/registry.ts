import type { LlmProvider } from '../core/extraction/llm-port'
import { createClaudeCodeProvider, discoverClaudeModels } from './claude-code'
import { createAgyProvider, discoverAgyModels } from './agy'
import type { Discovery } from './model-discovery'

const PROVIDERS: LlmProvider[] = [createClaudeCodeProvider(), createAgyProvider()]

export interface ProviderInfo {
  id: string
  name: string
  models: { id: string; label: string }[]
  /** Cómo se supo: listado por el CLI, probado uno por uno, o de caché. */
  method: Discovery['method']
  checkedAt: string
  cliVersion: string
}

const DISCOVERY: Record<string, (force: boolean) => Promise<Discovery>> = {
  'claude-code': discoverClaudeModels,
  agy: discoverAgyModels
}

/** Qué CLIs hay realmente instalados, con sus modelos. Para poblar el selector. */
export async function detectProviders(force = false): Promise<ProviderInfo[]> {
  const found: ProviderInfo[] = []

  for (const p of PROVIDERS) {
    if (!(await p.isAvailable())) continue

    const d = await DISCOVERY[p.id](force)
    found.push({
      id: p.id,
      name: p.name,
      models: d.models,
      method: d.method,
      checkedAt: d.checkedAt,
      cliVersion: d.cliVersion
    })
  }

  return found
}

export function getProvider(id: string): LlmProvider | null {
  return PROVIDERS.find((p) => p.id === id) ?? null
}

/**
 * El primer CLI que esté instalado y autenticado, con un modelo elegido.
 *
 * Existe para los usos donde no hay UI que pregunte cuál usar —conectar un
 * servicio, por ejemplo: el usuario apretó un botón, no vino a elegir modelo.
 * Se prefiere `claude` porque es el que el usuario ya tiene logueado, y se cae
 * a `agy` si no está.
 *
 * `model` por defecto es el más barato que sirva: elegir un botón en una
 * pantalla no necesita el modelo más caro, y esto gasta la cuota del usuario.
 */
export async function firstAvailableProvider(
  model = 'sonnet',
  /**
   * Manejar un navegador arranca un proceso del CLI POR PASO, y ese proceso
   * carga su configuración y sus MCP antes de empezar a pensar. Con el techo
   * de 120 s se cortaba a mitad de una conexión —"claude excedió 120s"— y se
   * tiraba trabajo que ya estaba hecho.
   */
  timeoutMs = 240_000
): Promise<{ run: (prompt: string) => Promise<string>; id: string; model: string } | null> {
  for (const p of PROVIDERS) {
    if (!(await p.isAvailable())) continue

    // El alias puede no existir en ese CLI (agy no tiene "sonnet"). Se pide la
    // lista real y se cae al primero que haya antes que fallar por un nombre.
    let chosen: string | null = model
    try {
      const models = await p.listModels()
      if (models.length > 0 && !models.some((m) => m.id === model)) {
        chosen = models[0].id
      }
    } catch {
      chosen = null
    }

    return {
      id: p.id,
      model: chosen ?? 'por defecto',
      run: (prompt: string) => p.run(prompt, chosen, timeoutMs)
    }
  }

  return null
}
