-- 0036: mark which add-ons are extra reels, explicitly. The drawer's reels
-- tally ("2 standard + N extra = total") was matching add-on TITLES for
-- "ריל"/"reel", which breaks the day someone writes "3 סרטונים קצרים"
-- (owner 2026-07-22). One boolean is the durable fix — the add-on stays the
-- single source of truth for reels quantity (no separate reels_count), and the
-- tally sums quantity where this flag is set.
alter table public.production_addons
  add column if not exists is_reels_addon boolean not null default false;
