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

const SUBMIT =
  /^(submit|send|apply now|submit application|send application|finish|enviar|postular|postularme|enviar solicitud|enviar postulacion|finalizar)\b/

const NEXT = /^(next|continue|review|siguiente|continuar|revisar|save and continue)\b/

/*
 * ## Acá había un tercer grupo, `OPEN`, y se BORRÓ. Es la parte importante.
 *
 * Era la lista de los botones que abren una postulación: `easy apply`, `apply`,
 * `solicitud sencilla`, `postularse`, `aplicar`. Servía para que el bucle
 * apretara solo el botón que lleva al formulario. Se fue por dos razones, y la
 * segunda es la grave.
 *
 * **1. No resolvía el problema, lo corría.** El botón real de una vacante
 * externa en LinkedIn en español dice "Solicitar", que no estaba. Agregarlo
 * habría dejado afuera "Postúlate", el mismo botón en portugués, y el ATS que lo
 * llame distinto. Es exactamente la trampa que este repositorio ya documentó en
 * `.claude/docs/connections.md`: *"automatizar la UI de un tercero con
 * `clickText([...])` es apostar a que el botón siga diciendo eso. Se perdió dos
 * veces"*. La conclusión de ahí fue `achieveGoal` —el modelo MIRA la pantalla— y
 * ahora el bucle de postulación la usa también. Mantener las dos formas de
 * decidir lo mismo era el defecto de fondo, no un detalle.
 *
 * **2. Era un agujero para enviar sin permiso.** Todo lo que caía en `OPEN`
 * quedaba clasificado `apply`, y `canClick('apply', 'review')` devuelve `true`:
 * se apretaba sin que nadie mirara. Un ATS de una sola pantalla cuyo botón final
 * diga solo "Apply" caía ahí —`SUBMIT` tiene `apply now`, no `apply`— y la
 * postulación se enviaba en modo `review`. Irreversible, y en silencio.
 *
 * Lo que queda —`SUBMIT` y `NEXT`— NO es automatización: es el FRENO. Su trabajo
 * es reconocer lo que no hay que apretar, y por eso no puede decidirlo un
 * modelo: el freno tiene que valer incluso cuando el modelo se equivoca o cuando
 * la página está armada para engañarlo. Un freno hecho de salida de modelo no es
 * un freno. Ante la duda, estas regex clasifican hacia `submit`, que queda
 * bloqueado — el error cae siempre del lado de no enviar.
 */

export function classifyButton(label: string): ButtonKind {
  const t = normalize(label)
  if (t === '') return 'other'
  // `enviar` antes que `apply`: "Submit application" empieza con submit, pero
  // "Apply now" también es un envío en los portales de una sola pantalla.
  if (SUBMIT.test(t)) return 'submit'
  if (NEXT.test(t)) return 'next'
  // Todo lo demás es `other`: el bucle no lo aprieta, y llegar al formulario es
  // trabajo del agente que mira la pantalla, no de una lista de palabras.
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
