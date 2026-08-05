-- Identidad de un pendiente, para no duplicarlo entre notas distintas.
--
-- ¿Por qué no alcanzaba el unique que ya había?
--
-- `tasks_entry_title_key` es (entry_id, lower(title)): protege contra reprocesar
-- LA MISMA nota, y nada más. Si el usuario vuelve a guardar la misma captura del
-- mismo grupo de Meetup en otra nota, son dos entry_id distintos y entran las dos.
-- Su queja fue literal: "ya si ya lo subí, ¿para qué?".
--
-- ¿Y por qué no hacer único (user_id, lower(title)) y listo?
--
-- Porque destruiría los pendientes que SÍ se repiten con razón. "Pagar el gym"
-- en la nota de enero y en la de febrero son dos pagos distintos. Un unique por
-- título los colapsaría y el usuario perdería uno sin enterarse — que es un error
-- peor que el que estamos arreglando.
--
-- Por eso la unicidad global es OPT-IN y va sobre la identidad, no sobre el texto.
-- Solo la escribe lo que tiene identidad real y repetible: hoy, un QR legible,
-- donde la URL normalizada ES la cosa. Un QR cifrado deja esta columna en null a
-- propósito — su identidad es una constante (la sal impide distinguirlos), y
-- hacerla única por usuario dejaría al usuario con un solo pendiente de entrada
-- de evento para toda la vida.

alter table public.tasks
  add column if not exists dedupe_key text;

comment on column public.tasks.dedupe_key is
  'Identidad estable de la cosa por hacer (ej. url:meetup.com/aws-user-group). '
  'null = deduplicar solo dentro de la nota, que es el default para todo lo '
  'inferido por el modelo.';

-- Índice PARCIAL: las filas con null no participan. Sin el `where`, Postgres
-- trataría cada null como distinto y el índice crecería sin servir para nada.
create unique index if not exists tasks_user_dedupe_key
  on public.tasks (user_id, dedupe_key)
  where dedupe_key is not null;
