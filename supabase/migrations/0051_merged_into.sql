-- 0051: a client row that was merged away says so, in a column.
--
-- 0050 merged eight duplicate client rows into seven entities and left the
-- losers in place, marked only by a '[מוזג]' name prefix. Two hours and twenty
-- minutes later all seven were re-mapped to Morning by hand through
-- /settings/morning-clients — the screen listed them as "unmapped", which is
-- exactly what they now were, and nothing on it said they had retired.
--
-- That re-created two rows per morning_client_id, and the pull resolves that
-- pair with `.order("name")` + first-wins (registry.ts, backfill.ts). The
-- '[' of the '[מוזג]' prefix sorts BEFORE every Hebrew letter, so the retired
-- row won the tie-break every single time — the marker meant to retire a row
-- is what handed it the documents. All 14 documents belonging to those seven
-- Morning clients ended up on the merged-away rows, including 40294.
--
-- A name prefix is a label. This is the fact:
--   • merged_into names the surviving row, so every resolver can exclude it
--   • the CHECK makes the accident unrepresentable, not merely discouraged —
--     a merged row cannot hold a morning_client_id at all
--
-- PREREQUISITE: the 4.8 repair (orphans unmapped, 14 documents returned) must
-- already be in place, or the CHECK will refuse to validate. The block tests
-- for it and says so rather than failing on the constraint.
--
-- Run this BEFORE deploying the code that reads merged_into.

do $$
declare
  n int;
begin
  if exists (select 1 from schema_ledger where version = '0051') then
    raise exception '0051 כבר הוחלה';
  end if;

  -- ---------- 1. the column ----------
  alter table public.clients
    add column if not exists merged_into uuid references public.clients(id);

  comment on column public.clients.merged_into is
    'השורה מוזגה אל הלקוח הזה ואינה בשימוש. אין למפות אותה למורנינג ואין לחייב עליה.';

  create index if not exists clients_merged_into_idx
    on public.clients (merged_into) where merged_into is not null;

  -- ---------- 2. the eight rows of 0050 ----------
  create temp table merge_map(drop_id uuid, keep_id uuid) on commit drop;
  insert into merge_map values
    ('cce45794-a213-4b68-b03d-2c4b81584dde','b827024d-cce3-4f59-a064-5531de9303b3'),
    ('538e32dd-58e7-4ac6-a254-16ac4aedac32','e9571ef4-ae03-45db-861d-6f3137c0f8d4'),
    ('11752549-223d-4c29-b212-691238da7358','261c0445-c013-4f87-9dc6-e82f8c7e9c30'),
    ('1cf9bf48-1b53-4fb3-8479-f69b41a804da','261c0445-c013-4f87-9dc6-e82f8c7e9c30'),
    ('09fc34e1-f0f2-4a17-83cc-7a3f89fbf30f','7e5d4b69-ff2e-413d-bfe3-fa3c37114212'),
    ('eb14ffb4-fb71-4dac-b8d2-8e2e30a2a848','9060e10f-06be-4079-b22c-53c63b6c1f53'),
    ('f235b0eb-2120-43d5-988b-cd55f24b321c','4f16e25e-152b-475e-981b-7372117b17f5'),
    ('daf6022e-54f7-498e-8a79-78ff84ed03bd','b42808ad-4e91-4951-bcff-23111644a88b');

  select count(*) into n from merge_map m join public.clients c on c.id = m.drop_id;
  if n <> 8 then raise exception 'שורות מוזגות: נמצאו %, צפויות 8', n; end if;

  select count(*) into n from merge_map m join public.clients c on c.id = m.keep_id;
  if n <> 8 then raise exception 'שורות זוכות: נמצאו %, צפויות 8', n; end if;

  -- a row cannot merge into itself, and a keeper cannot itself be retired
  if exists (select 1 from merge_map where drop_id = keep_id) then
    raise exception 'מיפוי מעגלי: שורה ממוזגת לעצמה';
  end if;
  if exists (select 1 from merge_map m join merge_map m2 on m.keep_id = m2.drop_id) then
    raise exception 'מיפוי מעגלי: שורה זוכה מסומנת גם כממוזגת';
  end if;

  -- ---------- 3. the prerequisite the CHECK depends on ----------
  select count(*) into n
    from merge_map m join public.clients c on c.id = m.drop_id
   where c.morning_client_id is not null;
  if n > 0 then
    raise exception
      '% שורות ממוזגות עדיין ממופות למורנינג — הרץ קודם את תיקון 4.8 (איפוס המיפוי והחזרת המסמכים)', n;
  end if;

  -- ---------- 4. populate ----------
  update public.clients c
     set merged_into = m.keep_id
    from merge_map m
   where c.id = m.drop_id
     and c.merged_into is distinct from m.keep_id;
  get diagnostics n = row_count;
  raise notice 'סומנו % שורות כממוזגות', n;

  select count(*) into n
    from merge_map m join public.clients c on c.id = m.drop_id
   where c.merged_into = m.keep_id;
  if n <> 8 then raise exception 'אוכלסו % מתוך 8 — מגלגל אחורה', n; end if;

  -- ---------- 5. make the accident unrepresentable ----------
  -- Not a warning, not a filter: a retired row may not carry a Morning
  -- mapping at all. This is what stops 3.8 from happening a second time even
  -- if every screen is bypassed.
  alter table public.clients
    drop constraint if exists clients_merged_row_unmapped;
  alter table public.clients
    add constraint clients_merged_row_unmapped
    check (merged_into is null or morning_client_id is null);

  insert into schema_ledger (version, applied_at, applied_by, note)
  values ('0051', now(), 'bnaya',
          'merged_into על clients + CHECK שאוסר מיפוי מורנינג לשורה ממוזגת. אוכלסו 8 שורות 0050.');
end $$;
