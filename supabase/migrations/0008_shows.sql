-- shows (screens spec v3, section 0.א) — the missing base entity.
-- productions.show_id supplements podcast_name (not dropped yet, same
-- incremental pattern as invoice_biz/invoice_tax — old field stays until
-- a later cleanup step once everything reads from the new one).

create table if not exists public.shows (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  client_id uuid references public.clients(id),
  aliases text[] not null default '{}',
  default_rate numeric,
  default_editor_id uuid references public.profiles(id),
  default_studio text,
  active boolean not null default true,
  is_oneoff boolean not null default false,
  color text,
  created_at timestamptz not null default now()
);

alter table public.productions
  add column if not exists show_id uuid references public.shows(id);

alter table public.shows enable row level security;

-- view = can_view_stages (production/scheduling staff need this for the
-- calendar-matching workflow, not just money people)
create policy shows_view on public.shows
  for select using (public.can_view_stages() or public.can_view_money());
create policy shows_insert on public.shows
  for insert with check (public.can_edit_stages() or public.can_edit_money());
create policy shows_update on public.shows
  for update using (public.can_edit_stages() or public.can_edit_money())
  with check (public.can_edit_stages() or public.can_edit_money());
-- delete is only ever issued by the merge flow (absorbed show removed after
-- its productions are repointed); archiving uses active=false, not delete
create policy shows_delete on public.shows
  for delete using (public.can_edit_stages() or public.can_edit_money());

-- money-column guard: RLS must let can_edit_stages users update shows
-- (alias editing feeds calendar matching — that's production staff work),
-- but default_rate/client_id are money fields. Column-level protection
-- can't be expressed in an RLS policy, so a trigger enforces it.
-- Service-role scripts (auth.uid() is null → can_edit_money() is null,
-- so the NOT test never raises) pass through, same as the existing
-- guard_client_approval_transition pattern.
create or replace function public.guard_show_money_columns()
returns trigger language plpgsql as $$
begin
  if new.default_rate is distinct from old.default_rate
     or new.client_id is distinct from old.client_id then
    if not public.can_edit_money() then
      raise exception 'רק בעל הרשאת עריכת כספים יכול לשנות מחיר או לקוח של תוכנית';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_show_money on public.shows;
create trigger trg_guard_show_money
before update on public.shows
for each row execute function public.guard_show_money_columns();
