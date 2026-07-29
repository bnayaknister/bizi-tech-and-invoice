-- 0048: recipient selection + our own send-log for document emailing
-- (owner spec 2026-07-29).
--
-- Morning emails a document ONLY at creation time, to the addresses in the
-- request's client.emails (there is no resend endpoint, and no send-log API).
-- So the bookkeeper picks recipients at APPROVAL (= the moment we call Morning),
-- and WE record what was requested — Morning won't tell us. This migration adds
-- only that state; the picker + injection are app code (steps 2-6).
--
-- SAFE TO RE-RUN. Do NOT run automatically — owner applies in the SQL Editor
-- and records it in schema_ledger.

-- 1. the recipient list actually injected into client.emails at issue time.
--    NULL = not issued yet / not applicable. An empty array {} = issued and
--    deliberately sent to NOBODY (a work order's default). This is our send
--    record: it captures the REQUESTED recipients, not a delivery confirmation
--    (Morning gives no bounce/delivery signal in scope).
alter table public.pending_documents
  add column if not exists sent_to text[];

-- 2. mirror onto the registry row at issue (write-through in issue.ts) so the
--    recipients show next to the issued document on the registry screen too.
alter table public.documents
  add column if not exists sent_to text[];

-- 3. the accountant / bookkeeping default recipient, held HERE because
--    Morning's business settings (accountantEmails) are NOT exposed by the API
--    for reading. A dedicated column on the app_settings singleton — readable
--    by the bookkeeper (app_settings_view = can_view_stages) so the picker can
--    default it, editable by the owner only (app_settings_update = is_owner),
--    so it changes without a deploy.
alter table public.app_settings
  add column if not exists accountant_email text;

update public.app_settings
  set accountant_email = 'billing@bi-zi.co.il'
  where id = true and (accountant_email is null or accountant_email = '');
