import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { videoDir } from '../paths'
import type { TranscriptEntry } from '../../shared/ipc'
import {
  META_FILE,
  TranscriptMetaSchema,
  sortTranscripts,
  titleFor,
  type TranscriptMeta
} from '../core/video/library'

/**
 * The transcript library, on disk.
 *
 * The domain half of this lives in `core/video/library.ts` — schema, titles,
 * ordering, all of it pure. This file is the only part that touches the
 * filesystem, the same split as `core/video/transcript.ts` against
 * `video/ffmpeg.ts`.
 *
 * Precedent for the name: `graph/store.ts` was already the disk-backed store
 * for the graph.
 */

/**
 * A folder name, made safe.
 *
 * The id reaches here from the renderer, and a renderer is never trusted — same
 * line `manifestPath` holds. A `..` must not let a rename write outside the
 * video folder. Stripping instead of escaping is deliberate: an id that needed
 * escaping was never one this app wrote.
 */
function cleanId(id: string): string {
  return id.replace(/[^a-z0-9-]/gi, '')
}

/** The folder for one transcript, guaranteed to sit inside `videoDir()`. */
export function transcriptDir(id: string): string {
  const clean = cleanId(id)
  if (clean === '') throw new Error('that is not a transcript id')

  const dir = resolve(join(videoDir(), clean))
  if (resolve(videoDir()) === dir) throw new Error('that is not a transcript id')

  return dir
}

/**
 * Reads one `meta.json`. Never throws — a missing or broken file is a transcript
 * without a title, not a transcript that disappears.
 *
 * This is the same choice `parseManifest` makes, and it is the whole reason the
 * two runs that predate this feature still show up in the library.
 */
export function readMeta(id: string): TranscriptMeta | null {
  const path = join(transcriptDir(id), META_FILE)
  if (!existsSync(path)) return null

  try {
    const parsed = TranscriptMetaSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (!parsed.success) {
      console.warn(`[video] ${path} is malformed, ignoring it: ${parsed.error.message}`)
      return null
    }
    return parsed.data
  } catch (error: unknown) {
    console.warn(`[video] could not read ${path}: ${String(error)}`)
    return null
  }
}

/** Writes `meta.json`. The folder must already exist — a run just made it. */
export function writeMeta(id: string, meta: TranscriptMeta): void {
  const dir = transcriptDir(id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
}

/**
 * Renames a transcript. The FOLDER never moves — only the title inside it.
 *
 * Moving the directory would break every path already handed to the renderer,
 * invalidate the `insideOutput` check on links the user has open, and rename the
 * one thing that is the transcript's identity. A title is a label; the folder is
 * the id. Same separation as an agent, whose id comes from its filename while
 * its `name` is free text.
 *
 * An empty title is allowed and means "go back to the derived name" — the user
 * clearing a field must not be an error.
 */
export function renameTranscript(id: string, title: string): TranscriptEntry {
  const dir = transcriptDir(id)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error('that transcript is not there any more')
  }

  const current = readMeta(id) ?? TranscriptMetaSchema.parse({})
  writeMeta(id, { ...current, title: title.trim() })

  const row = entryFor(id)
  if (row === null) throw new Error('that transcript is not there any more')
  return row
}

/**
 * One row of the library, or `null` when the folder holds no transcript.
 *
 * The test for "is this a transcript" is the `.srt`, not the presence of
 * `meta.json`: metadata is the newer half of the format, and a folder that has a
 * transcript IS a transcript regardless. It also keeps stray folders — the
 * archived `video-out` that got moved in here, for one — out of the list
 * instead of showing them as empty rows.
 */
function entryFor(id: string): TranscriptEntry | null {
  const dir = transcriptDir(id)
  const srtPath = join(dir, 'transcript.srt')
  if (!existsSync(srtPath)) return null

  const meta = readMeta(id)

  return {
    id,
    title: titleFor(id, meta),
    dir,
    pagePath: join(dir, 'page.html'),
    srtPath,
    textPath: join(dir, 'transcript.txt'),
    sourceName: meta?.sourceName ?? '',
    /*
     * `createdAt` falls back to the folder's mtime so the un-migrated
     * transcripts still sort sensibly. It is a fallback and not the source:
     * copying a folder rewrites its mtime, which is why a real run stamps the
     * date into `meta.json` instead.
     */
    createdAt: meta?.createdAt !== undefined && meta.createdAt !== ''
      ? meta.createdAt
      : safeMtime(dir),
    model: meta?.model ?? '',
    language: meta?.language ?? '',
    durationSeconds: meta?.durationSeconds ?? 0,
    cues: meta?.cues ?? 0,
    droppedCues: meta?.droppedCues ?? 0,
    frames: meta?.frames ?? 0,
    untitled: meta === null || meta.title.trim() === ''
  }
}

function safeMtime(dir: string): string {
  try {
    return statSync(dir).mtime.toISOString()
  } catch {
    return ''
  }
}

/**
 * Every transcript the user has, newest first.
 *
 * Folder by folder, like everything that comes from outside: one unreadable
 * directory cannot take the library down with it. Same rule as `listManifests`
 * and as the per-row validation the project applies to Supabase.
 */
export function listTranscripts(): TranscriptEntry[] {
  const root = videoDir()
  if (!existsSync(root)) return []

  let names: string[]
  try {
    names = readdirSync(root)
  } catch (error: unknown) {
    console.warn(`[video] could not read ${root}: ${String(error)}`)
    return []
  }

  const rows: TranscriptEntry[] = []
  for (const name of names) {
    if (cleanId(name) !== name) continue

    try {
      const row = entryFor(name)
      if (row !== null) rows.push(row)
    } catch (error: unknown) {
      console.warn(`[video] skipping ${name}: ${String(error)}`)
    }
  }

  return sortTranscripts(rows)
}
