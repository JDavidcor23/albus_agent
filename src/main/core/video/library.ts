import { z } from 'zod'

/**
 * What a stored transcript IS, and how it gets a readable name.
 *
 * ## The problem
 *
 * `runVideo` used to leave a folder named after the recording — `2026-09-02-10-29-05`.
 * That is a timestamp, not a name. Two recordings from the same meeting are
 * indistinguishable, and nobody can tell which folder holds which conversation
 * without opening the page and reading it.
 *
 * So every run now drops a `meta.json` next to its transcript. That file is the
 * ONLY place a title lives.
 *
 * ## Why a file per transcript and NOT a central index
 *
 * Same decision `agents/` already made: one `<id>.agente.json` per agent, and
 * `listManifests()` scans the directory. Two reasons it wins here too:
 *
 * 1. **The disk stays the source of truth.** Delete a folder by hand — which the
 *    user WILL do, the whole point of `paths.ts` is that this folder is theirs to
 *    browse — and a central index becomes a list of transcripts that no longer
 *    exist. Scanning cannot desync from what is actually there.
 * 2. **One corrupt file cannot hide the rest.** A single `index.json` is one
 *    point of failure for the entire library. Per-folder metadata is the same
 *    validate-per-row rule the project applies to Supabase and to agents: a
 *    broken row costs one row.
 *
 * ## `meta.json` is a FROZEN value
 *
 * Rename it and every title the user typed is orphaned — the transcripts still
 * open, but they all go back to being timestamps. The failure is silent, which
 * is exactly the category `frozen-contracts.md` covers.
 */

/** CONTRACT — the file that holds a transcript's title. Renaming it drops every title. */
export const META_FILE = 'meta.json'

/**
 * Everything a transcript folder remembers about itself.
 *
 * Read from the user's disk, so it is external input: every field has a default
 * and nothing here may throw on a hand-edited file. A missing `title` is not an
 * error, it is a transcript that has not been named yet — `titleFor` covers it.
 */
export const TranscriptMetaSchema = z.object({
  title: z.string().default(''),
  /** The recording this came from, for when the title is not enough. */
  sourceName: z.string().default(''),
  /** ISO 8601. Stored, not derived from mtime: copying a folder must not re-date it. */
  createdAt: z.string().default(''),
  model: z.string().default(''),
  language: z.string().default(''),
  durationSeconds: z.number().nonnegative().default(0),
  cues: z.number().int().nonnegative().default(0),
  droppedCues: z.number().int().nonnegative().default(0),
  frames: z.number().int().nonnegative().default(0)
})

export type TranscriptMeta = z.infer<typeof TranscriptMetaSchema>

/**
 * Turns a folder name back into something readable.
 *
 * This is the fallback for transcripts written BEFORE `meta.json` existed — and
 * there are already two of them on this machine. They must show up in the
 * library with a usable name, not get skipped for lacking a field that did not
 * exist when they were made. Same shape of problem as the `job-search` manifest
 * that predates `screen`.
 *
 * A slug like `2026-09-02-10-29-05` becomes `2026-09-02 10:29:05`, because that
 * is what it always meant.
 */
export function titleFromSlug(slug: string): string {
  const stamped = /^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-(\d{2})$/.exec(slug)
  if (stamped !== null) return `${stamped[1]} ${stamped[2]}:${stamped[3]}:${stamped[4]}`

  return slug.replace(/-+/g, ' ').trim()
}

/** The name to show: what the user typed, or the folder read out loud. */
export function titleFor(slug: string, meta: TranscriptMeta | null): string {
  const typed = meta?.title.trim() ?? ''
  return typed === '' ? titleFromSlug(slug) : typed
}

/**
 * A title the user did not have to type.
 *
 * Derived from the source file so a fresh run is never nameless. It is a
 * STARTING POINT, not a guess at content: naming it "sales call" would require
 * reading the transcript with a model, and a wrong confident title is worse than
 * an honest timestamp — the same reason the hallucination filter exists.
 */
export function defaultTitle(sourceName: string): string {
  const stem = sourceName.replace(/\.[a-z0-9]+$/i, '')
  return titleFromSlug(stem.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, ''))
}

/**
 * Newest first, and `id` breaks the tie.
 *
 * A library that reorders itself between openings looks like a bug — the same
 * reason `listManifests` sorts by id instead of trusting `readdirSync`. Folders
 * with no date sort last rather than first: an empty string would otherwise win
 * every comparison and push the un-migrated transcripts to the top.
 *
 * Generic over the two fields it actually reads, so the WIRE shape of a library
 * row can stay where it belongs — `shared/ipc.ts`, the contract — instead of
 * being declared a second time in here. `core/` imports nothing from `shared/`
 * and this keeps it that way without paying for it in a duplicated interface,
 * which is the thing that drifts.
 */
export function sortTranscripts<T extends { id: string; createdAt: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      if (a.createdAt === '') return 1
      if (b.createdAt === '') return -1
      return a.createdAt < b.createdAt ? 1 : -1
    }
    return b.id.localeCompare(a.id)
  })
}
