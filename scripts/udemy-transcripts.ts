// Transcripts only, no screenshots: the user's real Chrome (already logged in and
// past Cloudflare) opens ONE Udemy API page whose JSON carries the signed URL of
// every lecture's .vtt. The .vtt files are then fetched straight from the CDN.
// No cue clicking, no video playback, no autoplay races.
//
//   npx tsx scripts/udemy-transcripts.ts <courseIdOrSlug> <outDir> [--section 4,5] [--force]
//   npx tsx scripts/udemy-transcripts.ts <courseIdOrSlug> <outDir> --from <curriculum.json>
//
// Resumable: a lecture whose file already exists with content is skipped.
// Windows-only machine: lectures that teach a Mac or Linux setup are skipped.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SKIP = [/\bmac\b/i, /mac\s*os/i, /\blinux\b/i]
const KEEP = [/windows/i]

type Caption = { locale_id: string; source: string; url: string }
type Item =
  | { _class: 'chapter'; title: string; object_index: number }
  | {
      _class: 'lecture'
      title: string
      object_index: number
      asset?: { asset_type: string; captions?: Caption[] }
    }
  | { _class: string; title: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function orcaExe(): string {
  return execFileSync('where', ['orca.exe'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()
}

function orca(args: string[]): any {
  const out = execFileSync(orcaExe(), ['computer', ...args, '--json'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  })
  return JSON.parse(out)
}

function chromeWindowIds(): number[] {
  const res = orca(['list-windows', '--app', 'chrome'])
  return (res.result?.windows ?? []).map((w: { id: number }) => w.id)
}

// The JSON viewer exposes the body as consecutive `text` nodes of ~64 KB each.
function jsonFromTree(tree: string): unknown | null {
  const lines = tree.split('\n')
  let i = lines.findIndex((l) => /^\s*\d+ text \{"count"/.test(l))
  if (i < 0) return null
  let body = ''
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\d+ text (.*)$/)
    if (!m) break
    body += m[1]
    try {
      return JSON.parse(body)
    } catch {
      /* keep concatenating */
    }
  }
  return null
}

async function fetchCurriculumViaChrome(course: string): Promise<{ results: Item[] }> {
  const url =
    `https://www.udemy.com/api-2.0/courses/${course}/subscriber-curriculum-items/` +
    '?page_size=1400&fields[lecture]=title,object_index,asset&fields[chapter]=title,object_index' +
    '&fields[asset]=asset_type,captions&fields[quiz]=title'
  const before = new Set(chromeWindowIds())
  spawn(CHROME, ['--new-window', url], { detached: true, stdio: 'ignore' }).unref()

  let windowId: number | undefined
  for (let t = 0; t < 120; t++) {
    await sleep(2000)
    windowId ??= chromeWindowIds().find((id) => !before.has(id))
    if (windowId === undefined) continue
    const state = orca(['get-app-state', '--app', 'chrome', '--window-id', String(windowId), '--no-screenshot'])
    const tree: string = state.result?.snapshot?.treeText ?? ''
    if (/Just a moment/i.test(tree)) throw new Error('Cloudflare challenge in Chrome: pass it by hand and rerun')
    const json = jsonFromTree(tree) as { results?: Item[] } | null
    if (json?.results) {
      closeWindow(windowId, tree)
      return json as { results: Item[] }
    }
    if (/"detail"\s*:\s*"[^"]*(credentials|not found)/i.test(tree))
      throw new Error('Udemy answered without the curriculum: is Chrome logged in to Udemy?')
  }
  throw new Error('timed out waiting for the curriculum JSON in Chrome')
}

function closeWindow(windowId: number, tree: string): void {
  const idx = tree.match(/(\d+) button Close/)?.[1]
  if (!idx) return
  try {
    orca(['click', '--app', 'chrome', '--window-id', String(windowId), '--element-index', idx, '--no-screenshot'])
  } catch {
    /* leaving an extra window open is harmless */
  }
}

function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const pad = (n: number) => String(n).padStart(2, '0')

export function vttToText(vtt: string): string {
  const out: string[] = []
  for (const block of vtt.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    const t = lines.findIndex((l) => l.includes('-->'))
    if (t < 0) continue
    const text = lines
      .slice(t + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim()
    if (text && text !== out[out.length - 1]) out.push(text)
  }
  return out.join('\n\n') + '\n'
}

function englishCaption(captions: Caption[] = []): Caption | undefined {
  const en = captions.filter((c) => c.locale_id.startsWith('en'))
  return en.find((c) => c.source === 'manual') ?? en[0]
}

function sectionDir(outDir: string, index: number, title: string): string {
  const prefix = `${pad(index)}-`
  const existing = existsSync(outDir) ? readdirSync(outDir).find((d) => d.startsWith(prefix)) : undefined
  return join(outDir, existing ?? prefix + slugify(title))
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const flag = (name: string) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv.splice(i, 2)[1] : undefined
  }
  const sections = flag('--section')?.split(',').map(Number)
  const from = flag('--from')
  const force = argv.includes('--force')
  const [course, outDir] = argv.filter((a) => !a.startsWith('--'))
  if (!course || !outDir) throw new Error('usage: udemy-transcripts.ts <courseIdOrSlug> <outDir> [--section 4,5] [--from file] [--force]')

  const curriculum = from
    ? (JSON.parse(readFileSync(from, 'utf8')) as { results: Item[] })
    : await fetchCurriculumViaChrome(course)

  let section: { index: number; title: string } | undefined
  let saved = 0
  let skipped = 0
  const failed: string[] = []
  for (const item of curriculum.results) {
    if (item._class === 'chapter' && 'object_index' in item) {
      section = { index: item.object_index, title: item.title }
      continue
    }
    if (item._class !== 'lecture' || !section || !('object_index' in item)) continue
    if (sections && !sections.includes(section.index)) continue
    const label = `${section.index}/${item.object_index} ${item.title}`
    if (SKIP.some((r) => r.test(item.title)) && !KEEP.some((r) => r.test(item.title))) {
      console.log(`skip (not Windows)  ${label}`)
      continue
    }
    const caption = 'asset' in item ? englishCaption(item.asset?.captions) : undefined
    if (!caption) continue // articles and videos without English captions

    const dir = sectionDir(outDir, section.index, section.title)
    const file = join(dir, `${pad(item.object_index)}-${slugify(item.title)}.md`)
    if (!force && existsSync(file) && statSync(file).size > 200) {
      skipped++
      continue
    }
    try {
      const res = await fetch(caption.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, vttToText(await res.text()))
      saved++
      console.log(`saved  ${label}`)
    } catch (e) {
      failed.push(`${label}: ${(e as Error).message}`)
      console.log(`FAIL   ${label}: ${(e as Error).message}`)
    }
  }
  console.log(`\n${saved} saved · ${skipped} already there · ${failed.length} failed`)
  if (failed.length) process.exitCode = 1
}

main().catch((e) => {
  console.error((e as Error).message)
  process.exit(1)
})
