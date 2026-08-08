-- Rename the RLS policies and the CHECK constraint that were created with Spanish
-- names in 0001 and 0002.
--
-- Why a new migration instead of editing 0001/0002: those files already ran against
-- the live database. Editing them changes nothing there and only desyncs the repo
-- from reality. A migration that has been applied is history, not source.
--
-- Every statement is guarded, so this is safe to run twice and safe to run on a
-- database created fresh from 0001-0003. `alter policy ... rename to` and
-- `alter table ... rename constraint` both raise if the old name is absent.
--
-- Nothing here changes behaviour: same tables, same predicates, same rows visible
-- to the same user. Only the identifiers move.

-- extractions: owner reads own rows
do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'extractions'
      and policyname = 'extractions: el dueño lee lo suyo'
  ) then
    alter policy "extractions: el dueño lee lo suyo"
      on public.extractions
      rename to "extractions: owner reads own rows";
  end if;
end $$;

-- tasks: owner reads own rows
do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'tasks'
      and policyname = 'tasks: el dueño lee lo suyo'
  ) then
    alter policy "tasks: el dueño lee lo suyo"
      on public.tasks
      rename to "tasks: owner reads own rows";
  end if;
end $$;

-- tasks: owner closes own rows
do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'tasks'
      and policyname = 'tasks: el dueño cierra lo suyo'
  ) then
    alter policy "tasks: el dueño cierra lo suyo"
      on public.tasks
      rename to "tasks: owner closes own rows";
  end if;
end $$;

-- The constraint that forbids impossible states: an open task cannot have a
-- closing date, and a closed one cannot lack it.
do $$
begin
  if exists (
    select 1
    from pg_constraint c
    join pg_class      t on t.oid = c.conrelid
    join pg_namespace  n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'tasks'
      and c.conname = 'tasks_cierre_coherente'
  ) then
    alter table public.tasks
      rename constraint tasks_cierre_coherente to tasks_close_coherent;
  end if;
end $$;
