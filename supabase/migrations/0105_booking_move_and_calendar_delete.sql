-- ============================================================================
-- 0105 — הזזת הקלטה ומחיקה מהיומן (E9-5). שלוש עמודות על booking_requests
-- ושתי פונקציות.
--
-- **אפס שינוי התנהגות בהחלה עצמה**: שלוש העמודות נולדות null לכל השורות
-- הקיימות, אין backfill, אין DELETE, ואף ערך קיים לא משתנה.
--
-- ═══ 1. `replaces_request_id` — הזזה היא בקשה חדשה שמחליפה ישנה ═══
-- הזזה נבנית כבקשה חדשה דרך המסלול המשותף (submit.ts → decide.ts), והעמודה
-- מקשרת אותה להקלטה שהיא מחליפה. 🔴 בלעדיה, בקשת הזזה שנשארה ממתינה ואושרה
-- אחר כך ידנית ב-/bookings הייתה משאירה **שתי הקלטות מאושרות** — אסור לפי
-- הכרעת הבעלים (11.10). עם העמודה, כל אישור של בקשה מחליפה — אוטומטי או
-- ידני — עובר דרך הפונקציה האטומית שלהלן.
--
-- ═══ 2. `booking_approve_replacing` — ההחלפה האטומית ═══
-- באותה טרנזקציה: הישנה approved → cancelled, החדשה pending → approved.
-- 🔴 למה בפונקציה ולא בשתי קריאות מהאפליקציה: אילוץ ה-EXCLUDE של 0096 חל על
-- `status = 'approved'`. הזזה לשעה חופפת באותו אולפן (09:00 → 09:30) הייתה
-- נדחית אם החדשה מאושרת לפני שהישנה בוטלה; וביטול הישנה לפני אישור החדשה
-- פותח חלון שבו כשל משאיר **שתיהן מבוטלות** — גם זה אסור. בפונקציה אחת אין
-- חלון: האילוץ נבדק בסוף כל פקודה, ושתיהן קורות או ששתיהן לא קורות.
-- ⚠️ `decided_at`/`decided_by` של הישנה **אינם נדרסים** — היא נשארת עם חותמת
-- האישור המקורית (decided_chk דורש רק שאינה null), כדי שהחזרה לאחור תשחזר
-- אותה בדיוק.
--
-- ═══ 3. `booking_revert_replacing` — החזרה לאחור ═══
-- המסלול האוטומטי מחזיר בקשה ל-pending כשהכתיבה ליומן נכשלה (8.10). בהזזה זה
-- אומר: החדשה approved → pending, והישנה cancelled → approved — שוב באטומיות.
-- האירוע של הישנה **עדיין ביומן** (נמחק רק אחרי שהחדשה נכתבה), ולכן אין מה
-- לשחזר שם.
--
-- ═══ 5. שלבי השיחה בבוט — `wa_conversations_step_chk` (0104) ═══
-- שלושה שלבים חדשים: 'mine' (ההקלטות שלי), 'manage' (להזיז/לבטל),
-- 'cancel-confirm' (בטוח?). ה-CHECK של 0104 מונה את השלבים במפורש, ולכן
-- הוא מוחלף ברשימה המורחבת — אחרת שמירת השיחה בשלב חדש נכשלת והבוט נופל
-- לתשובת E9-3.
--
-- ═══ 4. `calendar_delete_status` / `calendar_delete_error` ═══
-- תוצאת המחיקה מהיומן אחרי ביטול (הכרעת בעלים 11.10, כלל 2): 'deleted' |
-- 'failed' | 'not_ours' | 'dry_run'. 'failed' הוא מה שמציג ב-/bookings את
-- "המחיקה מהיומן נכשלה" עם "נסה שוב" גם אחרי רענון.
--
-- ═══ הרשאות — לפי הכלל ש-0071 קבעה ═══
-- העמודות יורשות את הרשאות הטבלה (0096): שתי העמודות החדשות אינן נכנסות לאף
-- גרנט עמודתי של anon/authenticated, ונבדק. הפונקציות: execute רק ל-
-- service_role; revoke מ-public, anon ו-authenticated, ונבדק.
--
-- ═══ מה להריץ, ובאיזה סדר ═══
--   1. `supabase/verify/0105_dryrun.sql`  — יוצר באמת, מוכיח החלפה, החלפה
--      חופפת, כשל שמגלגל את שתיהן, וחזרה לאחור, ומגלגל. **מסיים ב-exception
--      גם בהצלחה.**
--   2. הקובץ הזה.
--   3. `supabase/verify/0105_verify.sql`  — שורה אחת, כל העמודות true.
--   4. `npx supabase gen types typescript --project-id teobjwdszasavvmvukfb > src/lib/supabase/database.types.ts`
--   5. ב-Vercel: `WHATSAPP_BOOKING_MANAGE=true` (ו-redeploy).
--
-- אפס DELETE, אפס שינוי נתונים קיימים.
-- ============================================================================

do $mig$
declare
  v_n_rows_before int;
  v_n_rows_after  int;
  v_fp_before     text;
  v_fp_after      text;
begin
  -- ── 0. גארדים ──────────────────────────────────────────────────────────────
  if exists (select 1 from public.schema_ledger where version = '0105') then
    raise exception '0105 כבר רשומה בפנקס — אל תריץ שוב';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0104') then
    raise exception '0104 טרם הוחלה — הרץ אותה קודם';
  end if;

  -- טביעת אצבע של כל העמודות הקיימות, לפני ואחרי: הוכחה שאף ערך לא זז
  select count(*), md5(coalesce(string_agg(
           id::text || '|' || status || '|' || coalesce(decided_at::text, '') || '|' ||
           coalesce(calendar_write_status, '') || '|' || coalesce(calendar_event_id, ''),
           ',' order by id), ''))
    into v_n_rows_before, v_fp_before
    from public.booking_requests;

  -- ── 1. העמודות ─────────────────────────────────────────────────────────────
  alter table public.booking_requests
    add column if not exists replaces_request_id uuid null
      references public.booking_requests(id) on delete set null,
    add column if not exists calendar_delete_status text null,
    add column if not exists calendar_delete_error  text null;

  alter table public.booking_requests
    add constraint booking_requests_replaces_not_self_chk
      check (replaces_request_id is null or replaces_request_id <> id),
    add constraint booking_requests_calendar_delete_status_chk
      check (calendar_delete_status is null
             or calendar_delete_status in ('deleted', 'failed', 'not_ours', 'dry_run'));

  -- שלבי השיחה (0104 מונה אותם במפורש)
  alter table public.wa_conversations drop constraint if exists wa_conversations_step_chk;
  alter table public.wa_conversations add constraint wa_conversations_step_chk
    check (step in ('menu', 'duration', 'studio-default', 'studio', 'day', 'hour',
                    'guest', 'note', 'summary', 'submitting', 'done',
                    'mine', 'manage', 'cancel-confirm'));

  create index if not exists booking_requests_replaces_idx
    on public.booking_requests (replaces_request_id)
    where replaces_request_id is not null;

  -- ── 2. ההחלפה האטומית ─────────────────────────────────────────────────────
  create or replace function public.booking_approve_replacing(
    p_new uuid, p_old uuid, p_now timestamptz, p_actor uuid
  ) returns text
  language plpgsql
  set search_path = public
  as $fn$
  declare
    v_old int;
    v_new int;
  begin
    -- הישנה קודם: מפנה את המשבצת שלה לפני שהחדשה תופסת, כך שהזזה חופפת
    -- באותו אולפן אינה נתקלת ב-EXCLUDE. decided_at/by של הישנה לא נדרסים.
    update public.booking_requests set status = 'cancelled'
      where id = p_old and status = 'approved';
    get diagnostics v_old = row_count;

    update public.booking_requests
      set status = 'approved', decided_at = p_now, decided_by = p_actor
      where id = p_new and status = 'pending';
    get diagnostics v_new = row_count;

    -- 🔴 החדשה אינה ממתינה → אף אחד מהשינויים לא נשאר (גם ביטול הישנה)
    if v_new = 0 then
      raise exception 'booking_approve_replacing: הבקשה החדשה אינה ממתינה' using errcode = 'P0002';
    end if;

    return case when v_old = 1 then 'swapped' else 'approved-only' end;
  end;
  $fn$;

  -- ── 3. החזרה לאחור ────────────────────────────────────────────────────────
  create or replace function public.booking_revert_replacing(
    p_new uuid, p_old uuid
  ) returns text
  language plpgsql
  set search_path = public
  as $fn$
  declare
    v_new int;
    v_old int;
  begin
    update public.booking_requests
      set status = 'pending', decided_at = null, decided_by = null
      where id = p_new and status = 'approved';
    get diagnostics v_new = row_count;
    if v_new = 0 then
      raise exception 'booking_revert_replacing: הבקשה החדשה אינה מאושרת' using errcode = 'P0002';
    end if;

    update public.booking_requests set status = 'approved'
      where id = p_old and status = 'cancelled';
    get diagnostics v_old = row_count;

    return case when v_old = 1 then 'reverted' else 'new-only' end;
  end;
  $fn$;

  -- ── 4. הרשאות ─────────────────────────────────────────────────────────────
  revoke all on function public.booking_approve_replacing(uuid, uuid, timestamptz, uuid) from public, anon, authenticated;
  revoke all on function public.booking_revert_replacing(uuid, uuid) from public, anon, authenticated;
  grant execute on function public.booking_approve_replacing(uuid, uuid, timestamptz, uuid) to service_role;
  grant execute on function public.booking_revert_replacing(uuid, uuid) to service_role;

  -- ── 5. canary ─────────────────────────────────────────────────────────────
  if has_function_privilege('anon', 'public.booking_approve_replacing(uuid, uuid, timestamptz, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.booking_approve_replacing(uuid, uuid, timestamptz, uuid)', 'execute')
     or has_function_privilege('anon', 'public.booking_revert_replacing(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.booking_revert_replacing(uuid, uuid)', 'execute') then
    raise exception '0105 canary: לתפקיד של סשן יש execute על פונקציית ההחלפה — רק service_role';
  end if;
  -- 0096 נותנת ל-authenticated גרנט עמודתי מפורש; עמודה חדשה אינה נכנסת
  -- אליו מעצמה — ונבדק, לא מונח.
  if has_column_privilege('anon', 'public.booking_requests', 'replaces_request_id', 'select')
     or has_column_privilege('anon', 'public.booking_requests', 'calendar_delete_error', 'select')
     or has_column_privilege('authenticated', 'public.booking_requests', 'replaces_request_id', 'select')
     or has_column_privilege('authenticated', 'public.booking_requests', 'calendar_delete_status', 'select')
     or has_column_privilege('authenticated', 'public.booking_requests', 'calendar_delete_error', 'select') then
    raise exception '0105 canary: לתפקיד של סשן יש SELECT על עמודה חדשה ב-booking_requests';
  end if;

  select count(*), md5(coalesce(string_agg(
           id::text || '|' || status || '|' || coalesce(decided_at::text, '') || '|' ||
           coalesce(calendar_write_status, '') || '|' || coalesce(calendar_event_id, ''),
           ',' order by id), ''))
    into v_n_rows_after, v_fp_after
    from public.booking_requests;
  if v_n_rows_after <> v_n_rows_before or v_fp_after <> v_fp_before then
    raise exception '0105 canary: נתונים קיימים השתנו. nbefore=% nafter=%', v_n_rows_before, v_n_rows_after;
  end if;
  if exists (select 1 from public.booking_requests
             where replaces_request_id is not null or calendar_delete_status is not null) then
    raise exception '0105 canary: עמודה חדשה אינה null בשורה קיימת';
  end if;

  -- ── 6. שורת הפנקס ─────────────────────────────────────────────────────────
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0105', now(), 'bnaya',
    'בוט הוואטסאפ, שלב E9-5 — ביטול והזזה של הקלטה ומחיקה מהיומן. שלוש עמודות על booking_requests ושתי פונקציות, אפס backfill ואפס שינוי בנתונים קיימים (טביעת md5 לפני ואחרי). '
    'replaces_request_id: הזזה היא בקשה חדשה דרך המסלול המשותף שמקושרת להקלטה שהיא מחליפה. בלעדיה, בקשת הזזה שנשארה ממתינה ואושרה אחר כך ידנית הייתה משאירה שתי הקלטות מאושרות, וזה אסור לפי הכרעת הבעלים 11.10. CHECK שאינה מצביעה על עצמה, on delete set null. '
    'booking_approve_replacing: באותה טרנזקציה הישנה approved ל-cancelled והחדשה pending ל-approved. בפונקציה ולא בשתי קריאות, כי ה-EXCLUDE של 0096 חל על approved — הזזה חופפת באותו אולפן הייתה נדחית אם החדשה מאושרת קודם, וביטול הישנה קודם פותח חלון שבו כשל משאיר שתיהן מבוטלות. החדשה אינה ממתינה — exception ושום שינוי לא נשאר. decided_at/by של הישנה אינם נדרסים כדי שהחזרה תשחזר אותם. '
    'booking_revert_replacing: כשהכתיבה ליומן של החדשה נכשלה במסלול האוטומטי — החדשה חוזרת ל-pending והישנה ל-approved, באטומיות. האירוע של הישנה עדיין ביומן, כי הוא נמחק רק אחרי שהחדשה נכתבה. '
    'calendar_delete_status/error: תוצאת המחיקה מהיומן אחרי ביטול — deleted, failed, not_ours, dry_run — כדי ש-/bookings יציג את מצב הכשל עם נסה שוב גם אחרי רענון. '
    'wa_conversations_step_chk של 0104 מוחלף ברשימה מורחבת עם שלושה שלבים חדשים — mine, manage, cancel-confirm — כי ה-CHECK מונה את השלבים במפורש. '
    'הרשאות: execute על שתי הפונקציות ל-service_role בלבד, ונבדק. העמודות יורשות את הרשאות הטבלה ואינן בגרנט עמודתי של anon, ונבדק.');

  raise notice '✅ 0105: nrows=%', v_n_rows_after;
end $mig$;
