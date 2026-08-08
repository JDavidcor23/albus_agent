/** Escalón 4: el único que gasta cuota. Se usa cuando lo barato no alcanzó. */
export interface LlmModel {
  id: string
  label: string
}

export interface LlmProvider {
  id: string
  name: string
  /** ¿Está el binario en el PATH? No ejecuta el CLI, solo lo busca. */
  isAvailable(): Promise<boolean>
  listModels(): Promise<LlmModel[]>
  /** Manda el prompt y devuelve el texto crudo. Tira si el CLI falla. */
  /**
   * `timeoutMs` existe porque no todas las llamadas cuestan lo mismo. Clasificar
   * una imagen responde en segundos; manejar un navegador arranca un proceso
   * del CLI por paso —que carga su configuración y sus MCP antes de pensar— y
   * con el techo de 120 s se cortaba a mitad de una conexión, tirando trabajo
   * que ya estaba hecho.
   */
  run(prompt: string, model: string | null, timeoutMs?: number): Promise<string>
}

/** Lo que la app le pide al modelo para un item que los patrones no resolvieron. */
export interface LlmClassification {
  kind: 'receipt' | 'profile' | 'job_offer' | 'event' | 'note' | 'none'
  summary: string
  fields: Record<string, string>
}
