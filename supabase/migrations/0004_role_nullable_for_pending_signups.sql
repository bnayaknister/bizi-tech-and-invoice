-- New signups land with no role yet (approved=false, awaiting an owner
-- to assign a preset). role's NOT NULL from migration 1 blocked every
-- signup with a 500 error. The existing CHECK constraint already allows
-- NULL automatically — only NOT NULL needs to go.

alter table public.profiles alter column role drop not null;
