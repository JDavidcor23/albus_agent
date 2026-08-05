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

const DISCOVERY: Record<string, (forzar: boolean) => Promise<Discovery>> = {
  'claude-code': discoverClaudeModels,
  agy: discoverAgyModels
}

/** Qué CLIs hay realmente instalados, con sus modelos. Para poblar el selector. */
export async function detectProviders(forzar = false): Promise<ProviderInfo[]> {
  const encontrados: ProviderInfo[] = []

  for (const p of PROVIDERS) {
    if (!(await p.isAvailable())) continue

    const d = await DISCOVERY[p.id](forzar)
    encontrados.push({
      id: p.id,
      name: p.name,
      models: d.models,
      method: d.method,
      checkedAt: d.checkedAt,
      cliVersion: d.cliVersion
    })
  }

  return encontrados
}

export function getProvider(id: string): LlmProvider | null {
  return PROVIDERS.find((p) => p.id === id) ?? null
}
