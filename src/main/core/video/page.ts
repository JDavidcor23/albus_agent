import { groupByMinute, shortStamp, type Cue } from './transcript'

/**
 * Une las dos mitades del pipeline en UNA página.
 *
 * Frames por un lado y transcript por el otro son dos artefactos que hay que
 * cruzar a mano. Acá cada captura queda al lado de lo que se dijo en ese
 * minuto, que es la forma en que alguien lee una reunión de una hora sin
 * volver a mirarla.
 *
 * Dominio puro: recibe los frames YA leídos en base64. No toca el disco.
 *
 * Las imágenes van embebidas y no como `<img src="frames/f_001.jpg">` porque el
 * resultado tiene que ser UN archivo: uno que se pueda mover, mandar o guardar
 * sin arrastrar una carpeta al lado. Costo medido: 58 frames de 640x360 dieron
 * 2,2 MB.
 */

export interface PageInput {
  title: string
  cues: Cue[]
  /** minuto → el jpg en base64, sin el prefijo `data:`. */
  frames: Map<number, string>
  /** Cada cuántos segundos se sacó una captura. */
  everySeconds: number
  durationSeconds: number
  /** El modelo de whisper que se usó, para que la página diga de dónde salió. */
  model: string
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const CSS = `
:root {
  --bg:#faf9f7; --fg:#1b1a18; --dim:#6b6862; --line:#e3e0da; --card:#fff; --accent:#8a5a2b;
}
@media (prefers-color-scheme: dark) {
  :root { --bg:#16151a; --fg:#e8e6e1; --dim:#9a968e; --line:#2b2930; --card:#1e1d23; --accent:#d9a566; }
}
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--fg);
  font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif }
header { position:sticky; top:0; z-index:5; background:var(--bg);
  border-bottom:1px solid var(--line); padding:1.2rem 1.5rem }
h1 { margin:0 0 .3rem; font-size:1.25rem; letter-spacing:-.01em }
.meta { color:var(--dim); font-size:.85rem }
main { max-width:1100px; margin:0 auto; padding:1.5rem }
section { display:grid; grid-template-columns:340px 1fr; gap:1.5rem;
  padding:1.5rem 0; border-bottom:1px solid var(--line); align-items:start }
.shot { position:sticky; top:6.5rem }
.shot img { width:100%; border-radius:8px; display:block;
  border:1px solid var(--line); background:var(--card) }
.stamp { position:absolute; left:.5rem; bottom:.5rem; background:#000b; color:#fff;
  text-decoration:none; padding:.15rem .5rem; border-radius:5px;
  font:600 .78rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace }
.noimg { aspect-ratio:16/9; display:grid; place-items:center; color:var(--dim);
  border:1px dashed var(--line); border-radius:8px; font-size:.85rem }
.said p { margin:0 0 .55rem; text-wrap:pretty }
.t { color:var(--accent); margin-right:.6rem; vertical-align:.08em;
  font:600 .75rem/1 ui-monospace,SFMono-Regular,Menlo,monospace }
.quiet { color:var(--dim); font-style:italic }
@media (max-width:760px) { section { grid-template-columns:1fr } .shot { position:static } }
`.trim()

export function buildPage(input: PageInput): string {
  const { title, cues, frames, everySeconds, durationSeconds, model } = input

  const byMinute = groupByMinute(cues, everySeconds)
  const lastSlot = Math.max(
    Math.ceil(durationSeconds / everySeconds) - 1,
    ...(byMinute.size > 0 ? [...byMinute.keys()] : [0])
  )

  const sections: string[] = []
  for (let slot = 0; slot <= lastSlot; slot++) {
    const base64 = frames.get(slot)
    const shot =
      base64 === undefined
        ? '<div class="noimg">sin captura</div>'
        : `<img loading="lazy" src="data:image/jpeg;base64,${base64}" alt="minuto ${slot}">`

    const said = (byMinute.get(slot) ?? [])
      .map((c) => `<p><span class="t">${shortStamp(c.start)}</span>${escapeHtml(c.text)}</p>`)
      .join('\n')

    sections.push(
      `<section id="m${slot}">\n` +
        `  <div class="shot">${shot}` +
        `<a class="stamp" href="#m${slot}">${shortStamp(slot * everySeconds)}</a></div>\n` +
        `  <div class="said">${said || '<p class="quiet">— sin habla en este minuto —</p>'}</div>\n` +
        `</section>`
    )
  }

  const words = cues.reduce((n, c) => n + c.text.split(/\s+/).filter(Boolean).length, 0)
  const safeTitle = escapeHtml(title)

  return `<!doctype html>
<html lang="es">
<meta charset="utf-8">
<title>${safeTitle}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CSS}</style>
<header>
  <h1>${safeTitle}</h1>
  <div class="meta">${shortStamp(durationSeconds)} · ${cues.length} intervenciones · ${words} palabras · una captura cada ${everySeconds}s · whisper <code>${escapeHtml(model)}</code></div>
</header>
<main>
${sections.join('\n')}
</main>
</html>
`
}
