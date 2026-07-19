-- 0024: "not billed" becomes a documented decision, never a silence
-- (owner rule 2026-07-19).
--
-- A show with no client used to be indistinguishable from a show whose
-- client nobody got around to filling in. Both just sat there quietly and
-- produced no documents. Once Morning is issuing real work orders that
-- ambiguity turns into a money leak in whichever direction is wrong: an
-- internal show that starts invoicing, or a client show that never does.
--
-- billing_mode='none' + internal_confirmed_* = someone looked at this show
-- and decided. Nothing else counts. A show with no client and no
-- confirmation is a 🟡 the UI must surface ("show with no client —
-- internal?" [yes, internal] [assign client]), not a state it can ignore.

alter table public.shows
  add column if not exists internal_confirmed_at timestamptz,
  add column if not exists internal_confirmed_by uuid references public.profiles(id);

-- both or neither: a timestamp with no author is not a documented decision
do $$ begin
  alter table public.shows
    add constraint shows_internal_confirmed_together
    check ((internal_confirmed_at is null) = (internal_confirmed_by is null));
exception when duplicate_object then null; end $$;

-- Deciding a show never bills is money configuration, exactly like
-- billing_mode/client_id/default_rate — so it joins the same guard (0012).
-- Consequence worth knowing: the "כן, פנימית" button is can_edit_money only.
-- A stages-only user sees the 🟡 but cannot resolve it.
create or replace function public.guard_show_money_columns()
returns trigger language plpgsql as $$
begin
  if new.default_rate is distinct from old.default_rate
     or new.client_id is distinct from old.client_id
     or new.billing_mode is distinct from old.billing_mode
     or new.internal_confirmed_at is distinct from old.internal_confirmed_at
     or new.internal_confirmed_by is distinct from old.internal_confirmed_by then
    if not public.can_edit_money() then
      raise exception 'רק בעל הרשאת עריכת כספים יכול לשנות מחיר, לקוח או מודל חיוב של תוכנית';
    end if;
  end if;
  return new;
end;
$$;

-- 0022 made the SELECT grant column-explicit, which means a new column is
-- invisible to `authenticated` until it is named here. The 🟡 prompt is
-- rendered for stages users too, so both columns must be readable.
grant select (internal_confirmed_at, internal_confirmed_by) on public.shows to authenticated;
