/**
 * Saca el CHROME del texto que devuelve el OCR.
 *
 * Dominio puro: no importa electron, ni supabase, ni ningún CLI. Escalón 3 —
 * reglas, gratis, instantáneo.
 *
 * ---------------------------------------------------------------------------
 * Por qué existe este archivo
 * ---------------------------------------------------------------------------
 * Una captura de pantalla de celular no es una foto de un documento: arriba
 * lleva la barra de estado del teléfono y abajo/al medio la del navegador. El
 * OCR las lee igual que el contenido, y salen así (datos reales, entry 90d8397e):
 *
 *     9:14 új -- all = ED +
 *     (A <s hallos.io/u/Ox8ddd4be8 + (6) :
 *     3 = 8
 *     HALLOS - ®
 *     EA
 *     ...
 *     Cripto Latin Fest 2026 92 Edición Bogotá
 *     26 Agosto: Business Day
 *     27 y 28 de Agosto: Evento general
 *     4
 *     Lo
 *     Mi, KA
 *
 * El `9:14` es la HORA del teléfono y `új -- all = ED +` son los iconos de señal
 * y batería que tesseract no supo leer. El dato bueno — el nombre y las fechas
 * del evento — estaba enterrado debajo de la barra de notificaciones del usuario.
 *
 * Nada de esto se puede resolver con un modelo: es estructura, no semántica. Y
 * pagar cuota para que una IA nos diga que "9:14" es un reloj sería absurdo.
 *
 * ---------------------------------------------------------------------------
 * Limpia para LEER, no para extraer
 * ---------------------------------------------------------------------------
 * Esta función se aplica al MOSTRAR, no al guardar. El payload sigue teniendo el
 * texto crudo, por dos razones:
 *
 *   1. Los emails y links se buscan sobre el CRUDO. La barra de direcciones es
 *      ruido para leer pero puede ser el único lugar donde quedó una URL.
 *   2. Un heurístico que borra de más tiene que ser auditable. Si el crudo se
 *      pierde en la extracción, no hay forma de saber qué se comió.
 */

/** Tokens separados por espacios, sin los vacíos. */
function tokens(linea: string): string[] {
  return linea.split(/\s+/).filter((t) => t.length > 0)
}

/** Solo letras y dígitos, sin acentos ni símbolos. */
function alnum(texto: string): string {
  return texto.replace(/[^0-9a-záéíóúüñ]/gi, '')
}

/**
 * ¿La línea es la barra de estado del teléfono?
 *
 * Se pide que ARRANQUE con un reloj. La posición importa: un "19:30" en el medio
 * del texto es la hora de un evento y hay que conservarla — por eso el llamador
 * solo aplica esto a la primera línea.
 */
function pareceReloj(linea: string): boolean {
  return /^\d{1,2}[:.]\d{2}\b/.test(linea.trim())
}

/**
 * ¿Es basura de iconos?
 *
 * Ninguno de sus tokens llega a 3 caracteres alfanuméricos. Mata `4`, `Lo`, `ha`,
 * `EA`, `3 = 8` y `Mi, KA` — que son glifos mal leídos, no palabras.
 *
 * El umbral es sobre alfanuméricos y no sobre letras para que `2026` sobreviva:
 * ante la duda preferimos conservar un año suelto antes que perder un dato.
 */
function sonTodosTokensCortos(linea: string): boolean {
  return tokens(linea).every((t) => alnum(t).length < 3)
}

/**
 * ¿Proporción de símbolos demasiado alta?
 *
 * Mata la barra de direcciones (`(A <s hallos.io/u/Ox8ddd4be8 + (6) :` da 30%) y
 * los fragmentos de wallet (`0x8dd...af18 |` da 31%).
 *
 * Conserva lo que importa, con margen cómodo: `26 Agosto: Business Day` da 5%,
 * `Bogotá - Colombia` 6%, y un email 8% — el `@` y el punto no lo condenan.
 */
function demasiadosSimbolos(linea: string): boolean {
  const sinEspacios = linea.replace(/\s/g, '')
  if (sinEspacios.length === 0) return true

  const simbolos = sinEspacios.length - alnum(sinEspacios).length
  return simbolos / sinEspacios.length > 0.25
}

/**
 * ¿Tiene varios GLIFOS sueltos?
 *
 * Un glifo es un token de 1-2 caracteres alfanuméricos con alguna MAYÚSCULA:
 * `Q`, `E)`, `X`, `[O`, `Dx`, `EA`. Es como el OCR lee los iconos de una barra de
 * herramientas. Dos o más en la misma línea y la línea es chrome:
 *
 *     o Q I'm looking for... E)              ← el buscador de LinkedIn
 *     EER] X roto Stonipanda io [O stars Dx  ← los badges de un repo
 *
 * La mayúscula es lo que hace la regla segura EN ESPAÑOL. Contar simplemente
 * "tokens cortos" mataría `27 y 28 de Agosto: Evento general` — que tiene cuatro
 * (`27`, `y`, `28`, `de`) y es justo la línea que el usuario necesita leer. Las
 * palabras cortas del español van en minúscula; los iconos, no.
 */
function demasiadosGlifos(linea: string): boolean {
  const glifos = tokens(linea).filter((t) => {
    const limpio = alnum(t)
    return limpio.length > 0 && limpio.length <= 2 && /[A-ZÁÉÍÓÚÜÑ]/.test(limpio)
  })
  return glifos.length >= 2
}

/** Iconos pegados al principio o al final: `Compartir perfil <` → `Compartir perfil`. */
function sacarSimbolosDeLosBordes(linea: string): string {
  return linea
    .split(/\s+/)
    .filter((t, i, todos) => {
      const esBorde = i === 0 || i === todos.length - 1
      return !esBorde || alnum(t).length > 0
    })
    .join(' ')
    .trim()
}

/**
 * Texto legible para un humano, o cadena vacía si no quedó nada.
 *
 * Nunca lanza: un OCR ilegible devuelve '' y el llamador decide qué decir. Que
 * una captura no se pueda leer no puede tumbar el detalle entero.
 */
export function limpiarOcr(bruto: string): string {
  const lineas = bruto.split(/\r?\n/)
  const salida: string[] = []
  const vistas = new Set<string>()
  let primeraUtil = true

  for (const cruda of lineas) {
    const linea = cruda.trim()
    if (linea.length === 0) continue

    // La barra de estado solo puede ser la primera línea con contenido.
    if (primeraUtil && pareceReloj(linea)) {
      primeraUtil = false
      continue
    }
    primeraUtil = false

    if (sonTodosTokensCortos(linea)) continue
    if (demasiadosSimbolos(linea)) continue
    if (demasiadosGlifos(linea)) continue

    const limpia = sacarSimbolosDeLosBordes(linea)
    if (limpia.length === 0) continue

    // Las capturas repiten cabeceras ("Tus Tickets") entre pantallas contiguas.
    const clave = alnum(limpia).toLowerCase()
    if (clave.length === 0 || vistas.has(clave)) continue
    vistas.add(clave)

    salida.push(limpia)
  }

  return salida.join('\n')
}

/**
 * ¿Parece una palabra de verdad?
 *
 * Tres o más alfanuméricos con MAYÚSCULAS CONSISTENTES: todo minúscula, solo la
 * inicial, o todo mayúscula. Una palabra real cumple una de las tres; el OCR
 * fallado produce `COmunid`, `iLooking`, `ZE` — mayúsculas en el medio.
 */
function pareceePalabra(token: string): boolean {
  const t = alnum(token)
  if (t.length < 3) return false
  return t === t.toLowerCase() || t === t.toUpperCase() || /^[A-ZÁÉÍÓÚÜÑ][^A-ZÁÉÍÓÚÜÑ]*$/.test(t)
}

/**
 * ¿El texto limpio se puede leer, o el OCR falló en origen?
 *
 * Esto NO es lo mismo que limpiar. `limpiarOcr` saca el marco del teléfono; acá
 * la pregunta es si lo que quedó adentro significa algo. En los datos reales, la
 * foto del cartel del meetup salió así:
 *
 *     ei € mea a | ie
 *     Lo COmunid
 *     Jnicamente nidad q
 *
 * Ninguna regla puede rescatar eso porque el dato nunca estuvo. Mostrar una
 * versión ordenada de basura es peor que decir "no se pudo leer": lo primero
 * hace dudar al usuario de su propia lectura, lo segundo le dice que abra la
 * imagen.
 *
 * 0.45 sale de los datos: el cartel ilegible da 0.27 y la captura del grupo de
 * Meetup — `Unete a AWS User Group Serverles / Mestup Linked`, imperfecta pero
 * perfectamente entendible — da 0.71. El umbral va entre las dos.
 */
export function esLegible(textoLimpio: string): boolean {
  const todos = tokens(textoLimpio.replace(/\n/g, ' ')).filter((t) => alnum(t).length > 0)
  if (todos.length === 0) return false

  const palabras = todos.filter(pareceePalabra).length
  return palabras / todos.length >= 0.45
}

/**
 * Backstop: descarta una captura cuando la limpieza se llevó casi todo.
 *
 * ATENCIÓN — esto NO alcanza para distinguir una foto de una captura de pantalla,
 * y el intento de usarlo para eso falló. Sobre las once fotos de una nota real
 * mató las cuatro peores (0% y 5% conservado) y dejó pasar las del medio, que
 * conservan 30-80% y siguen produciendo `Fr [aos` e `iaa | Esti,`.
 *
 * La conclusión de ese fracaso está en `esFotoDeCamara`: quién decide es el TIPO
 * DE ARCHIVO, no la forma del texto. Esto queda solo como red de seguridad para
 * una captura de pantalla que salga rarísima.
 */
export function conservaSuficiente(bruto: string, limpio: string): boolean {
  const original = bruto.replace(/\s/g, '').length
  if (original === 0) return false
  return limpio.replace(/\s/g, '').length / original >= 0.15
}

/**
 * ¿El archivo es una FOTO de cámara y no una captura de pantalla?
 *
 * ---------------------------------------------------------------------------
 * Por qué esta pregunta y no otra
 * ---------------------------------------------------------------------------
 * El OCR de una foto no es "OCR degradado": es OCR de algo que nunca fue texto
 * renderizado. Un cartel fotografiado de costado, con reflejo y desenfoque, da
 * cientos de caracteres inventados. Sobre los 28 adjuntos reales:
 *
 *     FOTO (IMG_…)          13 archivos · OCR conservado 17%
 *     CAPTURA (Screenshot)  10 archivos · OCR conservado 84%
 *
 * 17% contra 84%, con 13 y 10 archivos de cada lado. Esa es la separación de
 * verdad, y no la da ninguna medición sobre el texto — la da el tipo de archivo.
 *
 * Se probaron cuatro heurísticas de texto antes de esto (tokens cortos, ratio de
 * símbolos, glifos con mayúscula, proporción conservada) y las cuatro se filtran,
 * porque `iaa | Esti,` parece palabras y distinguirlo necesitaría un diccionario.
 * Es la misma lección que el QR cifrado: identificar por lo que la cosa ES, no
 * por los bytes que produce.
 *
 * Frágil en un punto y hay que saberlo: depende de cómo nombra los archivos el
 * teléfono. Lo robusto sería leer el EXIF con `sharp` — una foto trae marca de
 * cámara, una captura no — pero eso hay que registrarlo al extraer, y hoy la
 * única pista disponible sobre lo ya procesado es el nombre.
 */
export function esFotoDeCamara(attachmentPath: string): boolean {
  const nombre = (attachmentPath.split('/').pop() ?? '')
    // El uploader le prefija un uuid al nombre original.
    .replace(/^[0-9a-f-]{36}-/i, '')

  return /^(IMG[_-]\d|PXL[_-]\d|DSC[_-]?\d|DSCN\d|photo[_-]?\d|\d{8}_\d{6})/i.test(nombre)
}

/**
 * Fusiona varias capturas del mismo tipo en UN texto legible.
 *
 * ---------------------------------------------------------------------------
 * Por qué fusionar y no elegir
 * ---------------------------------------------------------------------------
 * El usuario capturó su pantalla de tickets dos veces, con distinto scroll, y la
 * UI le mostró dos bloques casi idénticos. Su queja fue exacta: "si ya tengo una,
 * ya cualquiera me sirve".
 *
 * El primer intento fue medir el parecido entre las dos y descartar la repetida.
 * Sobre los datos reales ese parecido dio 0.67 — justo por debajo de cualquier
 * umbral defendible. Y bajar el umbral hasta que ESTE caso pase es afinar contra
 * un solo dato: la próxima captura lo rompe.
 *
 * Fusionar no necesita umbral. Se unen las líneas de todas las capturas en orden
 * de aparición y se descartan las repetidas — que es justo lo que comparten dos
 * fotos del mismo scroll. Una sola vista, sin perder una línea, sin una constante
 * que haya que justificar.
 *
 * Lo que sí se pierde es qué línea vino de qué imagen. No importa: el llamador
 * conserva los links a todas las originales, y para LEER qué es esto la pregunta
 * nunca fue "¿en cuál de las cinco capturas estaba?".
 *
 * ---------------------------------------------------------------------------
 * El filtro va ANTES de fusionar, y el orden no es un detalle
 * ---------------------------------------------------------------------------
 * Una nota real tenía 11 capturas: unas pocas legibles y varias donde el OCR
 * falló del todo. Fusionando primero y midiendo después, el promedio pasaba el
 * umbral — las buenas tapaban a las malas — y la basura entraba igual, ahora
 * mezclada con el contenido bueno y por lo tanto imposible de distinguir.
 *
 * Cada captura se juzga sola. Una imagen ilegible no aporta nada que sumar.
 */
export function fusionarCapturas(textos: string[]): string {
  const salida: string[] = []
  const vistas = new Set<string>()

  for (const texto of textos) {
    const limpio = limpiarOcr(texto)
    // Dos preguntas distintas: `esLegible` mira si lo que quedó parece palabras,
    // `conservaSuficiente` si quedó lo bastante como para ser contenido y no
    // sobrevivientes de casualidad. Una foto ilegible pasa la primera y falla la
    // segunda — por eso hacen falta las dos.
    if (!esLegible(limpio) || !conservaSuficiente(texto, limpio)) continue

    for (const linea of limpio.split('\n')) {
      if (linea.length === 0) continue
      const clave = alnum(linea).toLowerCase()
      if (clave.length === 0 || vistas.has(clave)) continue
      vistas.add(clave)
      salida.push(linea)
    }
  }

  return salida.join('\n')
}
