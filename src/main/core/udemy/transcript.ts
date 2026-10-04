/**
 * Las cues del panel de transcripcion, y el markdown que queda en disco.
 *
 * ## Por que NO se transcribe con whisper
 *
 * Existe el camino: grabar la pantalla y pasarla por `video/`. Se midio y es
 * peor por los dos lados. Quince horas de curso son quince horas de CPU con
 * `small`, y el texto que sale es ASR local con alucinaciones sobre los
 * silencios —por eso `core/video/transcript.ts` tiene un filtro entero para
 * eso—. Udemy ya muestra el transcript en el player, curado, gratis y en
 * milisegundos.
 *
 * `video/` sigue siendo el camino para grabaciones que SI estan en disco. Para
 * una pagina que ya tiene el texto, es usar un martillo neumatico para colgar
 * un cuadro.
 */

export interface Cue {
  /** `01:23`. Vacio cuando Udemy no lo expone: la linea igual vale. */
  time: string
  text: string
}

export interface LectureHead {
  title: string
  url: string
  /** ISO corto. Se pasa desde afuera: aca no se inventan relojes. */
  capturedAt: string
}

/**
 * Una linea suelta a cue.
 *
 * Acepta las dos formas que llegan: la que ya paso por aca —`**01:23** texto`,
 * que es como queda en el markdown— y la cruda de la pagina —`01:23 texto`—.
 * Poder releer lo que uno mismo escribio es lo que permite correr el detector
 * de capturas sobre un archivo viejo sin volver a Udemy.
 */
export function parseCue(raw: string): Cue {
  const line = raw.replace(/\s+/g, ' ').trim()

  const stamped = /^\*\*(\d{1,2}:\d{2}(?::\d{2})?)\*\*\s*(.*)$/.exec(line)
  if (stamped !== null) return { time: stamped[1], text: stamped[2].trim() }

  const bare = /^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.*)$/.exec(line)
  if (bare !== null) return { time: bare[1], text: bare[2].trim() }

  return { time: '', text: line }
}

/**
 * Saca las repetidas PEGADAS, y solo esas.
 *
 * Udemy repinta la cue activa mientras el video avanza, asi que la misma frase
 * entra dos o tres veces seguidas. Sin esto el markdown sale tartamudo y —peor—
 * el detector de capturas cuenta el mismo "as you can see" tres veces y lo
 * manda al tope del ranking.
 *
 * **La que vuelve mas tarde se conserva.** Maarek repite a proposito: dice una
 * regla, explica, y la vuelve a decir para cerrar. Deduplicar por texto en todo
 * el archivo borraria ese cierre, que es justo la parte que se recuerda.
 */
export function dedupeCues(cues: Cue[]): Cue[] {
  const out: Cue[] = []
  for (const cue of cues) {
    const prev = out[out.length - 1]
    if (prev !== undefined && prev.text === cue.text) continue
    out.push(cue)
  }
  return out
}

/**
 * El archivo que queda en disco.
 *
 * La marca de PRIVADO va DENTRO del archivo y no solo en el `.gitignore`. Un
 * `.gitignore` protege este repo; el archivo se va a copiar, se va a abrir en
 * otra carpeta y se va a pegar en otro lado, y ahi el unico que sigue avisando
 * es el texto de adentro.
 */
export function toMarkdown(head: LectureHead, cues: Cue[], marks: string[] = []): string {
  const lines = dedupeCues(cues)

  /*
   * Los momentos marcados van ARRIBA, antes del transcript.
   *
   * Desde que las capturas salen por cambio de slide, el detector de deicticos
   * ya no decide QUE capturar — decide que mirar primero. Y eso solo sirve si
   * se lee antes de meterse en las cuatrocientas lineas del transcript.
   */
  const destacados =
    marks.length === 0
      ? []
      : ['## Mirar primero', '', ...marks.map((m) => `- ${m}`), '']

  return [
    '---',
    `titulo: ${JSON.stringify(head.title)}`,
    `url: ${head.url}`,
    `bajado: ${head.capturedAt}`,
    'fuente: udemy',
    `cues: ${lines.length}`,
    '---',
    '',
    `# ${head.title}`,
    '',
    '<!-- PRIVADO. Material de un curso pago: no se publica ni se redistribuye.',
    '     Lo que se publica es la reescritura con palabras propias, que ademas',
    '     es el metodo de estudio: el texto publicable sale de haber entendido. -->',
    '',
    ...destacados,
    ...lines.map(({ time, text }) => (time === '' ? text : `**${time}** ${text}`)),
    ''
  ].join('\n')
}

/** El markdown de vuelta a cues, para correr el detector sobre lo ya bajado. */
export function fromMarkdown(md: string): Cue[] {
  return md
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map(parseCue)
}
