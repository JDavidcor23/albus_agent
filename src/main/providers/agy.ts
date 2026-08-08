import { spawn } from 'node:child_process'
import type { LlmModel, LlmProvider } from '../core/extraction/llm-port'
import { collect, resolveBinary } from './cli-common'
import { getCached, putCached, type Discovery } from './model-discovery'

const cache: { value: string | null | undefined } = { value: undefined }

async function version(bin: string): Promise<string> {
  try {
    const child = spawn(bin, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    return (await collect(child, 'agy --version', null)).split('\n')[0].trim()
  } catch {
    return 'desconocida'
  }
}

/**
 * agy SÍ enumera sus modelos: `agy models` es la verdad de la fuente, no hay
 * que adivinar ni probar nada.
 */
export async function discoverAgyModels(force = false): Promise<Discovery> {
  const bin = await resolveBinary('agy', cache)
  if (bin === null) {
    return { models: [], method: 'listed', checkedAt: new Date().toISOString(), cliVersion: 'n/a' }
  }

  const v = await version(bin)
  if (!force) {
    const cached = getCached('agy', v)
    if (cached !== null) return { ...cached, method: 'cached' }
  }

  let models: LlmModel[] = []
  try {
    // agy se cuelga si stdin es un pipe abierto; con stdin ignorado responde.
    const child = spawn(bin, ['models'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const output = await collect(child, 'agy models', null)
    models = output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.includes(' '))
      .map((id) => ({ id, label: id }))
  } catch {
    models = []
  }

  const d: Discovery = {
    models,
    method: 'listed',
    checkedAt: new Date().toISOString(),
    cliVersion: v
  }
  if (models.length > 0) putCached('agy', d)
  return d
}

/**
 * El prompt de agy viaja por ARGV (`--print <prompt>`), y Windows corta la línea
 * de comandos cerca de 32k. 20k deja margen para binario y flags.
 */
const MAX_PROMPT = 20_000

export function createAgyProvider(): LlmProvider {
  return {
    id: 'agy',
    name: 'Antigravity (agy)',

    async isAvailable(): Promise<boolean> {
      return (await resolveBinary('agy', cache)) !== null
    },

    async listModels(): Promise<LlmModel[]> {
      return (await discoverAgyModels()).models
    },

    async run(prompt: string, model: string | null, timeoutMs?: number): Promise<string> {
      const bin = await resolveBinary('agy', cache)
      if (bin === null) throw new Error('agy no está en el PATH')

      if (model !== null) {
        const models = await this.listModels()
        if (!models.some((m) => m.id === model)) {
          throw new Error(`modelo inválido para agy: ${model}`)
        }
      }

      const trimmed =
        prompt.length > MAX_PROMPT ? `${prompt.slice(0, MAX_PROMPT)}\n[recortado]` : prompt

      const args: string[] = []
      if (model !== null) args.push('--model', model)
      args.push('--print', trimmed)

      // shell:false: el prompt no pasa por el shell aunque tenga comillas.
      const child = spawn(bin, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return await collect(child, 'agy', null, { timeoutMs })
    }
  }
}
