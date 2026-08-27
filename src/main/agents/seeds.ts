import type { AgentManifest } from './manifest'

/**
 * Los agentes que la app trae de fábrica, como SEMILLAS.
 *
 * ## Qué es una semilla y qué no
 *
 * Se planta una vez en `userData/agentes/` y desde ese momento manda el archivo,
 * no esto. Si el usuario edita el `.json`, gana el usuario. Si lo borra, se
 * vuelve a plantar al abrir la pestaña. Nunca se sobrescribe algo que exista.
 *
 * Es el mismo trato que ya tenían las reglas: la plantilla es papel con
 * renglones, y lo que vale es lo que el usuario escriba encima.
 *
 * ## Por qué esto NO es "el array de agentes de vuelta"
 *
 * La diferencia es quién manda en tiempo de ejecución. Antes `registry.ts` leía
 * el array: el código ERA la lista, y un agente que el usuario escribiera no
 * existía. Ahora `registry.ts` lee la carpeta y este archivo solo aporta el
 * contenido inicial de UN archivo. Un agente nuevo no pasa por acá.
 *
 * Y la prueba de que la distinción es real: el agente de trabajo recorre
 * exactamente el mismo camino que uno escrito a mano. Si fuera un caso especial,
 * el camino del usuario no se probaría nunca.
 *
 * ## Y por qué acá hay UNO solo
 *
 * Porque una semilla es una excepción, no la forma de sumar agentes. El de
 * trabajo está porque la app tiene que arrancar mostrando algo. El de extracción
 * de video **no está acá a propósito**: es un archivo en la carpeta del usuario,
 * y su plantilla vive en `.claude/docs/video-analysis.md` para copiar y pegar.
 * Ese es el camino que importa — si cada agente nuevo terminara en este archivo,
 * "contenedor de agentes" sería una forma elegante de decir "hay que compilar".
 */

export interface AgentSeed {
  id: string
  manifest: Omit<AgentManifest, 'id' | 'path'>
  rulesTemplate: string
}

/**
 * La plantilla de reglas del agente de trabajo.
 *
 * En castellano a propósito: esto no es código, es lo que el USUARIO abre y lee
 * en su editor.
 *
 * Los links van comentados con `<!--` a propósito: el parser saltea esas líneas,
 * así que la plantilla NO se autoconfigura con un ejemplo. El usuario pega los
 * suyos y recién ahí empiezan a contar.
 */
const JOB_SEARCH_RULES = `# Búsqueda de trabajo — reglas

Este archivo lo leés vos y lo lee el agente. Escribí en castellano: no hay
formato que aprender. Lo único que el código extrae son los **links** de Notion
y de Google Drive; el resto del texto le llega al agente como contexto.

## Dónde registrar las postulaciones

Pegá acá el link de la base de Notion donde llevás el tracker. El primero de la
lista es el que se usa para escribir.

<!-- Ejemplo (borrá el comentario y pegá el tuyo):
- Registro de aplicaciones: https://www.notion.so/00000000000000000000000000000000
-->

## Carpetas de Drive

Dónde dejar los CV y las cartas, si querés archivarlos.

<!-- - CVs: https://drive.google.com/drive/folders/xxxxxxxxxxxxxxxxx -->

## Qué buscar

- Roles:
- Ubicación:
- Modalidad:

## Qué NO quiero

Escribí acá lo que hay que descartar aunque puntúe alto. El agente lo respeta.

-

## Notas para el agente

Cualquier cosa que quieras que tenga en cuenta al puntuar o al postularse.

-
`

export const JOB_SEARCH_SEED: AgentSeed = {
  id: 'job-search',
  rulesTemplate: JOB_SEARCH_RULES,
  manifest: {
    name: 'Job search',
    description: 'Finds openings, scores them against your profile, applies and updates Notion.',
    needs: ['workspace', 'linkedin', 'notion', 'google'],
    /*
     * Vacío = todas las capacidades que la app tenga.
     *
     * Es lo correcto para el de fábrica y es la palanca del formato: un agente
     * de LinkedIn que solo publique contenido se escribe con
     * `"tools": ["buscar", "subir_a_drive"]` y no puede postularse aunque el
     * modelo lo intente. Recortar lo que un agente PUEDE hacer es dato; qué hace
     * cada capacidad es código.
     */
    tools: [],
    /*
     * Su pantalla, como DATO.
     *
     * Antes el renderer la buscaba por el ID del agente, y eso volvía imposible
     * lo que Albus dice ser: un agente escrito a mano no podía tener cara nunca,
     * porque su id no estaba en un mapa del código fuente.
     */
    screen: 'job-chat',
    /*
     * Los objetivos: el flujo del agente como DATO.
     *
     * Dicen qué tiene que ser verdad al terminar, no qué botón apretar — misma
     * regla que los objetivos de `connections/services.ts`. El usuario los puede
     * reescribir sin tocar el código, y ahí es donde su flujo empieza a vivir
     * donde viven sus reglas.
     */
    goals: [
      'Encontrar vacantes que encajen con lo que el usuario escribió en sus reglas, y descartar lo que pidió descartar aunque puntúe alto.',
      'Antes de postularse, tener el CV y la carta armados para ESA empresa: un CV genérico es peor que no postularse.',
      'Llenar el formulario con datos reales del perfil. Un campo que no se pueda contestar sin inventar se deja vacío y se reporta.',
      'Nunca enviar una postulación sin que el usuario lo pida: se deja lista y se avisa.',
      'Dejar registrado en el tracker lo que pasó de verdad, no lo que se esperaba que pasara.'
    ]
  }
}

export const SEEDS: AgentSeed[] = [JOB_SEARCH_SEED]
