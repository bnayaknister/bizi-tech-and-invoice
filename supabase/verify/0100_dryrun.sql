-- ============================================================================
-- 0100 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- ═══ הקובץ הזה מבצע את כל השינויים ואז מגלגל אותם ═══
-- הוא מריץ את **אותו פרדיקט** של 0100 בדיוק, מבצע את שתי הכתיבות באמת,
-- מאמת אותן, ומסיים ב-`raise exception` — כך שאפס שינוי נשאר על המסד.
-- **גם הצלחה היא exception.**
--
-- ⚠️ שורת השגיאה האדומה בסוף היא הפלט הצפוי, לא תקלה.
--
-- ═══ 🔴 כל הדוח נמצא בהודעת השגיאה, ובמכוון ═══
-- Supabase SQL Editor **אינו מציג הודעות NOTICE** — רק את השגיאה האחרונה.
-- לכן הקובץ אוסף דוח מלא לתוך `v_rep` ומדפיס אותו **בתוך ה-exception**: מה
-- נמחק, מה סומן dismissed, התצלום המלא, ותוצאת כל בדיקה. גם בהצלחה וגם
-- בכשל. ה-NOTICEים נשארו למי שמריץ ב-psql, אבל הם אינם הערוץ הקובע.
--
-- המנגנון: בלוק `begin … exception` פנימי עוטף את כל העבודה. כשל נתפס שם,
-- ה-subtransaction מגלגל את הכתיבות, והדוח נשלח מבחוץ יחד עם השגיאה
-- המקורית. משתני plpgsql אינם טרנזקציוניים ולכן `v_rep` שורד את הגלגול —
-- זה מה שמאפשר לדווח מה נבדק עד לנקודת הכשל.
--
-- ═══ ⚠️ מספרים באנגלית, הודעות בעברית — למה ═══
-- כל מספר בדוח מופיע כ-`label=value` ב-ASCII ולעולם לא מוטבע בתוך משפט
-- עברי. ההרצה הראשונה (7.10) נכשלה והודעתה הייתה `ירד ב-% ולא ב-1` — שני
-- מספרים בתוך טקסט RTL, ומי שקרא לא יכול היה לדעת איזה מהם מה. ערבוב
-- דו-כיווני הופך הודעת שגיאה למטרידה במקום למאבחנת.
--
-- ⚠️ למה לבצע-ואז-לגלגל ולא רק לבדוק: `DELETE` שלא בוצע אינו מוכיח שהוא
--    יעבור. אם יתווסף מחר מפתח זר, אילוץ או טריגר — רק ביצוע בפועל ייתפס
--    אותו. זו המוסכמה של 0098_dryrun.sql, מאותו נימוק.
--
-- ⚠️ 🔴 **הדבר היחיד שהקובץ הזה אינו יכול לבדוק: שהתצלום נשמר.** שורת
--    ה-`events` מתגלגלת יחד עם כל השאר, ולכן "התצלום נכתב" מאומת כאן על
--    שורה שתיעלם. בדיקת האמת היחידה היא `0100_verify.sql` אחרי ההרצה
--    האמיתית, ושם היא בדיקה 9. אין archive.contract_milestones — אם ההרצה
--    האמיתית תרוץ ושורת ה-events לא תיכתב, השורה אבדה בלי העתק. **לכן
--    הדוח כאן מדפיס את התצלום במלואו: זה ההעתק שאפשר להעתיק מהמסך.**
--
-- ═══ 🐛 תוקן 8.10 — ספירה שהחריגה את השורה שהיא מודדת ═══
-- ההרצה הראשונה נכשלה ב-`מספר אבני הדרך ירד ב-0 ולא ב-1`, והכשל היה בקובץ
-- ולא בנתונים. `v_ms_n_before/after` נמדדו שניהם על
-- `contract_milestones where id <> c_dead` — כלומר השורה שעומדת להימחק
-- הוחרגה מ**שתי** הספירות, ולכן ההפרש הוא 0 **תמיד** והבדיקה
-- `before - 1 <> after` נכשלת תמיד, בכל מסד, ללא תלות בנתונים.
--
-- 🔴 **השורש: מדידה אחת שימשה שתי שאלות שונות.** ה-md5 **חייב** להחריג את
-- השורה המשתנה (הוא שואל "האם כל השאר זהה"), והספירה **חייבת לכלול** אותה
-- (היא שואלת "האם נעלמה בדיוק שורה אחת"). שתי השאלות חולקו באותו `select`,
-- ומי שהחריג עבור הראשונה שבר את השנייה.
--
-- התיקון: שני `select` נפרדים לכל טבלה — ספירה על הטבלה **כולה**, וטביעה
-- על כל השורות **מלבד** המשתנה. אותו תיקון הוחל על
-- `0100_orphan_milestone_ey_cleanup.sql`, שנשא את אותו קוד בדיוק והיה נכשל
-- באותה בדיקה. `0100_verify.sql` אינו נגוע: אין בו זוג לפני/אחרי כלל, וכל
-- בדיקה בו מודדת או את השורה עצמה או אוכלוסייה שלמה.
--
-- ⚠️ זה אותו מחלקת באג שנתפסה קודם בטביעת ה-jobs (שם הוחרג מזהה אבן הדרך
--    במקום מזהה ה-job). שלוש פעמים אותה צורה: **בדיקת "אחרי" שמודדת
--    אוכלוסייה שאינה מכילה את מה שהשתנה.**
--
-- ═══ מה נבדק ═══
--   1.  גארדי הפנקס — 0099 קיימת, 0100 אינה.
--   2.  אבן הדרך המתה: קיימת · pending · סכום 9600 · expected_date 2026-10-04.
--   3.  job_id אינו ריק.
--   4.  ה-job: קיים · invoice_biz ריק · invoice_tax ריק · paid ≠ כן · לא dismissed.
--   5.  אפס מסמכים חיים — **בשתי הדלתות**, job_id וגם bundle_job_ids.
--   6.  לפחות מסמך מבוטל אחד.
--   7.  אבן הדרך החיה: אותו חוזה · יש job · job אחר · לפחות מסמך חי אחד.
--   8.  אפס מפתחות זרים אל contract_milestones (תנאי הבעלים למחיקה).
--   9.  ההפניות הרכות ב-events — נספרות ומדווחות, לא חוסמות.
--   10. העדכון נגע בשורה אחת בדיוק, והערכים נקראו חזרה מהטבלה.
--   11. המחיקה נגעה בשורה אחת בדיוק, ואבן הדרך החיה שרדה.
--   12. 🔴 אף job אחר ואף אבן דרך אחרת לא זזו — ספירה **וגם** md5.
-- ============================================================================

do $dry$
declare
  c_dead constant uuid    := '1b55f005-12f8-4280-a49e-9cd4d33e0b79';
  c_live constant uuid    := '1b5e4654-b2e2-4f59-8ed3-317ef336df07';
  c_amount   constant numeric := 9600;
  c_expected constant date    := '2026-10-04';

  v_contract   uuid;
  v_dead_job   uuid;
  v_live_job   uuid;
  v_status     text;
  v_amount     numeric;
  v_expected   date;
  v_name       text;
  v_paid       text;
  v_biz        text;
  v_tax        text;
  v_dismissed  boolean;

  v_live_docs      int;
  v_cancelled_docs int;
  v_live_ms_docs   int;
  v_hard_fks       int;
  v_event_refs     int;

  v_snapshot  jsonb;
  v_job_snap  jsonb;
  v_n         int;
  c_reason    text;

  -- ── ספירות ─────────────────────────────────────────────────────────────────
  -- על הטבלה **כולה**. השאלה: האם נעלמה בדיוק שורה אחת (אבני דרך) / אפס
  -- שורות (jobs). השורה המשתנה **נכללת**, אחרת אין מה למדוד.
  v_jobs_n_before int;
  v_jobs_n_after  int;
  v_ms_n_before   int;
  v_ms_n_after    int;

  -- ── טביעות ─────────────────────────────────────────────────────────────────
  -- על כל השורות **מלבד** המשתנה. השאלה: האם כל השאר זהה תו-בתו.
  v_jobs_before text;
  v_jobs_after  text;
  v_ms_before   text;
  v_ms_after    text;

  v_rb_dismissed boolean;
  v_rb_reason    text;
  v_rb_at        timestamptz;
  v_rb_by        uuid;

  -- הדוח, ומצב הריצה. `v_rep` שורד גלגול כי משתני plpgsql אינם טרנזקציוניים.
  v_rep   text := '';
  v_ok    boolean := false;
  v_err   text;
  v_state text;
begin
  begin
    -- ── 0. הקובץ הזה הוא PRE-migration ──────────────────────────────────────
    if exists (select 1 from public.schema_ledger where version = '0100') then
      raise exception '0100 כבר בפנקס — המיגרציה הוחלה. הרץ את 0100_verify.sql במקום.';
    end if;
    if not exists (select 1 from public.schema_ledger where version = '0099') then
      raise exception '0099 אינה בפנקס. הפנקס הוא הרצף — המדידות כאן נגזרו ממסד אחר. הרץ אותה קודם.';
    end if;
    v_rep := v_rep || E'\n[1] ledger ....... OK   has_0099=yes  has_0100=no';
    raise notice '✅ 1. גארדי הפנקס: 0099 קיימת, 0100 אינה.';

    -- ── 2. אבן הדרך המתה ────────────────────────────────────────────────────
    select m.contract_id, m.job_id, m.status, m.amount, m.expected_date, m.name
      into v_contract, v_dead_job, v_status, v_amount, v_expected, v_name
    from public.contract_milestones m
    where m.id = c_dead;

    if v_contract is null then
      raise exception 'אבן הדרך לא נמצאה. milestone=%', c_dead;
    end if;
    if v_status <> 'pending' then
      raise exception 'status לא pending. status_found=% status_expected=pending', v_status;
    end if;
    if v_amount <> c_amount then
      raise exception 'סכום אבן הדרך אינו כפי שנמדד. amount_found=% amount_expected=%', v_amount, c_amount;
    end if;
    if v_expected is distinct from c_expected then
      raise exception 'expected_date אינו כפי שנמדד. date_found=% date_expected=%', v_expected, c_expected;
    end if;
    v_rep := v_rep || E'\n[2] milestone .... OK   id=' || c_dead
                   || '  name=' || coalesce(v_name, '(null)')
                   || '  amount=' || v_amount
                   || '  expected_date=' || v_expected
                   || '  status=' || v_status
                   || '  contract=' || v_contract;
    raise notice '✅ 2. אבן הדרך המתה: "%" · ₪% · %', v_name, v_amount, v_expected;

    -- ── 3. job_id ───────────────────────────────────────────────────────────
    if v_dead_job is null then
      raise exception 'job_id ריק — אבן הדרך אינה מגיעה לענף הלא-מעוגן כלל, ואין job לסמן.';
    end if;
    v_rep := v_rep || E'\n[3] job link ..... OK   job=' || v_dead_job;
    raise notice '✅ 3. job מקושר: %', v_dead_job;

    -- ── 4. ה-job נקי ────────────────────────────────────────────────────────
    select j.paid::text, j.invoice_biz, j.invoice_tax, j.dismissed
      into v_paid, v_biz, v_tax, v_dismissed
    from public.jobs j where j.id = v_dead_job;

    if v_paid is null then
      raise exception 'ה-job לא נמצא — מפתח זר שבור. job=%', v_dead_job;
    end if;
    if coalesce(btrim(v_biz), '') <> '' then
      raise exception 'מסמך חיוב עומד על ה-job. invoice_biz=%', v_biz;
    end if;
    if coalesce(btrim(v_tax), '') <> '' then
      raise exception 'מסמך מס עומד על ה-job. invoice_tax=%', v_tax;
    end if;
    if v_paid = 'כן' then
      raise exception 'כסף נכנס על ה-job. paid=%', v_paid;
    end if;
    if v_dismissed then
      raise exception 'ה-job כבר dismissed. job=%', v_dead_job;
    end if;
    v_rep := v_rep || E'\n[4] job is clean . OK   invoice_biz=(empty)  invoice_tax=(empty)  paid='
                   || v_paid || '  dismissed=false';
    raise notice '✅ 4. ה-job נקי.';

    -- ── 5+6. המסמכים, בשתי הדלתות ───────────────────────────────────────────
    select count(*) into v_live_docs
    from public.documents d
    where (d.job_id = v_dead_job or d.bundle_job_ids @> array[v_dead_job])
      and d.cancelled_at is null and d.archived_at is null;
    if v_live_docs <> 0 then
      raise exception 'יש מסמכים חיים על ה-job — אינו יתום. live_docs=% live_docs_expected=0', v_live_docs;
    end if;

    select count(*) into v_cancelled_docs
    from public.documents d
    where (d.job_id = v_dead_job or d.bundle_job_ids @> array[v_dead_job])
      and d.cancelled_at is not null;
    if v_cancelled_docs < 1 then
      raise exception 'אפס מסמכים מבוטלים — זה מקרה אחר (אבן דרך שהונפקה לתור ומעולם לא יצאה), ואסור לנקות אותו כאן. cancelled_docs=%', v_cancelled_docs;
    end if;
    v_rep := v_rep || E'\n[5] live docs .... OK   live_docs=0 (by job_id and bundle_job_ids)'
                   || E'\n[6] cancelled .... OK   cancelled_docs=' || v_cancelled_docs;
    raise notice '✅ 5+6. מסמכים: 0 חיים · % מבוטלים', v_cancelled_docs;

    -- ── 7. אבן הדרך החיה ────────────────────────────────────────────────────
    select m.job_id into v_live_job
    from public.contract_milestones m
    where m.id = c_live and m.contract_id = v_contract;
    if not found then
      raise exception 'אבן הדרך החיה אינה תחת אותו חוזה — המחיקה הייתה איבוד התחייבות ולא ניקוי כפילות. live_milestone=% contract=%', c_live, v_contract;
    end if;
    if v_live_job is null then
      raise exception 'לאבן הדרך החיה אין job. live_milestone=%', c_live;
    end if;
    if v_live_job = v_dead_job then
      raise exception 'שתי אבני הדרך על אותו job — אמור להיות בלתי אפשרי (0086). job=%', v_dead_job;
    end if;

    select count(*) into v_live_ms_docs
    from public.documents d
    where (d.job_id = v_live_job or d.bundle_job_ids @> array[v_live_job])
      and d.cancelled_at is null and d.archived_at is null;
    if v_live_ms_docs < 1 then
      raise exception 'לאבן הדרך החיה אין מסמך חי — אין הצדקה למחוק את הישנה. live_milestone_docs=%', v_live_ms_docs;
    end if;
    v_rep := v_rep || E'\n[7] replacement .. OK   live_milestone=' || c_live
                   || '  live_job=' || v_live_job
                   || '  live_milestone_docs=' || v_live_ms_docs;
    raise notice '✅ 7. אבן הדרך החיה: job % · % מסמכים חיים', v_live_job, v_live_ms_docs;

    -- ── 8. מפתחות זרים — תנאי הבעלים ────────────────────────────────────────
    select count(*) into v_hard_fks
    from pg_constraint con
    join pg_class    rel on rel.oid = con.confrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where con.contype = 'f' and ns.nspname = 'public' and rel.relname = 'contract_milestones';
    if v_hard_fks > 0 then
      raise exception 'מפתחות זרים מצביעים על contract_milestones. הכרעת הבעלים: הפניה קשיחה = לא מוחקים. hard_fks=% hard_fks_expected=0', v_hard_fks;
    end if;
    v_rep := v_rep || E'\n[8] hard FKs ..... OK   hard_fks=0';
    raise notice '✅ 8. אפס מפתחות זרים אל contract_milestones.';

    -- ── 9. ההפניות הרכות — מדווחות, לא חוסמות ──────────────────────────────
    select count(*) into v_event_refs
    from public.events e where e.payload->>'milestone_id' = c_dead::text;
    v_rep := v_rep || E'\n[9] soft refs .... OK   orphaned_event_refs=' || v_event_refs
                   || '  (kept on purpose - audit log)';
    raise notice '✅ 9. % שורות events יתומות אחרי המחיקה, ובמכוון אינן נמחקות.', v_event_refs;

    -- ── התצלום ──────────────────────────────────────────────────────────────
    select to_jsonb(m) into v_snapshot from public.contract_milestones m where m.id = c_dead;
    select to_jsonb(j) into v_job_snap from public.jobs j where j.id = v_dead_job;

    -- ── ספירות וטביעות "לפני" ───────────────────────────────────────────────
    -- 🔴 שני select נפרדים לכל טבלה, וזה כל התיקון של 8.10. הספירה על הטבלה
    --    כולה (השורה המשתנה **נכללת**), הטביעה על כל השאר (**מוחרגת**).
    --    select אחד ששירת את שתיהן הוא מה שגרם לכשל הראשון.
    -- ⚠️ `order by id` אינו קישוט: md5 של string_agg בלי סדר קבוע אינו יציב
    --    בין שתי קריאות, והבדיקה הייתה נכשלת או עוברת באקראי.
    select count(*) into v_jobs_n_before from public.jobs;
    select count(*) into v_ms_n_before   from public.contract_milestones;

    select md5(coalesce(string_agg(t.row_text, '|' order by t.id), '')) into v_jobs_before
    from (select j.id, j::text as row_text from public.jobs j where j.id <> v_dead_job) t;

    select md5(coalesce(string_agg(t.row_text, '|' order by t.id), '')) into v_ms_before
    from (select m.id, m::text as row_text from public.contract_milestones m where m.id <> c_dead) t;

    -- ── 10. הכתיבה הראשונה ──────────────────────────────────────────────────
    c_reason := 'אבן דרך יתומה: מסמכיה בוטלו והונפקו מחדש על אבן הדרך '
             || c_live::text
             || ' באותו חוזה, בעקבות שינוי ח.פ של הלקוח. נוקה במיגרציה 0100, 7.10.2026.';

    update public.jobs
       set dismissed = true, dismiss_reason = c_reason, dismissed_at = now(), dismissed_by = null
     where id = v_dead_job and dismissed = false;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception 'עדכון ה-job לא נגע בשורה אחת. rows_updated=% rows_expected=1', v_n;
    end if;

    -- נקרא חזרה מהטבלה ולא מונח מספירת השורות (הלקח של 0083).
    select j.dismissed, j.dismiss_reason, j.dismissed_at, j.dismissed_by
      into v_rb_dismissed, v_rb_reason, v_rb_at, v_rb_by
    from public.jobs j where j.id = v_dead_job;
    if not v_rb_dismissed then
      raise exception 'dismissed לא נכתב.';
    end if;
    if v_rb_reason <> c_reason then
      raise exception 'dismiss_reason נקרא חזרה אחרת ממה שנכתב. read_back=%', v_rb_reason;
    end if;
    if v_rb_at is null then
      raise exception 'dismissed_at נשאר ריק.';
    end if;
    if v_rb_by is not null then
      raise exception 'dismissed_by אינו null — מיגרציה אינה אדם (מוסכמת 0041/0095). dismissed_by=%', v_rb_by;
    end if;
    v_rep := v_rep || E'\n[10] job update .. OK   rows_updated=1  dismissed=true  dismissed_at='
                   || v_rb_at || '  dismissed_by=null';
    raise notice '✅ 10. ה-job עודכן ונקרא חזרה.';

    -- ── 11. המחיקה ──────────────────────────────────────────────────────────
    delete from public.contract_milestones where id = c_dead;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception 'המחיקה לא נגעה בשורה אחת. rows_deleted=% rows_expected=1', v_n;
    end if;
    if exists (select 1 from public.contract_milestones where id = c_dead) then
      raise exception 'אבן הדרך עדיין שם אחרי DELETE. milestone=%', c_dead;
    end if;
    if not exists (select 1 from public.contract_milestones where id = c_live) then
      raise exception 'canary: אבן הדרך החיה נעלמה. live_milestone=%', c_live;
    end if;
    v_rep := v_rep || E'\n[11] delete ...... OK   rows_deleted=1  live_milestone_survived=yes';
    raise notice '✅ 11. אבן הדרך נמחקה, והחיה שרדה.';

    -- שורת ה-events — נכתבת כדי להוכיח שהיא עוברת, ומתגלגלת יחד עם השאר.
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('contract', v_contract, 'milestone_orphan_cleaned', null,
      jsonb_build_object(
        'via', '0100', 'milestone_id', c_dead, 'milestone_name', v_name,
        'replaced_by', c_live, 'contract_id', v_contract, 'job_id', v_dead_job,
        'job_dismiss_reason', c_reason, 'cancelled_docs', v_cancelled_docs,
        'live_docs', v_live_docs, 'live_milestone_docs', v_live_ms_docs,
        'orphaned_event_refs', v_event_refs,
        'milestone_snapshot', v_snapshot, 'job_snapshot_before', v_job_snap
      ));
    if not exists (
      select 1 from public.events
      where event_type = 'milestone_orphan_cleaned' and payload->>'via' = '0100'
    ) then
      raise exception 'שורת ה-events לא נכתבה.';
    end if;
    v_rep := v_rep || E'\n[11b] audit row .. OK   events row written with snapshot (will roll back)';
    raise notice '✅ 11ב. שורת events נכתבה עם התצלום.';

    -- ── 12. 🔴 מה שלא אמור לזוז, לא זז ──────────────────────────────────────
    select count(*) into v_jobs_n_after from public.jobs;
    select count(*) into v_ms_n_after   from public.contract_milestones;

    select md5(coalesce(string_agg(t.row_text, '|' order by t.id), '')) into v_jobs_after
    from (select j.id, j::text as row_text from public.jobs j where j.id <> v_dead_job) t;

    select md5(coalesce(string_agg(t.row_text, '|' order by t.id), '')) into v_ms_after
    from (select m.id, m::text as row_text from public.contract_milestones m where m.id <> c_dead) t;

    if v_jobs_n_before <> v_jobs_n_after then
      raise exception 'מספר שורות jobs השתנה — הקובץ מעדכן ואינו מוסיף או מוחק job. jobs_before=% jobs_after=% jobs_expected_after=%',
        v_jobs_n_before, v_jobs_n_after, v_jobs_n_before;
    end if;
    if v_jobs_before <> v_jobs_after then
      raise exception 'טביעת ה-jobs שאינם ה-job הנגוע השתנתה — נגענו ב-job שלא היה אמור לזוז. md5_before=% md5_after=%',
        v_jobs_before, v_jobs_after;
    end if;
    if v_ms_n_after <> v_ms_n_before - 1 then
      raise exception 'מספר אבני הדרך לא ירד בדיוק באחת. ms_before=% ms_after=% ms_expected_after=% delta=%',
        v_ms_n_before, v_ms_n_after, v_ms_n_before - 1, v_ms_n_before - v_ms_n_after;
    end if;
    if v_ms_before <> v_ms_after then
      raise exception 'טביעת אבני הדרך שאינן הנמחקת השתנתה — נגענו באבן דרך שלא הייתה אמורה לזוז. md5_before=% md5_after=%',
        v_ms_before, v_ms_after;
    end if;
    v_rep := v_rep || E'\n[12] no collateral damage .. OK'
                   || E'\n     jobs_count:      before=' || v_jobs_n_before || '  after=' || v_jobs_n_after || '  (expected equal)'
                   || E'\n     jobs_md5:        identical (excluding the updated job)'
                   || E'\n     milestones_count: before=' || v_ms_n_before || '  after=' || v_ms_n_after || '  (expected after = before - 1)'
                   || E'\n     milestones_md5:  identical (excluding the deleted milestone)';
    raise notice '✅ 12. אפס נזק צדדי.';

    v_ok := true;
  exception
    when others then
      v_err   := SQLERRM;
      v_state := SQLSTATE;
  end;

  -- ── הדוח, ואיתו הגלגול ────────────────────────────────────────────────────
  -- בשני המסלולים `raise exception` — גם בהצלחה. זה מה שמגלגל, וזה גם הערוץ
  -- היחיד ש-Supabase SQL Editor מציג.
  if v_ok then
    raise exception E'✅ 0100 DRY RUN עבר — הכול גולגל, אפס שינוי נשאר על המסד.\n'
      E'═══════════════════════════════════════════════════════════════════\n'
      E'מה המיגרציה האמיתית תעשה:\n'
      E'  1. jobs: השורה % תסומן dismissed=true עם הנימוק שלמטה.\n'
      E'  2. contract_milestones: השורה % תימחק.\n'
      E'  3. events: שורת milestone_orphan_cleaned עם התצלום המלא.\n'
      E'  4. schema_ledger: שורת 0100.\n'
      E'═══════════════════════════════════════════════════════════════════\n'
      E'תוצאות הבדיקות:%\n'
      E'═══════════════════════════════════════════════════════════════════\n'
      E'🔴 התצלום — אין archive.contract_milestones, וזה ההעתק היחיד שישרוד.\n'
      E'העתק את שתי השורות הבאות מהמסך לפני שתריץ את המיגרציה:\n\n'
      E'milestone_snapshot = %\n\n'
      E'job_snapshot_before = %\n'
      E'═══════════════════════════════════════════════════════════════════\n'
      E'dismiss_reason שייכתב:\n%\n'
      E'═══════════════════════════════════════════════════════════════════\n'
      E'אפשר להריץ את supabase/migrations/0100_orphan_milestone_ey_cleanup.sql\n'
      E'⚠️ השגיאה הזו היא הפלט הצפוי. שום דבר לא נכתב.',
      v_dead_job, c_dead, v_rep, v_snapshot, v_job_snap, c_reason;
  else
    raise exception E'❌ 0100 DRY RUN נכשל — שום דבר לא נכתב, אל תריץ את המיגרציה.\n'
      E'═══════════════════════════════════════════════════════════════════\n'
      E'הכשל:   %\n'
      E'SQLSTATE: %\n'
      E'═══════════════════════════════════════════════════════════════════\n'
      E'מה נבדק בהצלחה עד לנקודת הכשל:%\n'
      E'═══════════════════════════════════════════════════════════════════\n'
      E'כל המספרים בדוח הם label=value. אם שני מספרים נראים הפוכים על המסך,\n'
      E'זה ערבוב RTL של התצוגה — התוויות הן הקובעות, לא הסדר החזותי.',
      v_err, v_state, v_rep;
  end if;
end $dry$;
