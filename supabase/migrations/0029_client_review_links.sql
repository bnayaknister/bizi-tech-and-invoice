-- 0029: client review links (screens-spec §9a, owner spec 2026-07-21).
-- A production that's been sent to the client gets a public, account-less
-- link. The client watches the episode and/or reels and either approves or
-- asks for corrections, per track. Full approval fires the existing
-- client-approval chain (job + deal invoice); a correction sends it back to
-- the board.

-- Per-track approval state lives on the production because it PERSISTS across
-- rounds: a client can approve the episode, ask to fix the reels, and the
-- episode stays locked-approved through the next link. The deal invoice waits
-- until every in-scope track is approved.
alter table public.productions
  add column if not exists review_episode_approved boolean not null default false,
  add column if not exists review_reels_approved boolean not null default false,
  add column if not exists review_reels_required boolean not null default true,
  add column if not exists review_episode_note text,
  add column if not exists review_reels_note text;

create table if not exists public.client_review_links (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions(id) on delete cascade,
  token text not null unique,               -- 32+ random bytes, URL-safe
  expires_at timestamptz not null,          -- 14 days from creation
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  responded_at timestamptz,                 -- set once — one response per link
  superseded boolean not null default false,-- a new round supersedes the old link
  reels_included boolean not null default true,
  -- optional media links the client watches (we store no media ourselves)
  episode_link text,
  reels_link text,
  -- the response captured on THIS link, kept for the full corrections history
  episode_response text check (episode_response in ('approved', 'revisions')),
  reels_response text check (reels_response in ('approved', 'revisions')),
  episode_note text,
  reels_note text
);

create index if not exists client_review_links_production_idx on public.client_review_links (production_id);
-- the live link for a production: not superseded, not yet responded
create index if not exists client_review_links_live_idx
  on public.client_review_links (production_id) where not superseded and responded_at is null;

alter table public.client_review_links enable row level security;

-- The public review page and the response endpoint both run SERVER-SIDE via
-- the service role (by token) — anonymous visitors never touch the table
-- directly. The team needs to see review status on the board, so stages
-- viewers may read; nobody writes from a session (server-only).
drop policy if exists client_review_links_select on public.client_review_links;
create policy client_review_links_select on public.client_review_links
  for select using (public.can_view_stages());

-- Let trusted server code (service role, auth.uid() IS NULL) finalise a client
-- approval. The review response has no logged-in user, so without this the
-- client-approval guard would block it. Authenticated users are still gated on
-- can_edit_money — this only opens the null (service-role) path, matching the
-- pattern the stage guard (0010) already uses.
create or replace function public.guard_client_approval_transition()
returns trigger language plpgsql as $$
begin
  if new.status = 'אושר_ע"י_לקוח' and old.status is distinct from 'אושר_ע"י_לקוח' then
    if auth.uid() is not null and not public.can_edit_money() then
      raise exception 'רק בעל הרשאת עריכת כספים יכול לסמן הפקה כמאושרת ע"י הלקוח';
    end if;
  end if;
  return new;
end;
$$;

grant select (
  review_episode_approved, review_reels_approved, review_reels_required,
  review_episode_note, review_reels_note
) on public.productions to authenticated;
