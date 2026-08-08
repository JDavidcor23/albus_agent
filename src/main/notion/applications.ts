import { z } from 'zod'
import { notionDatabaseId, notionFetch } from './client'
import { notionProperties, type NotionRow } from '../core/jobs/notion-map'

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
export async function knownPostLinks(): Promise<Set<string>> {
  const LinksSchema = z.object({
    results: z.array(
      z.object({
        properties: z
          .object({ 'post link': z.object({ url: z.string().nullable() }).optional() })
          .passthrough()
      })
    ),
    next_cursor: z.string().nullable(),
    has_more: z.boolean()
  })

  const urls = new Set<string>()
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

    for (const row of parsed.data.results) {
      const url = row.properties['post link']?.url
      if (url) urls.add(url)
    }

    if (!parsed.data.has_more || parsed.data.next_cursor === null) break
    cursor = parsed.data.next_cursor
  }

  return urls
}

/** Manda la fila al archivo. Solo lo usa el verificador con su fila de prueba. */
export async function archivePage(pageId: string): Promise<void> {
  await notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived: true })
  })
}
