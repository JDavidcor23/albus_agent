-- Resultados de la cascada de extracción de Albus.
--
-- Una fila por (entry, archivo). El `body` de la entry cuenta como "archivo"
-- con attachment_path = '' — así toda entry procesada tiene al menos una fila
-- y "ya fue procesada" se responde con un EXISTS, sin columna de estado aparte.

create table if not exists public.extractions (
  id              uuid primary key default gen_random_uuid(),
  entry_id        uuid not null references public.entries (id) on delete cascade,

  -- '' = el resultado salió del body de la entry, no de un adjunto.
  -- No es NULL para que el unique de abajo funcione sin NULLS NOT DISTINCT.
  attachment_path text not null default '',

  kind            text not null check (kind in (
                    'qr', 'receipt', 'profile', 'document', 'text', 'none', 'failed'
                  )),

  payload         jsonb not null default '{}'::jsonb,

  -- 0..1. Los escalones deterministas (QR) escriben 1; OCR y regex, menos.
  confidence      real not null default 0 check (confidence between 0 and 1),

  -- Qué escalón de la cascada lo resolvió: 'zxing' | 'tesseract' | 'regex' | 'cli:<modelo>'
  source          text not null,

  -- Copiado de la entry por el worker. El service role no tiene auth.uid(),
  -- así que no puede haber default: si el worker no lo setea, el insert falla.
  user_id         uuid not null references auth.users (id) on delete cascade,

  created_at      timestamptz not null default now()
);

-- Idempotencia: reprocesar una entry no duplica filas.
create unique index if not exists extractions_entry_attachment_key
  on public.extractions (entry_id, attachment_path);

-- La consulta caliente: "dame lo extraído de estas entries".
create index if not exists extractions_entry_id_idx
  on public.extractions (entry_id);

-- Búsqueda por tipo: "todos los QR", "todos los pagos".
create index if not exists extractions_user_kind_idx
  on public.extractions (user_id, kind);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- My Notes usa la publishable key y solo debe LEER lo suyo.
-- El worker de Albus usa el service role, que saltea RLS por completo — por eso
-- no hay policies de insert/update/delete: nadie más que el worker escribe acá.

alter table public.extractions enable row level security;

drop policy if exists "extractions: el dueño lee lo suyo" on public.extractions;
create policy "extractions: el dueño lee lo suyo"
  on public.extractions
  for select
  to authenticated
  using (user_id = (select auth.uid()));
