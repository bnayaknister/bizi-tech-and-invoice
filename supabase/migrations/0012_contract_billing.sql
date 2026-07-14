-- Contract billing classification (owner decision 2026-07-15).
-- Productions gain kind='contract': billed through a contract (the Jaffa
-- deal), so the 🔵 "produced but never billed" alert must ignore them
-- completely — it only ever looks at kind='client'.
-- Shows gain billing_mode so the classification lives at the show level
-- and derives down to productions.

alter type production_kind add value if not exists 'contract';

do $$ begin
  create type show_billing_mode as enum ('per_episode','contract','none');
exception when duplicate_object then null; end $$;

alter table public.shows
  add column if not exists billing_mode show_billing_mode not null default 'per_episode';

-- billing_mode decides whether a show bills at all — that is money
-- configuration, same protection as default_rate/client_id (0008 guard)
create or replace function public.guard_show_money_columns()
returns trigger language plpgsql as $$
begin
  if new.default_rate is distinct from old.default_rate
     or new.client_id is distinct from old.client_id
     or new.billing_mode is distinct from old.billing_mode then
    if not public.can_edit_money() then
      raise exception 'רק בעל הרשאת עריכת כספים יכול לשנות מחיר, לקוח או מודל חיוב של תוכנית';
    end if;
  end if;
  return new;
end;
$$;
