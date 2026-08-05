import { spawn } from 'node:child_process'
import type { LlmModel, LlmProvider } from '../core/extraction/llm-port'
import { collect, resolveBinary } from './cli-common'
import { getCached, putCached, type Discovery } from './model-discovery'

const cache: { value: string | null | undefined } = { value: undefined }

/**
 * Semilla de alias a probar. NO es la verdad: es la lista de qué preguntar.
 * Se completa con lo que el propio `--help` mencione, así un alias nuevo entra
 * solo cuando Anthropic lo documenta ahí.
 */
const CANDIDATOS_BASE = ['haiku', 'sonnet', 'opus', 'fable']

/** El CLI responde esto cuando el modelo no existe — y sale con exit 0. */
const MARCA_INVALIDO = 'issue with the selected model'

const ETIQUETAS: Record<string, string> = {
  haiku: 'Haiku — el más rápido y barato',
  sonnet: 'Sonnet — equilibrado',
  opus: 'Opus — el más capaz',
  fable: 'Fable — máxima capacidad'
}

async function version(bin: string): Promise<string> {
  try {
    const child = spawn(`"${bin}"`, ['--version'], { shell: true, windowsHide: true })
    return (await collect(child, 'claude --version', null)).split('\n')[0].trim()
  } catch {
    return 'desconocida'
  }
}

/** Alias que el propio help menciona, p. ej. "'fable', 'opus', or 'sonnet'". */
async function candidatosDesdeHelp(bin: string): Promise<string[]> {
  try {
    const child = spawn(`"${bin}"`, ['--help'], { shell: true, windowsHide: true })
    const help = await collect(child, 'claude --help', null)

    const bloque = help.slice(help.indexOf('--model'), help.indexOf('--model') + 400)
    return [...bloque.matchAll(/'([a-z][a-z0-9-]{2,})'/g)]
      .map((m) => m[1])
      .filter((a) => !a.startsWith('claude-'))
  } catch {
    return []
  }
}

/**
 * Pregunta lo mínimo posible con cada alias y mira si el CLI se queja.
 * Cuesta unos pocos tokens por alias, una sola vez por versión del CLI.
 */
async function probar(bin: string, alias: string): Promise<boolean> {
  try {
    const child = spawn(`"${bin}"`, ['-p', '--output-format', 'text', '--model', alias], {
      shell: true,
      windowsHide: true
    })
    const salida = await collect(child, `claude --model ${alias}`, 'di solo: ok')
    return !salida.toLowerCase().includes(MARCA_INVALIDO)
  } catch {
    return false
  }
}

export async function discoverClaudeModels(forzar = false): Promise<Discovery> {
  const bin = await resolveBinary('claude', cache)
  if (bin === null) {
    return { models: [], method: 'probed', checkedAt: new Date().toISOString(), cliVersion: 'n/a' }
  }

  const v = await version(bin)

  const guardado = getCached('claude-code', v)
  if (!forzar && guardado !== null) return { ...guardado, method: 'cached' }

  const candidatos = [...new Set([...CANDIDATOS_BASE, ...(await candidatosDesdeHelp(bin))])]

  // Sin caché y sin pedido explícito devolvemos los candidatos SIN probar: el
  // probe son N llamadas al CLI en serie y bloquearía el arranque de la app
  // gastando cuota que nadie pidió gastar.
  if (!forzar) {
    return {
      models: candidatos.map((id) => ({ id, label: ETIQUETAS[id] ?? id })),
      method: 'seed',
      checkedAt: new Date().toISOString(),
      cliVersion: v
    }
  }

  const vivos: LlmModel[] = []
  for (const alias of candidatos) {
    if (await probar(bin, alias)) {
      vivos.push({ id: alias, label: ETIQUETAS[alias] ?? alias })
    }
  }

  const d: Discovery = {
    models: vivos,
    method: 'probed',
    checkedAt: new Date().toISOString(),
    cliVersion: v
  }
  putCached('claude-code', d)
  return d
}

export function createClaudeCodeProvider(): LlmProvider {
  return {
    id: 'claude-code',
    name: 'Claude Code',

    async isAvailable(): Promise<boolean> {
      return (await resolveBinary('claude', cache)) !== null
    },

    async listModels(): Promise<LlmModel[]> {
      return (await discoverClaudeModels()).models
    },

    async run(prompt: string, model: string | null): Promise<string> {
      const bin = await resolveBinary('claude', cache)
      if (bin === null) throw new Error('claude no está en el PATH')

      const args = ['-p', '--output-format', 'text']
      if (model !== null) args.push('--model', model)

      // El prompt va por stdin: nada del contenido del usuario toca argv.
      // shell:true con la ruta entrecomillada porque el binario puede ser .cmd.
      const child = spawn(`"${bin}"`, args, { shell: true, windowsHide: true })
      const salida = await collect(child, 'claude', prompt)

      // El CLI devuelve exit 0 aunque el modelo no exista: hay que mirar el texto.
      if (salida.toLowerCase().includes(MARCA_INVALIDO)) {
        throw new Error(`claude no acepta el modelo "${model}"`)
      }
      return salida
    }
  }
}
