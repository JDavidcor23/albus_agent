import { z } from 'zod'
import { notionDatabaseId, notionFetch } from './client'
import { notionProperties, type NotionRow, type NotionStatus } from '../core/jobs/notion-map'

/**
 * El espejo de las postulaciones en Notion.
 *
 * Upsert por `post link`, no insert. El usuario abre la misma vacante dos
 * veces, la deja en Backlog un día y se postula al otro: si cada corrida
 * insertara, la base terminaría con tres filas de la misma empresa y el
 * seguimiento —que es para lo único que sirve la base— se rompe.
 *
 * `'post link'` is the FROZEN upsert key: change it and every run inserts a
 * duplicate instead of updating.
 */

const PageSchema = z.object({ id: z.string(), url: z.string().optional() })

const QuerySchema = z.object({
  results: z.array(z.object({ id: z.string() }))
})

/** Devuelve el id de la fila que ya tiene esa URL, o null. */
export async function findByPostLink(postLink: string): Promise<string | null> {
  if (postLink.trim() === '') return null

  const json = await notionFetch(`/databases/${notionDatabaseId()}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'post link', url: { equals: postLink } },
      page_size: 1
    })
  })

  const parsed = QuerySchema.safeParse(json)
  if (!parsed.success) return null
  return parsed.data.results[0]?.id ?? null
}

export interface UpsertResult {
  pageId: string
  /** `false` = se actualizó una fila que ya existía. */
  created: boolean
  url: string
}

export async function upsertApplication(row: NotionRow): Promise<UpsertResult> {
  const properties = notionProperties(row)
  const existing = await findByPostLink(row.postLink)

  if (existing !== null) {
    const json = await notionFetch(`/pages/${existing}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties })
    })
    const page = PageSchema.parse(json)
    return { pageId: page.id, created: false, url: page.url ?? '' }
  }

  const json = await notionFetch('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: notionDatabaseId() },
      properties
    })
  })

  const page = PageSchema.parse(json)
  return { pageId: page.id, created: true, url: page.url ?? '' }
}

/** Para el dedupe: qué URLs ya están en la base. Pagina hasta agotar. */
/**
 * Los estados que sacan una vacante del barrido.
 *
 * `Backlog` NO está en la lista, y ese es todo el punto. Antes se dedupeaba
 * contra CUALQUIER fila de la base, así que una vacante que calificaba se
 * escribía como `Backlog` y al día siguiente el barrido la excluía: el agente
 * escondía justamente sus mejores hallazgos, y una candidata de 82 puntos a la
 * que no te habías postulado desaparecía para siempre.
 *
 * La intención escrita en `hunt.ts` siempre fue otra —*"pagar por rankear una
 * vacante a la que ya te postulaste es tirar plata"*—, solo que "anotada" y
 * "postulada" eran indistinguibles.
 *
 * Regla del usuario, textual: *"si hasta que yo mismo no las descarte, estas
 * deben aparecer"*.
 */
export const CLOSED_STATUSES: NotionStatus[] = [
  'Applying',
  'In process',
  'Rejected',
  'First contact',
  'Descartada'
]

/** Una fila de la base, ya leída. */
export interface BacklogRow {
  url: string
  company: string
  role: string
  score: number
  note: string
  description: string
  date: string
  status: string
}

export interface TrackedApplications {
  /** URLs cerradas: postuladas, en proceso o descartadas. No vuelven al lote. */
  closed: Set<string>
  /** En backlog: vuelven al lote SIN volver a puntuarse (ya tienen nota). */
  backlog: BacklogRow[]
  /** Todas, cerradas incluidas. Para quien necesita más que el dedupe. */
  all: BacklogRow[]
}

function plainText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map((r) =>
      typeof r === 'object' && r !== null && typeof (r as { plain_text?: unknown }).plain_text === 'string'
        ? (r as { plain_text: string }).plain_text
        : ''
    )
    .join('')
}

/**
 * Lo que la base ya sabe de cada vacante, en UNA pasada.
 *
 * Devuelve las dos cosas juntas porque salen de la misma query: pedir la base
 * dos veces para separar cerradas de backlog es pagar dos veces por lo mismo.
 */
export async function trackedApplications(): Promise<TrackedApplications> {
  const RowSchema = z.object({
    properties: z
      .object({
        'post link': z.object({ url: z.string().nullable() }).optional(),
        Status: z
          .object({ select: z.object({ name: z.string() }).nullable() })
          .optional(),
        Company: z.object({ title: z.array(z.unknown()) }).optional(),
        'Role/Position': z.object({ rich_text: z.array(z.unknown()) }).optional(),
        'Fit Score': z.object({ number: z.number().nullable() }).optional(),
        'Job description': z.object({ rich_text: z.array(z.unknown()) }).optional(),
        'Date of application': z
          .object({ date: z.object({ start: z.string() }).nullable() })
          .optional(),
        'Próxima acción': z.object({ rich_text: z.array(z.unknown()) }).optional()
      })
      .passthrough()
  })

  const LinksSchema = z.object({
    results: z.array(z.unknown()),
    next_cursor: z.string().nullable(),
    has_more: z.boolean()
  })

  const closed = new Set<string>()
  const backlog: BacklogRow[] = []
  const all: BacklogRow[] = []
  let cursor: string | null = null

  // Tope de páginas: la base es de seguimiento personal, no un data lake. Si
  // alguna vez tiene 5000 filas, el problema es otro.
  for (let i = 0; i < 20; i++) {
    const json: unknown = await notionFetch(`/databases/${notionDatabaseId()}/query`, {
      method: 'POST',
      body: JSON.stringify({
        page_size: 100,
        ...(cursor !== null ? { start_cursor: cursor } : {})
      })
    })

    const parsed = LinksSchema.safeParse(json)
    if (!parsed.success) break

    // Fila por fila, no el lote entero: una con una propiedad rara no puede
    // costar el dedupe completo — y perderlo significa postularse dos veces.
    for (const raw of parsed.data.results) {
      const row = RowSchema.safeParse(raw)
      if (!row.success) continue

      const p = row.data.properties
      const url = p['post link']?.url
      if (!url) continue

      const status = p.Status?.select?.name ?? 'Backlog'

      const tracked: BacklogRow = {
        url,
        company: plainText(p.Company?.title),
        role: plainText(p['Role/Position']?.rich_text),
        score: p['Fit Score']?.number ?? 0,
        note: plainText(p['Próxima acción']?.rich_text),
        description: plainText(p['Job description']?.rich_text),
        date: p['Date of application']?.date?.start ?? '',
        status
      }

      all.push(tracked)
      if ((CLOSED_STATUSES as string[]).includes(status)) closed.add(url)
      else backlog.push(tracked)
    }

    if (!parsed.data.has_more || parsed.data.next_cursor === null) break
    cursor = parsed.data.next_cursor
  }

  return { closed, backlog, all }
}

/**
 * Todas las URL de la base, sin mirar el estado.
 *
 * Queda SOLO para el diagnóstico de conexiones, que la usa para responder
 * "¿la base contesta y tiene filas?". Para el dedupe del barrido está mal:
 * usá `trackedApplications()`, que separa las cerradas del backlog.
 */
export async function knownPostLinks(): Promise<Set<string>> {
  const { closed, backlog } = await trackedApplications()
  for (const row of backlog) closed.add(row.url)
  return closed
}

/**
 * Cambia el estado de una vacante en la base.
 *
 * `status` es un `NotionStatus`, o sea una de las seis opciones que ya existen
 * en el select. Eso NO es una restricción de estilo: mandar un nombre que no
 * está hace que Notion cree la opción sola, y de golpe la base tiene nueve
 * estados y los filtros del usuario dejan de servir. El tipo es la barrera.
 *
 * Devuelve `false` si la vacante no está en la base — no la inventa: una fila
 * con la mitad de las columnas vacías es peor que ninguna.
 */
export async function markStatus(postLink: string, status: NotionStatus): Promise<boolean> {
  const pageId = await findByPostLink(postLink)
  if (pageId === null) return false

  await notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: { Status: { select: { name: status } } } })
  })
  return true
}

/**
 * Descartar tiene que PERSISTIR: si solo se saca de la pantalla, al barrido
 * siguiente vuelve y hay que descartarla otra vez, para siempre. Es la otra
 * mitad de la regla — las que no descartaste vuelven; las que descartaste, no.
 */
export async function markDiscarded(postLink: string): Promise<boolean> {
  return markStatus(postLink, 'Descartada')
}

/** Una fila de la base, como la ve el agente. */
export interface ApplicationRow extends BacklogRow {
  /** Días desde `Date of application`. `null` si la fila no tiene fecha. */
  daysSince: number | null
}

/**
 * TODAS las postulaciones, con estado y antigüedad.
 *
 * `daysSince` se calcula acá y no lo estima el modelo: pedirle a un LLM que
 * reste fechas es cómo se llega a "hace como un mes" sobre algo de seis días.
 * El agente decide QUÉ hacer con el número; el número es un dato.
 */
export async function listApplications(today = new Date()): Promise<ApplicationRow[]> {
  const { all } = await trackedApplications()

  const days = (date: string): number | null => {
    if (date === '') return null
    const then = Date.parse(date)
    if (Number.isNaN(then)) return null
    return Math.floor((today.getTime() - then) / 86_400_000)
  }

  return all.map((row) => ({ ...row, daysSince: days(row.date) }))
}

/** Manda la fila al archivo. Solo lo usa el verificador con su fila de prueba. */
export async function archivePage(pageId: string): Promise<void> {
  await notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived: true })
  })
}
