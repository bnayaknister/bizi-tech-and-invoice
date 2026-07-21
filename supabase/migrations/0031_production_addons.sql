-- 0031: session add-ons / upsells (owner spec 2026-07-21).
-- A client often upgrades beyond the standard package mid-session — more
-- reels, music, after-effects, extra edits. Until now that was money that
-- never got recorded. Each upsell is one line on the production, priced like
-- an invoice line, and once the client approves it flows into the same deal
-- invoice as the base package (one income row per approved add-on).
--
-- Lifecycle: a stages editor adds a line (title + quantity) with NO price;
-- a money editor fills unit_price; the client approves/rejects it on the
-- review link (approved_via='link') or a money editor does it by hand
-- (approved_via='manual'). Only 'approved' lines with a price reach Morning.

create table if not exists public.production_addons (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions(id) on delete cascade,
  title text not null,                    -- free text: "3 רילז נוספים"
  quantity integer not null default 1 check (quantity > 0),
  unit_price numeric check (unit_price is null or unit_price >= 0), -- null until a money editor prices it
  -- computed; stays null (and thus out of every total) until priced
  total numeric generated always as (
    case when unit_price is null then null else unit_price * quantity end
  ) stored,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  approved_via text check (approved_via in ('link', 'manual')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists production_addons_production_idx
  on public.production_addons (production_id);

alter table public.production_addons enable row level security;

-- The whole team (stages viewers) may READ add-on rows so the section shows
-- on the board/drawer. Prices are compartmentalized the same way the rest of
-- the app does money: the price columns are revoked from the shared
-- authenticated role (below), and money viewers read them through the
-- service-role API path after an app-level can_view_money check. NOBODY
-- writes from a session — every mutation is server-only (service role, after
-- an explicit permission check), matching client_review_links (0029).
drop policy if exists production_addons_select on public.production_addons;
create policy production_addons_select on public.production_addons
  for select using (public.can_view_stages());

-- price columns: revoke from the shared role (RLS is row-level, not
-- column-level — same reasoning and pattern as shows.default_rate in 0021).
revoke select (unit_price, total) on public.production_addons from authenticated;
revoke select (unit_price, total) on public.production_addons from anon;
