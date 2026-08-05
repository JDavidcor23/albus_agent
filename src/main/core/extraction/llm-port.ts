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
  run(prompt: string, model: string | null): Promise<string>
}

/** Lo que la app le pide al modelo para un item que los patrones no resolvieron. */
export interface LlmClassification {
  kind: 'receipt' | 'profile' | 'job_offer' | 'event' | 'note' | 'none'
  summary: string
  fields: Record<string, string>
}
