-- ============================================================================
-- 0102 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- ═══ הקובץ הזה מבצע את כל השינויים ואז מגלגל אותם ═══
-- הוא מריץ את שינויי ה-DDL של 0102 **באמת** על הטבלאות האמיתיות, כותב שורות
-- אמיתיות, מוכיח שכל ערך סטטוס חדש **מתקבל** ושכל ערך פסול **נדחה**, מוכיח
-- את הייחודיות של `provider_wamid` ואת שחרור המשבצת בביטול, ומסיים ב-
-- `raise exception` — כך שאפס שינוי נשאר על המסד. **גם הצלחה היא exception.**
--
-- ⚠️ שורת השגיאה האדומה בסוף היא הפלט הצפוי, לא תקלה.
--
-- 🔴 **הקובץ הזה כותב לטבלאות אמיתיות עם נתונים אמיתיים** — בניגוד ל-
--    0101_dryrun, שיצר טבלה חדשה. כל הכתיבות מגולגלות, אבל זו הסיבה שכל שורה
--    שהוא יוצר נושאת מזהה `dryrun.` מוכר, ושהוא **מוחק את שלו** לפני הגלגול
--    ומאמת את הספירות לפני ואחרי. אם אי פעם תראה שורה עם המזהה הזה בייצור,
--    הגלגול נכשל ויש מה לנקות.
--
-- ═══ 🔴 כל הדוח נמצא בהודעת השגיאה, ובמכוון ═══
-- Supabase SQL Editor **אינו מציג הודעות NOTICE** — רק את השגיאה האחרונה.
-- הדוח נאסף ב-`v_rep` ונשלח **בתוך** ה-exception, גם בהצלחה וגם בכשל.
-- ההודעה המסכמת נבנית ב-`v_msg` עם `||` ועם `E'\n'` מפורש בכל מקטע, ועוברת
-- כארגומנט (`raise exception '%', v_msg`) — אין כאן המשך ליטרלים בכלל, ולכן
-- השאלה "האם ההמשך יורש escape" אינה קיימת (הלקח של 0100_dryrun, 8.10).
-- כל מספר מופיע כ-`label=value` ב-ASCII ולעולם לא מוטבע בתוך משפט עברי.
-- ============================================================================

do $dry$
declare
  v_rep text := '';
  v_msg text;
  v_caught       int := 0;
  -- ניסיונות הפרה שחייבים להידחות. מתחיל ב-3 (של ההודעות) וגדל ל-6
  -- רק אם יש קישור הזמנה פעיל — בלעדיו אי אפשר לבנות שורת בקשה בכלל.
  v_expected     int := 3;
  v_wa_before    int;
  v_wa_after     int;
  v_br_before    int;
  v_br_after     int;
  v_show         uuid;
  v_link         uuid;
  v_req          uuid;
  v_blocking     int;
  v_free_after   int;
  v_studio       text := 'גבעון';
  v_start        timestamptz;
begin
  if exists (select 1 from public.schema_ledger where version = '0102') then
    raise exception '0102 כבר רשומה בפנקס — אין מה להריץ מדומה. הרץ את 0102_verify.sql';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0101') then
    raise exception '0101 טרם הוחלה — wa_messages אינה קיימת';
  end if;

  select count(*) into v_wa_before from public.wa_messages;
  select count(*) into v_br_before from public.booking_requests;
  v_rep := v_rep || E'\n  before: wa_rows=' || v_wa_before::text || ' br_rows=' || v_br_before::text;

  begin
    -- ── 1. ה-DDL, מילה במילה כמו ב-0102 ───────────────────────────────────
    alter table public.wa_messages
      add column if not exists provider_wamid text null,
      add column if not exists error          text null,
      add column if not exists status_at      timestamptz null;

    create unique index if not exists wa_messages_provider_wamid_key
      on public.wa_messages (provider_wamid) where provider_wamid is not null;

    alter table public.wa_messages drop constraint if exists wa_messages_status_chk;
    alter table public.wa_messages
      add constraint wa_messages_status_chk
      check (status in ('received', 'queued', 'sent', 'delivered', 'read', 'failed', 'dry_run'));

    alter table public.booking_requests drop constraint if exists booking_requests_status_chk;
    alter table public.booking_requests
      add constraint booking_requests_status_chk
      check (status in ('pending', 'approved', 'declined', 'cancelled'));

    v_rep := v_rep || E'\n  ddl applied: ok=true';

    -- ── 2. כל ערך סטטוס חדש **מתקבל** ─────────────────────────────────────
    -- מחזור החיים המלא של הודעה יוצאת אמיתית, סטטוס אחרי סטטוס.
    insert into public.wa_messages (wamid, direction, wa_id, type, body, template_name, status)
    values ('dryrun.0102.out', 'out', '972500000000', 'template', 'גוף ההודעה', 'bizi_booking_approved', 'queued');

    update public.wa_messages
      set status = 'sent', provider_wamid = 'wamid.dryrun.META.1', status_at = now()
      where wamid = 'dryrun.0102.out';
    update public.wa_messages set status = 'delivered', status_at = now() where wamid = 'dryrun.0102.out';
    update public.wa_messages set status = 'read',      status_at = now() where wamid = 'dryrun.0102.out';
    update public.wa_messages
      set status = 'failed', error = 'Meta החזירה 131047', status_at = now()
      where wamid = 'dryrun.0102.out';
    v_rep := v_rep || E'\n  statuses accepted (queued,sent,delivered,read,failed): ok=true';

    -- והנכנסות לא נשברו: received עדיין חוקי, ועדיין בלי תבנית
    insert into public.wa_messages (wamid, direction, wa_id, type, body, status)
    values ('dryrun.0102.in', 'in', '972500000001', 'text', 'היי', 'received');
    v_rep := v_rep || E'\n  inbound still accepted: ok=true';

    -- ── 3. מה שחייב להידחות ───────────────────────────────────────────────
    begin
      insert into public.wa_messages (wamid, direction, wa_id, status)
      values ('dryrun.0102.bad1', 'out', '972500000000', 'acknowledged');
      raise exception 'סטטוס שאינו ברשימה התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught wa status not in list: caught=1';
    end;

    -- אילוץ הצימוד של 0101 נשאר: נכנסת חייבת להיות received
    begin
      insert into public.wa_messages (wamid, direction, wa_id, status)
      values ('dryrun.0102.bad2', 'in', '972500000000', 'delivered');
      raise exception 'נכנסת עם status=delivered התקבלה';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught pair chk (in+delivered): caught=1';
    end;

    -- 🔴 הייחודיות של provider_wamid — ההבטחה שהתאמת עדכוני מצב נשענת עליה
    begin
      insert into public.wa_messages (wamid, direction, wa_id, status, provider_wamid)
      values ('dryrun.0102.dup', 'out', '972500000000', 'sent', 'wamid.dryrun.META.1');
      raise exception 'provider_wamid כפול התקבל — עדכון מצב יוכל להתאים לשתי שורות';
    exception when unique_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught unique provider_wamid: caught=1';
    end;

    -- ⚠️ אבל כמה NULLים כן מותרים, וזה הכרחי: כל שורה ב-dry_run וכל שורה
    -- נכנסת לעולם לא תקבל מזהה.
    insert into public.wa_messages (wamid, direction, wa_id, status) values ('dryrun.0102.null1', 'out', '972500000000', 'dry_run');
    insert into public.wa_messages (wamid, direction, wa_id, status) values ('dryrun.0102.null2', 'out', '972500000000', 'dry_run');
    v_rep := v_rep || E'\n  two null provider_wamid rows coexist: ok=true';

    -- ── 4. 🔴 הביטול משחרר את המשבצת. הבדיקה שאין לה תחליף. ───────────────
    -- נבנית שורה מאושרת אמיתית, נמדד שהיא חוסמת, היא מבוטלת, ונמדד
    -- שהיא חדלה לחסום — דרך אותו פרדיקט שהקוד משתמש בו.
    select id, show_id into v_link, v_show from public.booking_links where revoked_at is null limit 1;
    if v_link is null then
      v_rep := v_rep || E'\n  SKIPPED slot-release test: no active booking_link exists yet';
    else
      v_expected := 6;

      -- מועד רחוק ועגול, כדי לא להתנגש בשום דבר אמיתי
      v_start := date_trunc('hour', now() + interval '45 days') + interval '3 hours';

      -- סטטוס בקשה שאינו ברשימה — על שורה אמיתית ולא דרך INSERT..SELECT
      -- שעלול להכניס אפס שורות ולא להפר שום דבר.
      begin
        insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, status, decided_at)
        values (v_show, v_link, v_studio, v_start + interval '5 days', v_start + interval '5 days' + interval '90 minutes', 'archived', now());
        raise exception 'סטטוס בקשה שאינו ברשימה התקבל';
      exception when check_violation then
        v_caught := v_caught + 1;
        v_rep := v_rep || E'\n  caught br status not in list: caught=1';
      end;

      insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, status, decided_at)
      values (v_show, v_link, v_studio, v_start, v_start + interval '90 minutes', 'approved', now())
      returning id into v_req;

      -- אותו פרדיקט של loadApprovedRequests: approved שחופף לטווח
      select count(*) into v_blocking from public.booking_requests
        where status = 'approved' and studio = v_studio
          and start_at < v_start + interval '90 minutes' and end_at > v_start;
      v_rep := v_rep || E'\n  approved row blocks: nblocking=' || v_blocking::text || ' expected>=1';
      if v_blocking < 1 then
        raise exception 'שורה מאושרת אינה חוסמת: nblocking=%', v_blocking;
      end if;

      -- ⚠️ וההוכחה שה-EXCLUDE חי: אישור שני חופף באותו חדר חייב להידחות
      begin
        insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, status, decided_at)
        values (v_show, v_link, v_studio, v_start + interval '30 minutes', v_start + interval '2 hours', 'approved', now());
        raise exception 'שני אישורים חופפים באותו חדר התקבלו — ה-EXCLUDE אינו חי';
      exception when exclusion_violation then
        v_caught := v_caught + 1;
        v_rep := v_rep || E'\n  caught EXCLUDE on overlapping approved: caught=1';
      end;

      -- הביטול
      update public.booking_requests set status = 'cancelled', decided_at = now() where id = v_req;

      select count(*) into v_blocking from public.booking_requests
        where status = 'approved' and studio = v_studio
          and start_at < v_start + interval '90 minutes' and end_at > v_start;
      v_rep := v_rep || E'\n  after cancel, blocking: nblocking=' || v_blocking::text || ' expected=0';
      if v_blocking <> 0 then
        raise exception 'ביטול לא שחרר את המשבצת: nblocking=%', v_blocking;
      end if;

      -- 🔴 ואחרי הביטול אפשר לאשר שוב את אותה משבצת בדיוק. זו המשמעות
      --    המעשית של "משחרר": לא רק שהיא לא חוסמת בשאילתה, אלא שה-EXCLUDE
      --    מתיר אישור חדש עליה.
      insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, status, decided_at)
      values (v_show, v_link, v_studio, v_start, v_start + interval '90 minutes', 'approved', now());
      select count(*) into v_free_after from public.booking_requests
        where status = 'approved' and studio = v_studio and start_at = v_start;
      v_rep := v_rep || E'\n  slot re-approvable after cancel: napproved=' || v_free_after::text || ' expected=1';
      if v_free_after <> 1 then
        raise exception 'אי אפשר לאשר מחדש משבצת שבוטלה: napproved=%', v_free_after;
      end if;

      -- וביטול בלי חותמת נדחה — booking_requests_decided_chk
      begin
        update public.booking_requests set status = 'cancelled', decided_at = null where id = v_req;
        raise exception 'cancelled בלי decided_at התקבל';
      exception when check_violation then
        v_caught := v_caught + 1;
        v_rep := v_rep || E'\n  caught decided_chk (cancelled without decided_at): caught=1';
      end;
    end if;

    v_rep := v_rep || E'\n  violations caught: ncaught=' || v_caught::text
                   || ' expected=' || v_expected::text;
    if v_caught <> v_expected then
      raise exception 'לא כל ניסיונות ההפרה נדחו: ncaught=% expected=%', v_caught, v_expected;
    end if;

    -- ── 5. ניקוי מה שהקובץ הזה יצר, ואימות הספירות ────────────────────────
    -- מחיקה מפורשת ולא הסתמכות על הגלגול בלבד: אם הגלגול ייכשל מסיבה
    -- כלשהי, המחיקה הזאת היא מה שמשאיר את המסד נקי.
    delete from public.wa_messages where wamid like 'dryrun.0102.%';
    delete from public.booking_requests
      where link_id = v_link and studio = v_studio and start_at = v_start;

    select count(*) into v_wa_after from public.wa_messages;
    select count(*) into v_br_after from public.booking_requests;
    v_rep := v_rep || E'\n  after cleanup: wa_rows=' || v_wa_after::text || ' br_rows=' || v_br_after::text;
    if v_wa_after <> v_wa_before or v_br_after <> v_br_before then
      raise exception 'הניקוי לא החזיר את הספירות: wa_before=% wa_after=% br_before=% br_after=%',
        v_wa_before, v_wa_after, v_br_before, v_br_after;
    end if;

  exception when others then
    v_msg := E'❌ 0102 dryrun נכשלה.\n'
          || E'═══ מה נבדק עד לנקודת הכשל ═══'
          || v_rep
          || E'\n\n═══ השגיאה ═══\n  '
          || sqlstate || ' ' || sqlerrm
          || E'\n\nה-subtransaction גולגל. אפס שינוי נשאר על המסד.';
    raise exception '%', v_msg;
  end;

  v_msg := E'✅ 0102 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n'
        || E'═══ הדוח ═══'
        || v_rep
        || E'\n\n═══ מה הוכח ═══\n'
        || E'  · שלוש העמודות נוספות, והאינדקס הייחודי החלקי על provider_wamid נוצר\n'
        || E'  · מחזור החיים המלא של הודעה יוצאת עובר: queued→sent→delivered→read→failed\n'
        || E'  · נכנסת עדיין חייבת להיות received, ואילוץ הצימוד של 0101 לא נשבר\n'
        || E'  · provider_wamid כפול נדחה, אבל כמה NULLים כן מותרים — בדיוק מה שדרוש\n'
        || E'  · booking_requests מקבל cancelled, ודוחה סטטוס שאינו ברשימה\n'
        || E'  · 🔴 ביטול **משחרר את המשבצת**: שורה מאושרת חוסמת, ה-EXCLUDE דוחה אישור חופף, ואחרי הביטול אותה משבצת בדיוק ניתנת לאישור מחדש\n'
        || E'  · cancelled בלי decided_at נדחה\n'
        || E'  · כל השורות שהקובץ יצר נמחקו והספירות חזרו למקור\n'
        || E'\nעכשיו אפשר להריץ את supabase/migrations/0102_wa_delivery_and_cancel.sql';
  raise exception '%', v_msg;
end $dry$;
