-- 0022: actually hide shows.default_rate from the authenticated role.
--
-- 0021 tried `revoke select (default_rate) on shows from authenticated`, but
-- Postgres ignores a column-level revoke while a whole-table SELECT grant is
-- in effect (a technician could still read default_rate — caught by the
-- acceptance test). The correct move is to drop the table-level SELECT and
-- re-grant SELECT on every column EXCEPT default_rate. Money users read the
-- rate through the service role (the shows page already does this); the
-- calendar sync and scripts use the service role too, which keeps its
-- privileges regardless.
--
-- Maintenance note: because the grant is now column-explicit, a NEW column
-- added to public.shows in a future migration will NOT be readable by
-- stages users until it's added to a grant like the one below. That's a
-- deliberate secure-by-default posture — money-sensitive columns stay off
-- until explicitly opened.

revoke select on public.shows from authenticated;
revoke select on public.shows from anon;

grant select (
  id, name, client_id, aliases, default_editor_id, default_studio,
  active, is_oneoff, color, created_at, billing_mode, camera_count,
  notes, settings
) on public.shows to authenticated;
-- default_rate is intentionally omitted.
