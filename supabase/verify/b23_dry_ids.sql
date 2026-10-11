-- ============================================================================
-- B23 — synthetic `dry-…` Morning ids in the database. READ-ONLY.
--
-- Finds rows where a dry run left a synthetic Morning id. Changes NOTHING:
-- select only, no DO block, no function call. One result set (the SQL Editor
-- shows only the last one), one row per (place, kind):
--
--   kind = 'bug'         — a place B23 fixed: a synthetic CLIENT id must never
--                          be here. Any n > 0 is a client that a real issuance
--                          would send to Morning with an id Morning never made.
--   kind = 'by-design'   — documents: issue.ts writes `dry-…` doc ids here ON
--                          PURPOSE (a tagged shadow ledger every reader
--                          filters). Listed so the owner sees how many exist,
--                          not because they are wrong.
--
-- `sample` = up to 5 ids, to look at before deciding anything.
-- ============================================================================

select 'clients.morning_client_id' as place, 'bug' as kind,
       count(*) as n,
       string_agg(id::text || '=' || morning_client_id, ', ' order by created_at) filter (where rn <= 5) as sample
from (select id, morning_client_id, created_at, row_number() over (order by created_at) as rn
      from public.clients where morning_client_id like 'dry-%') c

union all
select 'client_morning_ids.morning_client_id', 'bug',
       count(*),
       string_agg(client_id::text || '=' || morning_client_id, ', ' order by created_at) filter (where rn <= 5)
from (select client_id, morning_client_id, created_at, row_number() over (order by created_at) as rn
      from public.client_morning_ids where morning_client_id like 'dry-%') a

union all
select 'documents.morning_client_id', 'bug',
       count(*),
       string_agg(id::text || '=' || morning_client_id, ', ' order by created_at) filter (where rn <= 5)
from (select id, morning_client_id, created_at, row_number() over (order by created_at) as rn
      from public.documents where morning_client_id like 'dry-%') d

-- a document QUEUED for a client that carried a synthetic id: its payload
-- names that client to Morning
union all
select 'pending_documents.payload (dry-client)', 'bug',
       count(*),
       string_agg(id::text || ' ' || status, ', ' order by created_at) filter (where rn <= 5)
from (select id, status, created_at, row_number() over (order by created_at) as rn
      from public.pending_documents where payload::text like '%dry-client-%') q

union all
select 'pending_documents.morning_doc_id', 'by-design',
       count(*),
       string_agg(id::text || '=' || morning_doc_id, ', ' order by created_at) filter (where rn <= 5)
from (select id, morning_doc_id, created_at, row_number() over (order by created_at) as rn
      from public.pending_documents where morning_doc_id like 'dry-%') p

union all
select 'invoices.morning_doc_id', 'by-design',
       count(*),
       string_agg(id::text || '=' || morning_doc_id, ', ' order by created_at) filter (where rn <= 5)
from (select id, morning_doc_id, created_at, row_number() over (order by created_at) as rn
      from public.invoices where morning_doc_id like 'dry-%') i

union all
select 'documents.morning_doc_id', 'by-design',
       count(*),
       string_agg(id::text || '=' || morning_doc_id, ', ' order by created_at) filter (where rn <= 5)
from (select id, morning_doc_id, created_at, row_number() over (order by created_at) as rn
      from public.documents where morning_doc_id like 'dry-%') r

order by kind, place;
