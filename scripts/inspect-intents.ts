/**
 * ¿Cuánta "intención de hacer algo" hay escrita en las notas?
 *
 *   npx tsx scripts/inspect-intents.ts
 *
 * Solo lectura. Antes de construir un chat de "¿qué tengo pendiente?" hay que
 * saber si el concepto de pendiente existe en los datos, o si lo estaríamos
 * inventando.
 */
import { z } from 'zod'
import { getSupabaseClient } from '../src/main/supabase/client'

const Row = z.object({
  id: z.string(),
  body: z.string().nullable(),
  created_at: z.string(),
  attachments: z.array(z.unknown()).nullable(),
  extractions: z.array(z.object({ attachment_path: z.string(), kind: z.string() })).nullable()
})

/** Verbos que delatan algo por hacer, no algo ya hecho. */
const INTENT_VERBS =
  /\b(revisar|verificar|postular|aplicar|llamar|escribir|mandar|enviar|pagar|comprar|inscribir|agendar|leer|estudiar|probar|mirar|averiguar|preguntar|cotizar|renovar|pendiente|falta|tengo que|hay que|recordar)\w*/gi

/** Verbos en pasado: eso YA pasó, no es un pendiente. */
const DONE_VERBS = /\b(pagu[eé]|pagado|pago de|compr[eé]|envi[eé]|llam[eé]|termin[eé]|list[oa])\b/gi

async function main(): Promise<void> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('entries')
    .select('id, body, created_at, attachments, extractions ( attachment_path, kind )')
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)

  let total = 0
  let withIntent = 0
  let done = 0
  let neutral = 0

  console.log('='.repeat(72))
  console.log('TODAS LAS NOTAS, CLASIFICADAS A OJO')
  console.log('='.repeat(72))

  for (const raw of Array.isArray(data) ? data : []) {
    const parsed = Row.safeParse(raw)
    if (!parsed.success) continue
    const body = (parsed.data.body ?? '').trim()
    if (body.length === 0) continue

    total++
    const intents = [...new Set((body.match(INTENT_VERBS) ?? []).map((v) => v.toLowerCase()))]
    const alreadyDone = (body.match(DONE_VERBS) ?? []).length > 0

    let label: string
    if (alreadyDone) {
      label = 'HECHO   '
      done++
    } else if (intents.length > 0) {
      label = 'PENDIENTE'
      withIntent++
    } else {
      label = 'ni idea '
      neutral++
    }

    const adj = (parsed.data.attachments ?? []).length
    console.log(
      `${label}  ${body.slice(0, 58).padEnd(58)}` +
        `${adj ? ` [${adj} adj]` : ''}` +
        `${intents.length ? `  <- ${intents.join(', ')}` : ''}`
    )
  }

  console.log('\n' + '='.repeat(72))
  console.log(`notas con texto : ${total}`)
  console.log(`  PENDIENTE     : ${withIntent}  (hay un verbo de intención)`)
  console.log(`  HECHO         : ${done}  (habla en pasado)`)
  console.log(`  sin señal     : ${neutral}`)
  console.log('='.repeat(72))
  console.log(
    '\nNinguna tiene estado. Nada dice si ya se resolvió: eso no existe todavia\n' +
      'en el modelo de datos, hay que agregarlo.'
  )
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
