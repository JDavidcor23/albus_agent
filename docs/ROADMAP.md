# Albus — hoja de ruta

Documento vivo. Se actualiza a medida que se construye.

## Para qué existe esto

Jorge captura cosas con el celular durante el día —fotos de QR en charlas, comprobantes
de pago, capturas de ofertas de LinkedIn, notas sueltas— y todo eso muere en una lista
cronológica que nadie vuelve a mirar. Albus lee esa pila y la convierte en acciones.

**La restricción real, dicha por él:** necesita generar dinero ya. La automatización no
es el objetivo, es el medio: liberar tiempo del trabajo actual para venderlo en otro lado
(servicios, cursos).

Eso tiene una consecuencia incómoda que conviene tener escrita: **construir Albus no
genera plata.** Ahorra tiempo. De todo lo que hay en esta hoja, una sola rama toca el
ingreso de forma directa —la pila de ofertas de LinkedIn—, y por eso se adelanta.

## El pipeline

```
Supabase (My Notes)  →  descarga  →  cascada  →  clasificación  →  destino
                                     QR/OCR/regex                  ↓
                        ┌────────────────────────────────────────────────┐
                        │  notas · Drive · dashboard · contactos · email  │
                        └────────────────────────────────────────────────┘
```

## Qué hay en la pila y a dónde va cada cosa

| Tipo | Qué es | Qué tiene que pasar | Destino |
|---|---|---|---|
| **QR** | Slides de charlas, redes de eventos, stands | Escanear, resolver el link, agrupar por evento | Lista de links + correo resumen |
| **Comprobantes** | Internet, DIAN, gas, carro | Extraer entidad, monto, fecha, referencia | Carpeta de pagos en Drive + índice |
| **Ofertas de LinkedIn** | Capturas de ofertas que no postuló por fricción | Extraer empresa, rol, link, fecha | **Dashboard de postulación** |
| **Personas** | Contactos de eventos, perfiles | Nombre + LinkedIn + dónde lo conoció | Base de contactos |
| **Ideas de proyecto** | Notas sueltas | Agrupar por tema | Grafo (fase 3) |

## Fases

### Fase 0 — Cimientos ✅ HECHO

- [x] App Electron con main/preload/renderer y sobre IPC tipado
- [x] Lectura de `entries` y descarga de adjuntos desde Supabase (service role)
- [x] Tabla `extractions` con RLS de solo-lectura, idempotente por `(entry_id, attachment_path)`
- [x] Cascada QR → OCR → regex, sin gastar cuota de ningún LLM
- [x] Worker secuencial tolerante a fallos
- [x] UI de una pantalla con los cuatro estados

### Fase 1 — Correrlo con datos reales 🔜 SIGUIENTE

- [ ] `.env` con el service role key **(bloqueado en Jorge)**
- [ ] Primera corrida real sobre los 28 adjuntos
- [ ] **Medir:** de las 23 fotos, ¿cuántas dan QR? ¿cuántas dan comprobante? ¿cuántas nada?

Ese número decide todo lo que sigue. Si dan QR 15, el camino es el correcto. Si dan 2,
las fotos son otra cosa y hay que mirar qué.

### Fase 2 — La rama que toca el ingreso

Se adelanta al grafo y a Drive porque es la única que termina en un cheque.

- [ ] Extractor de ofertas de LinkedIn desde capturas (empresa, rol, seniority, link)
- [ ] Dashboard: la pila de ofertas convertida en lista accionable con estado
      (sin postular / postulado / respondió / descartada)
- [ ] Redacción asistida del mensaje de contacto — **Jorge revisa y envía, siempre**

### Fase 3 — Memoria consultable (Graphify)

- [ ] Grafo sobre lo extraído: personas ↔ eventos ↔ proyectos ↔ empresas
- [ ] Consulta en lenguaje natural: *"dame la llave de mi entrenador"*
- [ ] **Los secretos NO van al grafo.** Ver la sección de secretos abajo.

### Fase 4 — Destinos externos

- [ ] Google Drive: carpeta de pagos, subida automática, índice
- [ ] Correo: resumen de links de un evento
- [ ] Base de contactos con LinkedIn asociado

### Fase 5 — Crecer

Lo que aparezca. Reevaluar contra la restricción de ingreso cada vez.

## Decisiones tomadas

- **La cascada decide, no el programador.** No existe "el extractor de QR": existe una
  cascada que prueba todo lo barato y deja que el resultado diga qué era la imagen.
- **El escalón de LLM va último y gasta la cuota de las suscripciones vía CLI headless.**
  Nunca una API paga.
- **`albus_agent` es un repo aparte de `my_brain`** porque tiene el service role key.
- **Idempotencia por esquema**, no por columna de estado.

## Decisiones pendientes

- **Los secretos (la llave de pago) no pueden vivir con las notas.** Un grafo existe para
  relacionar y buscar; un secreto existe para no aparecer. Si la llave entra al grafo,
  cualquier query o embedding puede filtrarla. Hace falta un almacén cifrado aparte,
  con su propia puerta. Sin resolver.
- Dónde vive el dashboard de ofertas: ¿otra pantalla de Albus, o algo que se pueda
  abrir desde el celular?
- Qué se hace con los adjuntos ya procesados. Ver abajo.

## Objeciones registradas

Cosas que Jorge pidió y sobre las que hay una recomendación distinta. Quedan escritas
para que la decisión sea consciente, no por olvido.

**Borrar la imagen después de escanear el QR.** No todavía. Si el decode salió mal o
incompleto, el original ya no está y no hay a qué volver. Recomendación: marcarla como
procesada y archivarla; borrar cuando la extracción tenga historial de acierto. El
espacio no aprieta aún —las fotos de QR son las livianas—, y lo que sí aprieta es el
1 GB del Free Plan contra ~37 MB/día de fotos de cámara: eso se resuelve comprimiendo
al subir, no borrando lo ya extraído.

**Que Albus postule solo a las ofertas.** La fricción que describió Jorge es el *triaje*,
no el click. Un dashboard que convierta la pila en una lista priorizada con el link listo
se lleva casi todo el valor. Postular automáticamente además no tiene API pública, exige
automatizar el navegador con su cuenta, y eso termina en cuenta restringida.

**Graphify como fase 2.** Movido a fase 3. Un grafo sobre 17 notas es un juguete; sobre
tres meses de captura es memoria. Y la fase 2 propuesta apunta al ingreso, que es la
restricción declarada.
