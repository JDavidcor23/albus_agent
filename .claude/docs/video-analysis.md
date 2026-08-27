# Transcribir un video y sacarle capturas

Claude **no acepta video ni audio**. Nunca. La única entrada visual son imágenes
fijas — JPEG, PNG, GIF, WebP — y de un GIF animado se usa **solo el primer
frame**, en silencio, sin avisar. Así que "analizá este video" no existe como
operación: hay que convertirlo antes en dos cosas que sí entra, **frames + un
transcript con timestamps**, y pasarle eso como un turno multimodal normal.

Este documento es esa conversión. Todos los números de acá se midieron contra un
archivo real de esta máquina: una reunión grabada de 58:24, 1280x720 a 30 fps,
h264 + aac, **2,7 GB**.

> **No creas a los blogs.** Circulan posts (aidailyshot.com y compañía) diciendo
> que Anthropic sacó una API de video en tiempo real en 2026. Es **falso**, lo
> contradice la doc oficial. Y el issue de video nativo en Claude Code
> (`anthropics/claude-code#32130`) se cerró como *not-planned*.

## El camino corto

Tres comandos. Rutas de salida **fuera del repo** — el porqué está en
[Antes de correr nada](#antes-de-correr-nada).

```bash
V="2026-08-27 08-55-56.mp4"   # el video
OUT="$TEMP/video-out"          # carpeta de trabajo, NO el repo
mkdir -p "$OUT"

# 1. audio para whisper: mono, 16 kHz, PCM. Es el formato que el modelo quiere.
ffmpeg -y -v error -i "$V" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$OUT/audio.wav"

# 2. transcript con timestamps
PYTHONUTF8=1 whisper "$OUT/audio.wav" --model small --language Spanish \
  --output_format srt --output_dir "$OUT"

# 3. frames: uno por minuto, a 640x360
ffmpeg -y -v error -i "$V" -vf "fps=1/60,scale=640:-2" -q:v 4 "$OUT/f_%03d.jpg"
```

Después le pasás a Claude los `.jpg` + el `.srt`. El `.srt` es lo que ancla cada
frame a un momento del audio; sin él las imágenes son 58 capturas sueltas sin
relato.

### Esto es un agente de Albus, y el agente vive AFUERA

Los comandos de arriba son para entender qué pasa por debajo. Para usarlo hay un
agente, `video-extraction`: abre un diálogo, elige la grabación y deja la carpeta
armada en `video/<nombre>/`.

**Ese agente no está en el código fuente, y eso no es un detalle.** Albus es un
contenedor de agentes: si cada agente nuevo terminara en `seeds.ts` y en un mapa
del renderer, "contenedor de agentes" sería una forma elegante de decir "hay que
compilar". El agente es **un archivo tuyo**:

```
Documentos/albus_agent/agents/
  video-extraction.agente.json   ← quién es, qué necesita, qué pantalla usa
  video-extraction.md            ← tus notas
```

El manifiesto entero, para copiar:

```json
{
  "name": "Video extraction",
  "description": "Turns a local recording into a transcript plus one screenshot per minute.",
  "needs": ["video-tools"],
  "tools": [],
  "screen": "video",
  "goals": [
    "Que exista un transcript sin texto inventado sobre los silencios.",
    "Que cada captura esté anclada al minuto de audio que le corresponde."
  ]
}
```

Borralo y el agente desaparece. Cambiale el nombre y se llama distinto. Copialo
con otro id y tenés dos.

### Qué SÍ es código, y por qué

Un agente de datos **compone primitivas; no las inventa**. Alguien tiene que
escribir el que corre ffmpeg:

| Dónde | Qué |
|---|---|
| `src/main/core/video/transcript.ts` | parseo, pegado de tramos y **filtro de alucinaciones**. Dominio puro |
| `src/main/core/video/page.ts` | el HTML único. Recibe los frames en base64, no lee disco |
| `src/main/video/ffmpeg.ts` · `whisper.ts` | los binarios. `where`, flags en array, timeout duro |
| `src/main/video/run.ts` | los cinco pasos en orden, con los eventos de progreso |
| `AGENT_NEEDS` → `'video-tools'` | la SONDA que busca los binarios. `needs` es dato; saber si están es una función |
| `SCREENS` → `'video'` | la pantalla. Cuál usar es dato; dibujarla es código |

**Los dos campos nuevos del formato salieron de acá.** `'video-tools'` tuvo que
entrar al enum `AGENT_NEEDS` porque el schema descarta en silencio una necesidad
que no conoce: un `"needs": ["ffmpeg"]` quedaba en `[]` y el agente se pintaba
disponible en una máquina sin nada instalado. Y `screen` no existía: el renderer
buscaba el componente por **id de agente**, así que un agente escrito a mano no
podía tener cara nunca.

```bash
npm run video:check                              # dominio + que el agente se lea de la carpeta
npm run video:check -- "grabacion.mp4" 210       # el pipeline entero sobre 210s
```

**No hay una segunda implementación de esto.** Hubo tres `.mjs` sueltos en
`scripts/video/` mientras se investigaba y se borraron al portarlos: dos copias
del filtro de alucinaciones divergen, y la copia del script iba a ser la vieja
justo cuando alguien la necesite.

## Qué hay instalado acá

| Herramienta | Estado |
|---|---|
| `ffmpeg` / `ffprobe` | 8.0.1 (gyan.dev, vía choco) — ✅ |
| `openai-whisper` | 20250625 — ✅ |
| `agy` (Gemini) | ✅ en `%LOCALAPPDATA%\agy\bin\agy.exe` |
| `faster-whisper` | ❌ no instalado (`pip install faster-whisper`) |
| `yt-dlp` | ❌ no instalado |
| GPU para whisper | ❌ `torch 2.9.1+cpu`, `cuda=False` — **todo corre en CPU** |

## Transcripción

### Elegí el modelo por tiempo, no por optimismo

Medido sobre el **mismo recorte de 120 segundos** de audio de esa reunión:

| Modelo | Tiempo real | Factor | Extrapolado a 58 min |
|---|---|---|---|
| `base` (139 MB) | 2m 04s | ~1,0x | **~1 hora** |
| `small` (461 MB) | 4m 10s | ~2,1x | **~2 horas** |

Esos factores son de CPU. No hay atajo por hardware acá.

**Y `base` no alcanza para español de negocios.** La misma frase, los dos
modelos:

- `base` → "toda la parte de los **bordin**" · "acepta o rechaza **la beja**" ·
  "**protecimiento pantalla**" · "**nex HDMI**"
- `small` → "toda la parte de los **bording**" · "acepta o rechaza **la beca**" ·
  "**comparto pantalla**" · "**nex academy**"

`base` inventa palabras que no existen y te obliga a re-escuchar el audio para
saber qué dijeron. Eso no es un transcript, es una pista. **Arrancá en `small`.**

Si dos horas es demasiado: `pip install faster-whisper` (CTranslate2, int8) es el
reemplazo directo y bastante más rápido en CPU — **no está medido acá**, es la
recomendación pendiente de verificar.

### Recortá antes de comprometer dos horas

Nunca lanzes el video entero de una. `-ss` **antes** de `-i` hace seek rápido: el
recorte de 120s de un archivo de 2,7 GB tardó **0,377 segundos**.

```bash
# 120 s a partir del minuto 5, para probar calidad y acento
ffmpeg -y -v error -ss 300 -t 120 -i "$V" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$OUT/slice.wav"
```

Escuchá el resultado de `small` sobre el recorte. Recién ahí decidís si vale la
corrida completa.

### Cortá en tramos y corré de a dos: es casi el doble de rápido

Una corrida de dos horas **no sobrevive**. Se probó dos veces en background y
las dos murieron a mitad de camino. Y whisper escribe los archivos **recién al
terminar**: si lo matan, no queda ni un `.srt`.

Lo que sí funciona: cortar el audio en tramos de 3 minutos y correr **dos en
paralelo**, con los hilos repartidos.

```bash
ffmpeg -y -v error -i audio.wav -f segment -segment_time 180 -c copy "chunks/c_%02d.wav"

cd chunks && export PYTHONUTF8=1
for n in 00 01; do
  OMP_NUM_THREADS=6 whisper "c_$n.wav" --model small --language Spanish \
    --output_format srt --output_dir . > "c_$n.log" 2>&1 &
done; wait
```

| Modo | 6 min de audio |
|---|---|
| Serie (1 proceso, 12 hilos) | ~12m 30s |
| **2 en paralelo, 6 hilos c/u** | **6m 38s** |

En una máquina de 12 cores, dos procesos rinden casi el doble. **Tres con 4 hilos
cada uno rinde menos** y se pasa de los 10 minutos — se probó y falló.

Después hay que pegar los tramos corriendo cada timestamp por
`offset = inicio_del_tramo`. Y si igual te matan una corrida, **el log tiene el
transcript**: whisper imprime cada línea a stdout a medida que avanza, así que de
una corrida muerta a los 32 minutos se rescatan los 32 minutos.

### Whisper INVENTA sobre el silencio

Este es el que muerde. Si la grabación sigue corriendo después de que la reunión
terminó, whisper no escribe silencio: **escribe texto**. Lo que salió acá, sobre
diez minutos de sala vacía:

```
[00:56:13] ¿Conoce?      [00:56:43] Gracias.
[00:56:14] Sí.           [00:56:53] Gracias.
[00:56:15] Ok.           [00:57:19] Ahhhh.
[00:56:16] Ok.           [00:55:43] No vamos aıyorsunar o restaurantes.
```

Cues de **exactamente un segundo**, muletillas repetidas, y frases con caracteres
de otro alfabeto (esa `ı` es turca). Un transcript con texto inventado es **peor
que uno con huecos**: el que lo lee no puede distinguir lo real de lo alucinado.

**No lo filtres con `silencedetect` global.** Se probó y se lleva puesta el habla
baja real junto con la basura: descartaba frases legítimas de la reunión por caer
en un tramo marcado como silencioso.

Lo que funciona es medir el volumen de **cada cue en su propia ventana** con
`volumedetect` y cortar por ahí. Sobre este audio la distribución salió
claramente bimodal:

| Volumen del cue | Cues | Qué es |
|---|---|---|
| −40 a −20 dB | 421 | habla real |
| −45 a −40 dB | 15 | habla baja, real |
| **−50 dB para abajo** | **22** | **alucinación sobre silencio** |

El umbral va en el **valle entre las dos poblaciones**, no a ojo: a −50 dB caen
las 22 basuras y se conserva todo lo demás. Se probó **−46 dB y empieza a comerse
despedidas reales** de gente hablando bajo ("listo Jorge" a −49,9 dB). Medí tu
propia distribución antes de elegir el número; el audio es PCM, así que 464 seeks
cuestan menos de un minuto.

## Capturas

### Dos estrategias, y cuál usar

Las dos tardan lo mismo (~1m 55s): el costo es **decodificar los 2,7 GB**, no
generar las imágenes.

| Estrategia | Comando | Frames de este video |
|---|---|---|
| **Intervalo fijo** | `-vf "fps=1/60,scale=640:-2"` | **58** — cobertura uniforme |
| **Cambio de escena** | `-vf "select='gt(scene,0.4)',scale=640:-2" -fps_mode vfr` | **107** — sigue los cortes |

**Empezá por intervalo fijo.** Cambio de escena parece más inteligente y en la
práctica te dio 107 frames — casi el doble, por encima del techo de 100 imágenes
por request, y con ráfagas de casi-duplicados: el detector disparó en 324,6s,
325,1s y 330,1s, tres frames del mismo momento. Sirve cuando el video tiene
cortes limpios; una reunión con una cara hablando no los tiene.

Para quedarte con los timestamps de las escenas:

```bash
cd "$OUT" && ffmpeg -y -v error -i "$V" \
  -vf "select='gt(scene,0.4)',scale=640:-2,metadata=print:file=times.txt" \
  -fps_mode vfr -q:v 4 "s_%03d.jpg"
```

`times.txt` sale con `pts_time:324.633333` + `lavfi.scene_score=0.628584` por
frame. Ese `pts_time` es lo que cruzás contra el `.srt`.

### La cuenta de tokens

Claude cobra **1 token visual por parche de 28x28 px**. Redondeando para arriba:

| Resolución | Tokens/frame | 58 frames |
|---|---|---|
| 640x360 | **299** | ~17.300 |
| 1280x720 (nativo) | **1.196** | ~69.400 |
| 1920x1080 | 2.691 | ~156.100 |

Bajar a 640x360 sale **4 veces más barato** que el nativo de este video. Los 58
frames pesaron **1,8 MB en total**, 25 KB cada uno.

Techos duros: **100 imágenes por request** en modelos de 200k de contexto, 600 en
los de contexto más grande, **20 por turno en claude.ai**. Y pasando de 20
imágenes por request aplica un límite de dimensión más estricto por imagen
(bajar a ≤2000 px).

### El precio de bajar la resolución

640x360 **no es gratis**. En esa grabación se ve perfecto que es una
videollamada, el layout, quién comparte pantalla. Pero el texto chico —títulos de
pestañas, la hora, labels de UI— queda en el borde de lo legible.

La regla: **640x360 para entender qué pasa, resolución nativa para leer qué
dice.** Si el video muestra un dashboard y necesitás los números, no
downsamplees; sacá pocos frames a 1280x720 y apuntados:

```bash
# un frame exacto, a resolución nativa, del segundo 2700
ffmpeg -y -v error -ss 2700 -i "$V" -frames:v 1 -q:v 2 "$OUT/full_2700.jpg"
```

Ese mismo frame: **99,7 KB a 1280x720** contra **25,1 KB a 640x360**.

## Unir las dos mitades

Frames por un lado y transcript por el otro son dos artefactos que hay que cruzar
a mano. Pegalos en **un solo HTML** —la captura de cada minuto al lado de lo que
se dijo en ese minuto— con las imágenes embebidas en base64 para que sea un
archivo y no una carpeta. Los 58 frames + 442 cues de este video dieron **2,2 MB**.

Dos cosas al armarlo:

- **`file://` está bloqueado en playwright.** Para verificar que renderiza hay que
  servirlo por HTTP; un `createServer` de doce líneas alcanza.
- **Esa página no se publica.** Lleva la cara de una persona en 58 fotos y una
  reunión de negocios entera. Es un archivo local y se queda local.

## Gotchas de Windows

Todos éstos se rompieron de verdad acá.

- **`file=C:/...` dentro de un filtro de ffmpeg no parsea.** Los dos puntos de
  `C:` son el separador de opciones del filtro, así que
  `metadata=print:file=C:/ruta/times.txt` tira *"No option name near
  '/Users/...'"*. Solución: `cd` a la carpeta y path **relativo**, o escapar
  `C\:/ruta`.
- **`whisper --help` explota** con `UnicodeEncodeError`: cp1252 no puede
  encodear un carácter CJK del texto de ayuda. `PYTHONUTF8=1` lo arregla. El CLI
  en sí funciona bien.
- **Hay dos Python 3.13 en el PATH.** `python` resuelve a
  `C:\Python313\python.exe`, pero whisper vive en el otro:
  `%LOCALAPPDATA%\Programs\Python\Python313`. Para chequear dependencias de
  whisper hay que apuntar explícitamente a ese segundo.
- **`FP16 is not supported on CPU; using FP32 instead`** no es un error, es el
  warning esperado. Confirma que estás en CPU.
- **La primera corrida descarga el modelo** (139 MB para `base`) a
  `~/.cache/whisper`. No lo cuentes como tiempo de transcripción.
- **`-vsync vfr` está deprecado**, usá `-fps_mode vfr`.
- **`-ss` antes de `-i`** es seek rápido; después de `-i` decodifica todo desde
  el principio. Con 2,7 GB la diferencia son segundos contra minutos.
- **Nada de `npx rg`** — en este repo resuelve a un paquete basura que escribe un
  `README.md` espurio en la raíz.

## La alternativa: Gemini vía `agy`

Gemini **sí** toma video nativo: muestrea a 1 fps, se lleva el audio, timestamps
cada segundo, hasta 1 hora a resolución media o 3 horas en baja, en modelos de 1M
de contexto. Le pasás el `.mp4` y listo — cero ffmpeg, cero whisper, cero dos
horas de CPU.

El precio es que **subís el archivo a un tercero**. Para una grabación de una
reunión con la cara y la voz de otra persona eso no es un detalle técnico, es una
decisión que se pide antes de tomarla. Ver [Antes de correr nada](#antes-de-correr-nada).

## Antes de correr nada

Dos cosas, y ninguna es opcional.

**1. Los artefactos derivados van FUERA del repo.** El `.gitignore` cubre
`*.mp4 *.mov *.webm *.wav *.m4a *.mp3 *.srt *.vtt *.jpg *.jpeg`, con la misma
excepción que ya tenían los png: `!docs/*.jpg` y `!resources/*.jpg` sí se
commitean, porque eso es documentación del proyecto.

**Filtrar por extensión no alcanza, y esto ya falló acá.** El HTML que une
capturas + transcript es `.html` y el transcript plano es `.txt`: ninguno de los
dos matchea esas reglas, así que un `reunion.html` de 2,2 MB —con 58 fotos de una
cara en base64 adentro— apareció listo para commitear. Por eso además está
ignorada **la carpeta entera**: `video-out/`. Si armás el pipeline en otra
carpeta, ignorá esa carpeta, no sus extensiones.

Esa red se agregó el 2026-08-27 y **no te exime de nada.** git te tapa el archivo,
no te lo saca del disco: un mp4 de 2,7 GB sigue estando en tu working tree, y
`git add -f` sigue funcionando. La red existe para el descuido; `$OUT` apunta al
temp por decisión. Los dos, no uno.

Y si alguna vez hay que meter un medio a mano, mirá bien qué estás forzando: de
la historia de git un archivo de gigabytes no se saca sin reescribirla, y para
cuando alguien lo nota ya está en el clon de todos.

**2. Un transcript es dato personal.** Ese archivo es una reunión de trabajo
grabada: cara, voz, nombres, pantallas compartidas con datos de un negocio real.
El `.srt` y los frames heredan todo eso. No van a un repo, no van a un ticket, no
van a un canal, y no van a un modelo de un tercero sin que la persona grabada lo
sepa.

## Checklist

- [ ] Probé `small` sobre un recorte de 120s antes de lanzar el video completo
- [ ] Corté en tramos de 3 min y corrí de a dos — no lancé una corrida de 2 horas
- [ ] **Filtré las alucinaciones** midiendo el volumen de cada cue, con el umbral
      elegido sobre mi propia distribución
- [ ] `$OUT` apunta fuera del repo
- [ ] Usé intervalo fijo, y solo pasé a cambio de escena si el video tiene cortes
- [ ] El total de frames quedó bajo 100 (20 si es claude.ai)
- [ ] Downsamplé a 640x360 — salvo los frames donde necesito leer texto
- [ ] Le paso a Claude los frames **y** el `.srt`, no las imágenes solas
- [ ] Si el video tiene personas: decidí conscientemente si sale de esta máquina
