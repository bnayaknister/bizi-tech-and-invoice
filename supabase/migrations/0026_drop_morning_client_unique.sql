-- 0026: several of our clients can legitimately be ONE paying entity in
-- Morning (owner, 2026-07-20). E.g. "הנעות קטנות" and "וואן" both bill to
-- "טל וואן פירסום ומיתוג בע״מ" — one payer, several brands/shows.
--
-- 0025 made clients.morning_client_id UNIQUE, which rejected exactly that
-- with a 409. Drop it. The allowed direction (many of our clients → one
-- Morning client) is now open; the forbidden direction (one of our clients
-- → many Morning clients) was never possible — it's a single column.
--
-- This is not a silent free-for-all: mapping to an already-used Morning
-- client now raises an app-level WARNING the operator must confirm ("these
-- two entities will bill to the same Morning client — continue?"), and a
-- shared mapping is labelled in the UI. Awareness without a block. The
-- cleaner long-term fix (client merge + aliases, like shows) is backlogged
-- because it rewrites billing history.

alter table public.clients drop constraint if exists clients_morning_client_id_key;

-- A non-unique lookup index still helps the "who else maps here" query the
-- shared-with badge runs.
create index if not exists clients_morning_client_id_idx
  on public.clients (morning_client_id)
  where morning_client_id is not null;
