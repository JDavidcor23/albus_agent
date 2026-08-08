import { getSupabaseClient } from './client'

/**
 * El resumen legible de una nota.
 *
 * ---------------------------------------------------------------------------
 * Por qué vive en `extractions` y no en una tabla nueva ni en `entries`
 * ---------------------------------------------------------------------------
 * `entries` es de My Notes. Agregarle una columna acoplaría los dos repos y
 * obligaría a coordinar un deploy del otro lado para un campo que solo Albus
 * escribe y solo Albus lee.
 *
 * `extractions` ya tiene una fila por nota con `attachment_path = ''`, que su
 * propia migración define como "el resultado salió del body de la entry, no de un
 * adjunto". Un resumen del body es exactamente eso. Va en su `payload`, que es
 * jsonb sin esquema, y hereda gratis el unique `(entry_id, attachment_path)` —
 * o sea, idempotencia por esquema, sin flag y sin tabla nueva.
 *
 * Consecuencia aceptada: `run-batch --reset` borra extractions y se lleva los
 * resúmenes. Está bien, son derivados y reproducibles. Y la UI cae al recorte del
 * body cuando falta, así que un reset degrada la lectura sin romper nada.
 *
 * ---------------------------------------------------------------------------
 * Por qué un archivo aparte
 * ---------------------------------------------------------------------------
 * Es el único lugar donde el pipeline de PENDIENTES escribe en la tabla de
 * EXTRACCIONES. Esconderlo dentro de `tasks-repo` haría que ese cruce de capas
 * pasara desapercibido en la próxima lectura del código. Acá está a la vista, con
 * un solo trabajo, y se mueve de una pieza si algún día merece su propia tabla.
 */

/**
 * Guarda el resumen en la fila del body, sin pisar el resto del payload.
 *
 * NUNCA lanza. Un resumen es una mejora de lectura: perderlo no puede costar la
 * detección de pendientes, que ya está hecha y sí gastó cuota.
 *
 * Devuelve `true` solo si quedó escrito, para que el llamador pueda contar.
 */
export async function saveNoteSummary(entryId: string, summary: string): Promise<boolean> {
  const supabase = getSupabaseClient()

  try {
    // Read-modify-write y no un update directo del jsonb: el payload del body
    // puede traer el texto y otros campos de la cascada, y sobrescribirlo entero
    // los borraría.
    const { data, error } = await supabase
      .from('extractions')
      .select('id, payload')
      .eq('entry_id', entryId)
      .eq('attachment_path', '')
      .maybeSingle()

    if (error) throw new Error(error.message)

    if (data === null) {
      // La nota todavía no pasó por la cascada de extracción. No inventamos una
      // fila: su `kind` y su `source` son de la cascada, no nuestros, y una fila
      // con valores adivinados le mentiría al resto del sistema.
      console.warn(
        `[note-summary] la entry ${entryId} no tiene fila de body en extractions; ` +
          'el resumen se descarta (corré la extracción primero)'
      )
      return false
    }

    const previous = (data.payload ?? {}) as Record<string, unknown>

    const { error: updateError } = await supabase
      .from('extractions')
      .update({ payload: { ...previous, summary } })
      .eq('id', data.id)

    if (updateError) throw new Error(updateError.message)
    return true
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[note-summary] no se pudo guardar el resumen de ${entryId}: ${message}`)
    return false
  }
}

/** Lee el resumen de un payload de la fila del body. `null` si no hay. */
export function readSummary(payload: unknown): string | null {
  const p = (payload ?? {}) as Record<string, unknown>
  const s = p.summary
  return typeof s === 'string' && s.trim().length > 0 ? s.trim() : null
}
