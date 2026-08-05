/**
 * ¿Cuánto contexto estamos tirando a la basura?
 *
 *   npx tsx scripts/inspect-context.ts
 *
 * Muestra, para cada entry con adjuntos, el texto del body al lado de lo que la
 * cascada extrajo de cada imagen. Si el body dice "pago de gym" y la extracción
 * de la imagen no lo sabe, es que los estamos procesando como items separados.
 */
import { z } from 'zod'
import { getSupabaseClient } from '../src/main/supabase/client'

const Row = z.object({
  id: z.string(),
  body: z.string().nullable(),
  attachments: z.array(z.unknown()).nullable(),
  extractions: z
    .array(z.object({ attachment_path: z.string(), kind: z.string(), payload: z.unknown() }))
    .nullable()
})

async function main(): Promise<void> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('entries')
    .select('id, body, attachments, extractions ( attachment_path, kind, payload )')
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)

  let conAdjuntos = 0
  let conAdjuntosYBody = 0

  for (const raw of Array.isArray(data) ? data : []) {
    const parsed = Row.safeParse(raw)
    if (!parsed.success) continue
    const row = parsed.data

    const adjuntos = (row.attachments ?? []).length
    if (adjuntos === 0) continue
    conAdjuntos++

    const body = (row.body ?? '').trim()
    if (body.length > 0) conAdjuntosYBody++

    const deImagen = (row.extractions ?? []).filter((e) => e.attachment_path !== '')
    if (deImagen.length === 0) continue

    console.log(`\nbody: "${body.slice(0, 70)}"`)
    for (const e of deImagen) {
      const p = e.payload as Record<string, unknown> | null
      let resumen = ''
      if (e.kind === 'receipt') {
        resumen = `metodo=${String(p?.method ?? '?')} monto=${String(p?.amount ?? '?')} fecha=${String(p?.date ?? '?')} concepto=${String(p?.concept ?? 'NO TIENE')}`
      } else {
        resumen = JSON.stringify(p).slice(0, 90)
      }
      console.log(`   [${e.kind}] ${resumen}`)
    }
  }

  console.log(
    `\n---\nentries con adjuntos: ${conAdjuntos} · de esas, con body escrito: ${conAdjuntosYBody}`
  )
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
