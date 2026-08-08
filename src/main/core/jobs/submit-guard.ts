import { normalize } from './answers'
import type { ApplyMode, ButtonKind } from './types'

/**
 * El freno. Enviar una postulación es irreversible y el envío automatizado va
 * contra el ToS de LinkedIn — el que arriesga la cuenta es el usuario, así que
 * la decisión es suya y explícita, no un efecto secundario del bucle.
 *
 * La clasificación se hace acá, en el main, sobre el texto del botón. El
 * script que corre en la página también la hace, pero esa respuesta viene de
 * afuera: la que manda es esta.
 */

const ENVIAR =
  /^(submit|send|apply now|submit application|send application|finish|enviar|postular|postularme|enviar solicitud|enviar postulacion|finalizar)\b/

const SIGUIENTE = /^(next|continue|review|siguiente|continuar|revisar|save and continue)\b/

const ABRIR = /^(easy apply|apply|solicitud sencilla|solicitud simple|postularse|aplicar)\b/

export function classifyButton(label: string): ButtonKind {
  const t = normalize(label)
  if (t === '') return 'other'
  // `enviar` antes que `apply`: "Submit application" empieza con submit, pero
  // "Apply now" también es un envío en los portales de una sola pantalla.
  if (ENVIAR.test(t)) return 'submit'
  if (SIGUIENTE.test(t)) return 'next'
  if (ABRIR.test(t)) return 'apply'
  return 'other'
}

/** Si esto devuelve false, el ejecutor NO hace el click. Sin excepciones. */
export function canClick(kind: ButtonKind, mode: ApplyMode): boolean {
  if (mode === 'dry-run') return false
  if (kind === 'submit') return mode === 'auto'
  return true
}

export function explainBlock(kind: ButtonKind, mode: ApplyMode): string {
  if (mode === 'dry-run') return 'modo dry-run: no se toca la página'
  if (kind === 'submit') {
    return 'formulario completo y listo para enviar. El envío queda para vos (modo review)'
  }
  return ''
}
