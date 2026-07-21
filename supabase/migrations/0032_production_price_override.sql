-- 0032: per-production price override (owner spec 2026-07-21).
-- The show's default_rate is the starting price, but a single session may be
-- worth more or less than the show's standard. price_override, when set,
-- wins over default_rate for THIS production only — it's the number that
-- reaches the deal invoice and the client's review link. Editing a show's
-- default_rate still only affects NEW productions (never retroactive), so an
-- override is how you re-price one that already exists.

alter table public.productions
  add column if not exists price_override numeric
    check (price_override is null or price_override >= 0);

-- money column: revoke from the shared authenticated role, same as
-- shows.default_rate (0021) and production_addons prices (0031). Money users
-- read it through the service-role path after an app-level can_view_money
-- check; it is never selected into a stages-only session.
revoke select (price_override) on public.productions from authenticated;
revoke select (price_override) on public.productions from anon;
