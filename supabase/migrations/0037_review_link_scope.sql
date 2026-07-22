-- 0037: explicit review-link scope. Replaces the implicit reels_included flag
-- with a clear 'episode' | 'reels' | 'all', so a link can target ONE track —
-- e.g. a reels-only re-review after the episode is already signed off, which
-- the reels_included boolean couldn't express (owner 2026-07-22).
--
-- reels_included is kept for now (createReviewLink still writes it) so nothing
-- breaks mid-flight; scope is derived alongside it. A later cleanup can drop
-- reels_included once no code reads it.
alter table public.client_review_links
  add column if not exists scope text not null default 'all'
    check (scope in ('episode', 'reels', 'all'));

-- Backfill existing links from what reels_included meant:
--   reels_included = true  -> both tracks were offered -> 'all'
--   reels_included = false -> episode-only link        -> 'episode'
-- (At migration time every row is the fresh 'all' default, so this rewrites
-- them all from their real reels_included value.)
update public.client_review_links
  set scope = case when reels_included then 'all' else 'episode' end;
