-- Cuándo hay que ACTUAR sobre un pendiente.
--
-- ¿Por qué hace falta una columna y no alcanzaba ordenar por confidence?
--
-- Porque `confidence` mide cuán seguro estaba el MODELO, no cuánto le importa al
-- usuario. Sobre los datos reales había 20 pendientes y solo 5 valores distintos
-- de confianza — o sea 11 tareas empatadas en 0.90, cuyo orden entre sí era el
-- que Postgres devolviera. El resultado, con hoy = 5 de agosto:
--
--     7.  Hacer cursos de IA                  <- una intención sin fecha
--     15. Pagar la cuota del carro de agosto   <- plata, vence este mes
--     20. Asistir al Cripto Latin Fest         <- 27 y 28 de agosto, entrada en mano
--
-- Las dos únicas cosas con fecha real quedaban 15° y última. Con eso, la lista no
-- se puede accionar: es un inventario, no un pendiente.
--
-- `date` y no `timestamptz` a propósito: "el 27 de agosto" no tiene hora ni zona.
-- Guardarlo con hora obligaría a inventar una, y un timestamp en UTC puede caer
-- el día anterior en Bogotá — la tarea aparecería vencida un día antes.

alter table public.tasks
  add column if not exists due_date date;

comment on column public.tasks.due_date is
  'Cuando hay que actuar. null = sin fecha, y ordena despues de todo lo fechado. '
  'De un rango se guarda el PRIMER dia: es cuando hay que estar listo.';

-- La consulta caliente pasa a ser "que tengo que hacer primero".
-- `nulls last` va en el indice para que el orden de la query lo pueda usar: sin
-- eso, Postgres ordena igual pero con un sort aparte sobre todas las filas.
create index if not exists tasks_user_due_idx
  on public.tasks (user_id, status, due_date nulls last, confidence desc);
