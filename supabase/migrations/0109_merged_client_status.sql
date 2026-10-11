-- ============================================================================
-- 0109 — B24: לקוח שמוזג מקבל status='merged'.
--
-- ═══ הבעיה ═══
-- 0050/0051 ממזגות על ידי `merged_into`, ו-0107 הוסיפה `status` (pending /
-- active / rejected) — אבל מיזוג לא נגע ב-status, ולכן שורה ממוזגת נשארה
-- `active`. E17-3 הוסיף `.eq("status","active")` לכל רשימה, ורק 5 מתוך 33
-- הקריאות המסוננות מסננות גם `merged_into` (B24). כלומר שורה ממוזגת מופיעה
-- בבוררי לקוח, בחיפוש ובהתאמות לפי שם/ח.פ.
--
-- ═══ התיקון (הצעת Claude, אופציה א׳ של B24) ═══
--   1. ערך רביעי ב-CHECK של 0107: 'merged'.
--   2. כל שורה עם `merged_into` לא ריק עוברת ל-status='merged'.
--   3. CHECK חדש: `merged_into is not null` ⇔ `status = 'merged'` — מיזוג
--      שמשכיח את אחד השניים בלתי אפשרי, לא רק לא מומלץ.
-- כיוון שכל רשימה כבר מסננת `status='active'`, שורה ממוזגת נעלמת מכולן בלי
-- לגעת ב-33 הקריאות.
--
-- ═══ תלות בקוד — נדחף לפני ההחלה, באותו קומיט (הכרעת בעלים 11.10) ═══
-- שני מסכים מציגים שורות ממוזגות **בכוונה**, והם קוראים לפי status:
--   · /clients, לשונית "מוזגו" — `fetchVisibleClients(admin, clientStatusesVisibleTo(p))`
--     (src/app/clients/data.ts), שמחזירה ['active'] או ['active','pending'];
--   · /settings/morning-clients — `.eq("status", ACTIVE_CLIENT)`
--     (src/app/api/morning/clients/route.ts:30), שמציג שורה ממוזגת נעולה עם
--     שם הזוכה.
-- שניהם קוראים עכשיו גם 'merged' (MERGED_CLIENT ב-lib/clients/status.ts).
-- הקוד בטוח לפני ההחלה: עד 0109 אין אף שורה עם status='merged'.
--
-- ═══ מה לא משתנה ═══
-- אף שורה לא נמחקת, `merged_into` לא זז, אף עמודה לא נוספת (לכן אין צורך
-- ב-gen types: status הוא text). guard_client_status (0107) בודק
-- `auth.uid()`; ב-SQL Editor הוא ריק ולכן אינו חוסם.
--
-- סדר: supabase/verify/0109_dryrun.sql → הקובץ הזה → supabase/verify/0109_verify.sql
-- ============================================================================

do $mig$
declare
  v_n int;
  v_merged int;
  v_bad int;
begin
  -- >>> BODY
  if exists (select 1 from public.schema_ledger where version = '0109') then
    raise exception '0109 כבר הוחלה';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0108') then
    raise exception '0108 טרם הוחלה — הרץ אותה קודם';
  end if;

  -- ── 0. תנאי מוקדם: שורה ממוזגת היא active, ושום דבר אינו ממוזג אל שורה ממוזגת ──
  select count(*) into v_bad from public.clients
   where merged_into is not null and status <> 'active';
  if v_bad <> 0 then
    raise exception '0109: nmerged_not_active=% — שורה ממוזגת בסטטוס pending/rejected; לבדוק ידנית לפני', v_bad;
  end if;
  select count(*) into v_bad from public.clients c
    join public.clients k on k.id = c.merged_into
   where k.merged_into is not null;
  if v_bad <> 0 then
    raise exception '0109: nchained=% — שורה ממוזגת אל שורה שגם היא ממוזגת', v_bad;
  end if;

  -- ── 1. ערך רביעי ──────────────────────────────────────────────────────────
  alter table public.clients drop constraint clients_status_chk;
  alter table public.clients
    add constraint clients_status_chk check (status in ('pending', 'active', 'rejected', 'merged'));

  -- ── 2. השורות הממוזגות ────────────────────────────────────────────────────
  select count(*) into v_merged from public.clients where merged_into is not null;
  update public.clients set status = 'merged'
   where merged_into is not null and status <> 'merged';
  get diagnostics v_n = row_count;
  if v_n <> v_merged then
    raise exception '0109: עודכנו % מתוך % שורות ממוזגות', v_n, v_merged;
  end if;

  -- ── 3. שני הסימנים הולכים יחד ──────────────────────────────────────────────
  alter table public.clients
    add constraint clients_merged_status_chk
    check ((merged_into is not null) = (status = 'merged'));

  -- ── 4. canary ──────────────────────────────────────────────────────────────
  select count(*) into v_bad from public.clients where status = 'active' and merged_into is not null;
  if v_bad <> 0 then raise exception '0109 canary: nactive_merged=%', v_bad; end if;
  select count(*) into v_n from public.clients where status = 'merged';
  if v_n <> v_merged then raise exception '0109 canary: nmerged_status=% nmerged_into=%', v_n, v_merged; end if;

  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0109', now(), 'bnaya',
    'B24: clients.status מקבל ערך רביעי merged; כל שורה עם merged_into עברה ל-status=merged (' || v_merged || ' שורות); '
    'CHECK clients_merged_status_chk: merged_into לא ריק אם ורק אם status=merged. אפס מחיקות, אפס עמודות חדשות. '
    'שורה ממוזגת נעלמת מכל רשימה שמסננת status=active.');
  -- <<< BODY

  raise notice '✅ 0109: % שורות ממוזגות סומנו status=merged.', v_merged;
end $mig$;
