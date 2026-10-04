/**
 * Donde vale la pena una captura, leyendo SOLO el texto.
 *
 * ## El problema medido
 *
 * Maarek lee sus bullets. La slide "What's an EBS Volume?" dice *"a network
 * drive you can attach to your instances while they run"* y el audio dice
 * *"it's a network drive that you can attach to your instances while they
 * run"*. Es la misma frase. Capturar esa slide guarda el mismo texto dos veces.
 *
 * Capturar TODO tampoco es gratis aunque la maquina lo haga sola: trescientas
 * imagenes que nadie mira valen menos que tres que si, y encima hay que
 * mirarlas para saber cual servia.
 *
 * ## La senal
 *
 * El transcript se basta solo **hasta que el tipo senala algo**. "As you can
 * see here", "on the right", "this arrow": ahi la frase deja de significar
 * nada sin la imagen. Eso son DEICTICOS —palabras que apuntan afuera del
 * texto— y son detectables sin mirar un solo pixel.
 *
 * Esa es toda la idea, y es a proposito que sea tan barata: no hace falta un
 * modelo mirando frames para saber que "as you can see here" necesita imagen.
 */

import type { Cue } from './transcript'

interface Marca {
  re: RegExp
  peso: number
  que: string
}

/**
 * Los deicticos. En ingles porque el curso esta en ingles.
 *
 * Los patrones NO se solapan a proposito: `as you can see` y `you can see
 * here` como reglas separadas sumaban 6 a la misma linea y la mandaban arriba
 * de una tabla comparativa, que vale mas. Una senal, una regla.
 */
const DEICTICOS: Marca[] = [
  { re: /\b(?:as )?you can see\b/i, peso: 3, que: 'senala la pantalla' },
  { re: /\b(?:on|in) (?:this|the) (?:diagram|schema|drawing|picture|image)\b/i, peso: 3, que: 'diagrama' },
  { re: /\bthe following (?:diagram|schema|example)\b/i, peso: 3, que: 'diagrama' },
  { re: /\b(?:here|there) (?:we|you) (?:have|see)\b/i, peso: 3, que: 'senala la pantalla' },
  { re: /\bthis (?:arrow|box|line|circle|square)\b/i, peso: 3, que: 'elemento grafico' },
  { re: /\blet me show you\b/i, peso: 3, que: 'demo en pantalla' },
  { re: /\b(?:on|to) the (?:left|right|top|bottom)\b/i, peso: 2, que: 'posicion en pantalla' },
  { re: /\bover (?:here|there)\b/i, peso: 2, que: 'senala la pantalla' },
  { re: /\bright here\b/i, peso: 2, que: 'senala la pantalla' },
  { re: /\btake a look at\b/i, peso: 2, que: 'mira la pantalla' },
  { re: /\bas shown\b/i, peso: 2, que: 'referencia visual' }
]

/**
 * Lo que vale una captura aunque nadie senale nada.
 *
 * **Pesa mas que cualquier deictico, y por una razon concreta:** el CLF-C02 es
 * un examen de discriminacion. No pregunta que hace EBS, pregunta cual de
 * cuatro servicios parecidos usar. EBS vs EFS vs Instance Store vs S3,
 * Security Group vs NACL, Role vs User. Maarek casi siempre pone esa
 * comparacion en una tabla, y el audio la recita sin estructura: "the first
 * one is... and the second one is..." no se puede estudiar.
 *
 * Esa tabla vale mas que las otras capturas juntas.
 */
const COMPARACIONES: Marca[] = [
  { re: /\b\w+ (?:vs\.?|versus) \w+\b/i, peso: 5, que: 'TABLA COMPARATIVA' },
  { re: /\bthe difference between\b/i, peso: 5, que: 'TABLA COMPARATIVA' },
  { re: /\bcompared to\b/i, peso: 2, que: 'comparacion' }
]

const MARCAS: Marca[] = [...COMPARACIONES, ...DEICTICOS]

/**
 * Tres por clase.
 *
 * El limite es la mitad del valor de esto. Sin tope, una clase con diagrama
 * marca quince momentos, se bajan quince imagenes y no se mira ninguna —que es
 * exactamente el problema que el modulo vino a resolver, solo que automatizado.
 */
export const MAX_SHOTS = 3

export interface Shot {
  peso: number
  razones: string[]
  cue: Cue
  /** La cue y las dos siguientes. */
  contexto: string
}

/**
 * Los momentos que valen captura, el mas fuerte primero.
 *
 * El contexto viaja con cada uno porque `as you can see` sola es incontestable
 * tres dias despues: dice que hay que mirar, no QUE se estaba mirando. Es el
 * mismo motivo por el que `agents/questions.ts` guarda `contexto` al lado de
 * cada pregunta encolada.
 */
export function findShots(cues: Cue[], max: number = MAX_SHOTS): Shot[] {
  const hits: Shot[] = []

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]
    let peso = 0
    const razones = new Set<string>()

    for (const marca of MARCAS) {
      if (marca.re.test(cue.text)) {
        peso += marca.peso
        razones.add(marca.que)
      }
    }

    if (peso === 0) continue

    hits.push({
      peso,
      razones: [...razones],
      cue,
      contexto: cues
        .slice(i, i + 3)
        .map((c) => c.text)
        .join(' ')
    })
  }

  // Estable: a igual peso manda el orden de la clase, que es el del relato.
  return hits.sort((a, b) => b.peso - a.peso).slice(0, max)
}
