-- Pendientes derivados de las notas.
--
-- ¿Por qué una tabla aparte y no un `kind` más en `extractions`?
--
-- Porque tienen ciclos de vida OPUESTOS. `extractions` es derivada y reproducible:
-- se puede borrar entera y regenerarla corriendo la cascada de nuevo — de hecho
-- `run-batch --reset` hace exactamente eso. `tasks` guarda ESTADO DEL USUARIO:
-- que marcaste algo como hecho no se puede volver a derivar de la nota, porque no
-- está en la nota. Vive solo acá.
--
-- Mezclarlas significaría que cada reproceso te borra todo lo que tachaste. Y un
-- pendiente que no se puede tachar deja de leerse en dos semanas.

create table if not exists public.tasks (
  id              uuid primary key default gen_random_uuid(),
  entry_id        uuid not null references public.entries (id) on delete cascade,

  -- Copiado de la entry por el worker: el service role no tiene auth.uid().
  user_id         uuid not null references auth.users (id) on delete cascade,

  -- Accionable y en primera persona: "Postularme a X", no "Oferta de trabajo".
  title           text not null check (length(trim(title)) > 0),
  -- De dónde salió, para poder confiar o desconfiar: el texto de la nota.
  detail          text,

  status          text not null default 'open'
                    check (status in ('open', 'done', 'dismissed')),

  -- 'regex' | 'cli:<modelo>'. Un pendiente inferido por IA no vale lo mismo
  -- que uno donde vos escribiste "tengo que".
  source          text not null,
  confidence      real not null default 0 check (confidence between 0 and 1),

  created_at      timestamptz not null default now(),
  closed_at       timestamptz,

  -- Un pendiente abierto no puede tener fecha de cierre, y uno cerrado no puede
  -- no tenerla. Sin esto la tabla acepta estados imposibles.
  constraint tasks_cierre_coherente check (
    (status = 'open' and closed_at is null)
    or (status <> 'open' and closed_at is not null)
  )
);

-- Idempotencia: volver a detectar sobre la misma nota no duplica.
-- Va sobre lower(title) porque el modelo alterna mayúsculas entre corridas.
create unique index if not exists tasks_entry_title_key
  on public.tasks (entry_id, lower(title));

-- La consulta caliente, la del chat: "¿qué tengo pendiente?".
create index if not exists tasks_user_status_idx
  on public.tasks (user_id, status, created_at desc);

-- Para saber qué entries ya fueron analizadas y no volver a gastar cuota.
create index if not exists tasks_entry_id_idx
  on public.tasks (entry_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Mismo criterio que `extractions`: My Notes usa la publishable key y solo lee
-- lo suyo. El worker de Albus usa el service role y saltea RLS.
--
-- Acá SÍ hay policy de update, a diferencia de extractions: marcar un pendiente
-- como hecho es una acción del usuario, no del worker. Pero solo sobre el estado.

alter table public.tasks enable row level security;

drop policy if exists "tasks: el dueño lee lo suyo" on public.tasks;
create policy "tasks: el dueño lee lo suyo"
  on public.tasks
  for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "tasks: el dueño cierra lo suyo" on public.tasks;
create policy "tasks: el dueño cierra lo suyo"
  on public.tasks
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
