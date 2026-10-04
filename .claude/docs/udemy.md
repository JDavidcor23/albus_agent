# Bajar un curso de Udemy: transcripts y las capturas que valen

Un curso pago tiene el transcript en el player y los diagramas en el video. Este
módulo se lleva las dos cosas a tu carpeta, y decide **solo** cuáles capturas
vale la pena sacar.

```
Documentos/albus_agent/udemy/
  ultimate-aws-certified-cloud-practitioner-clf-c02/
    curso.json                     el título, la url, qué se bajó
    051-ebs-overview.md            el transcript
    052-about-ebs-multi-attach.md
    052-about-ebs-multi-attach/    las capturas de ESA lección
      1-tabla-comparativa.jpg
```

## Por qué NO transcribe con whisper

Existe el camino y está construido: grabar la pantalla y pasarla por `video/`.
Se midió y pierde por los dos lados.

| | Grabar + whisper | Leer el panel |
|---|---|---|
| Por clase | ~5 min grabar + ~5 min CPU | **~2 segundos** |
| 50 clases | ~8 horas de máquina | **~3 minutos** |
| Texto | ASR local, con alucinaciones sobre los silencios | el de Udemy, ya curado |
| Disco | decenas de GB | kilobytes |

`video/` sigue siendo el camino para grabaciones que SÍ están en disco. Para una
página que ya muestra el texto, es un martillo neumático para colgar un cuadro.

## La parte que no es obvia: cuándo vale una captura

Maarek lee sus bullets. La slide *"What's an EBS Volume?"* dice *"a network
drive you can attach to your instances while they run"* y el audio dice *"it's a
network drive that you can attach to your instances while they run"*. Es la
misma frase. Capturar esa slide guarda el mismo texto dos veces.

**El transcript se basta solo hasta que el tipo señala algo.** *"As you can see
here"*, *"on the right"*, *"this arrow"*: ahí la frase deja de significar nada
sin la imagen. Eso son deícticos, y se detectan leyendo el texto — sin que
ningún modelo mire un solo pixel.

Y lo que más pesa no es un deíctico: es **"the difference between X and Y"**. El
CLF-C02 no pregunta qué hace EBS, pregunta cuál de cuatro servicios parecidos
usar. Esa tabla vale más que las otras capturas juntas.

Tope de tres por clase, a propósito. Con quince no mirás ninguna — que es el
problema que el módulo vino a resolver, solo que automatizado.

## Cómo saca la captura sin computer use

El truco: **la cue del transcript ES el control de posición.**

```
1. click en la cue deíctica   →  el video salta a ese momento
2. pausar                     →  sin motion blur
3. tapar subtítulos y controles (CSS)
4. capturePage()
```

El paso 3 salió de mirar una captura real: la slide decía *"Note: CCP — one EBS
can be only mounted to one EC2 instance. Associate Level: multi-attach
feature…"* y el subtítulo de Udemy, encima, tapaba justo la parte del
multi-attach — o sea, la EXCEPCIÓN a la regla que la slide enseñaba. La captura
salía y parecía correcta.

Se tapa con una regla de CSS y no clickeando el botón de subtítulos: una regla
con `!important` no depende de encontrar el botón, ni de que el menú abra, ni de
que el estado quede como uno cree. Y no le cambia la preferencia al usuario.

## Esto es un agente de Albus, y el agente vive AFUERA

El manifiesto entero, para copiar a `Documentos/albus_agent/agents/`:

```json
{
  "name": "Udemy",
  "description": "Baja los transcripts de un curso y captura solo los diagramas que valen.",
  "needs": ["udemy"],
  "tools": [],
  "screen": "udemy",
  "goals": [
    "Que cada lección VISTA tenga su transcript en disco, y que reanudar no vuelva a bajar lo que ya está.",
    "Que se capture el momento donde el audio deja de bastarse solo, y nada más que ese.",
    "Que una lección que falla cueste una lección y nunca la corrida entera."
  ]
}
```

Borralo y el agente desaparece. Copialo con otro id y tenés dos.

## Qué SÍ es código, y por qué

Un agente de datos **compone primitivas; no las inventa**. Alguien tiene que
escribir el que lee el panel de transcripción.

| Dónde | Qué |
|---|---|
| `core/udemy/curriculum.ts` | filas → lecciones, y el nombre de carpeta. Dominio puro |
| `core/udemy/transcript.ts` | cues → markdown, y las repetidas pegadas. Dominio puro |
| `core/udemy/deictic.ts` | **dónde vale una captura.** Dominio puro |
| `core/udemy/library.ts` | el schema de `curso.json` |
| `udemy/page-scripts.ts` | el JS que corre en Udemy. Listas de candidatos, nunca un selector solo |
| `udemy/run.ts` | el recorrido, con los eventos de progreso |
| `udemy/store.ts` | la biblioteca contra el disco |
| `browser/page.ts` → `runScript` | la primitiva nueva. Constantes de un módulo, NUNCA texto de un modelo |
| `AGENT_NEEDS` → `'udemy'` | la SONDA: ¿hay cookie de sesión? `needs` es dato; saber si está es una función |

`runScript` es la única primitiva que hubo que agregar, y por el mismo motivo
por el que `video-tools` tuvo que entrar al enum: la alternativa era meter
selectores de Udemy en `browser/page.ts`, que no es de Udemy.

## Correrlo

```bash
npm run udemy:check                                  # el dominio, sin navegador
npm run udemy:login                                  # una sola vez, a mano
npm run udemy -- "<url>" --limit 1                   # UNA: valida los selectores
npm run udemy -- "<url>" --section 3                 # una sección completa
npm run udemy -- "<url>" --section 3,4 --every 3     # dos, muestreo más fino
npm run udemy -- "<url>"                             # todas las pendientes
```

`--section` existe porque "bajame la sección 3" es el pedido real: el curso se
estudia por secciones, no por las primeras N filas del índice. Sin él, un
`--limit 9` sobre un curso con seis secciones vistas baja las nueve primeras
del curso entero — que no son las que se pidieron, y el que las pidió se entera
cuando vuelve.

El número de sección sale de las cabeceras del índice. Se leen recorriendo el
panel en orden de documento: una cabecera "Section 3: …" manda sobre todas las
filas que vienen abajo. El texto de una fila no dice a qué sección pertenece,
así que no hay otra forma.

**El login lo hace una persona.** `udemy:login` abre la ventana y espera; nadie
automatiza el usuario y la contraseña de otro. Si el que corre esto es un
agente, la sesión tiene que estar puesta de antes.

**Empezá con el tope en 1.** `udemy:check` prueba el dominio pero no puede
probar lo único que de verdad puede estar mal: el DOM de Udemy es de Udemy.
Descubrir que un selector cambió en la lección 1 cuesta veinte segundos;
descubrirlo en la 50 cuesta la tarde.

Si un script no encuentra lo que busca **no devuelve vacío en silencio**:
devuelve `ok: false` con un `debug` de lo que sí había en la página. Con eso, la
lista de candidatos de `page-scripts.ts` se arregla en dos minutos.

## Cloudflare: el muro que se ve como un selector roto

Udemy está detrás de Cloudflare, y esto es lo primero que hay que descartar
cuando la corrida falla, porque **el síntoma apunta al lugar equivocado**:

```
Error: no pude leer el índice. Abrí el panel "Contenido del curso".
       data-purpose que sí encontré: ninguno
```

Eso invita a ir a tocar `page-scripts.ts`. No lo hagas todavía. **Cero
`data-purpose` en una página de Udemy nunca significa "cambió el selector"**:
una página real tiene decenas. Cero significa que la página cargada no es
Udemy. Comprobalo en un comando, que no toca nada ni gasta cuota:

```bash
npm run nav:inspect -- "<url del curso>" --no-sandbox
```

Si vuelve `título: Just a moment...` con dos ítems clickeables —"Cloudflare" y
"Privacy"— ahí está la respuesta: el documento es el interstitial anti-bot, con
la URL del curso intacta. En el log se ve pasar como dos navegaciones dentro de
la misma página con `?__cf_chl_rt_tk=…`.

Lo que se midió, para no repetir el camino:

| Se probó | Resultado |
|---|---|
| Esperar a que afloje (90 s) | **No afloja.** No es un challenge pasivo |
| Sacar `albus-agent/` y `Electron/` del User-Agent | Necesario, **pero no alcanza solo** |
| Correr con el sandbox puesto (menos huella) | En esta máquina no arranca: `STATUS_DLL_NOT_FOUND` |
| Que una persona pase la verificación | **Lo único que funciona** |

Por eso el User-Agent se limpia en `browser/page.ts` —el string por defecto
termina en `albus-agent/1.0.0 … Electron/38.2.0`, y con eso Cloudflare ni
discute— y por eso `readCurriculumWhenReady` **espera hasta diez minutos** en
vez de rendirse, cuando reconoce el muro por el título.

**El click lo hace una persona, una sola vez.** La ventana de la corrida ya es
visible (el video tiene que renderizar para poder capturarlo), así que está ahí
para eso: pasás la verificación y la corrida sigue sola, con la cookie
`cf_clearance` guardada en la partición para las próximas.

No se le fabrica interacción al widget. Sería un bypass, y además una carrera
que se pierde sola en el próximo deploy de ellos: el código quedaría atado a
adivinar un DOM que existe para no ser adivinado.

## La sesión: que la cookie EXISTA no es que sirva

`hasUdemySession()` mira si hay cookie, no si está viva — y una vencida sigue
en el frasco. Cuando vence, el `/learn/` redirige a
`/join/passwordless-auth/?…&action=login`, que en el log es inconfundible.

El problema es que eso trababa las dos puertas: el run fallaba, y
`udemy:login` contestaba "ya hay una COOKIE de sesión guardada" sin abrir nada.
Peor: forzar la ventana tampoco servía, porque `waitForSession` sondea la MISMA
cookie cada 1500 ms y la cerraba antes de que llegaras a escribir el mail.

Por eso existe el `--force`, que tira la sesión vieja primero:

```bash
npm run udemy:whoami -- --no-sandbox    # ¿me trata como persona logueada?
npm run udemy:login -- --force          # borra y vuelve a abrir la ventana
```

Solo toca `udemy.com`: LinkedIn y Google comparten la partición
`persist:albus-jobs` —el "Continue with Google" de Notion depende de esa— y
vaciar el frasco entero para arreglar Udemy los desloguearía en silencio.

Ojo con `udemy:whoami`: si Cloudflare está puesto, lee el interstitial y dice
`logueado: NO` con la sesión perfecta. Es un falso negativo, no un semáforo.

## Lo que baja y lo que no

Solo las lecciones con el **tilde de vistas**. El transcript de una clase que no
viste no sirve todavía: el material se baja para reescribirlo DESPUÉS de haberla
visto, y bajar el curso entero de una sería juntar trescientos archivos que
nadie va a leer.

Y cada `.md` lleva adentro la marca de PRIVADO. Un `.gitignore` protege un repo;
el archivo se va a copiar y se va a abrir en otra carpeta, y ahí el único que
sigue avisando es el texto de adentro.
