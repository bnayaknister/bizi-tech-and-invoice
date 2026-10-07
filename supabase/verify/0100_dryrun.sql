-- ============================================================================
-- 0100 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- ═══ הקובץ הזה מבצע את כל השינויים ואז מגלגל אותם ═══
-- הוא מריץ את **אותו פרדיקט** של 0100 בדיוק, מדפיס מה היה משתנה, מבצע את שני
-- הכתיבות באמת, מאמת אותן, ומסיים ב-`raise exception` — כך שאפס שינוי נשאר
-- על המסד. **גם הצלחה היא exception.**
-- אם אתם רואים ✅ בשורות ה-NOTICE — הכול נבדק והכול גולגל.
--
-- ⚠️ שורת השגיאה האדומה בסוף היא הפלט הצפוי, לא תקלה.
--
-- ⚠️ למה לבצע-ואז-לגלגל ולא רק לבדוק: `DELETE` שלא בוצע אינו מוכיח שהוא
--    יעבור. אם יתווסף מחר מפתח זר, אילוץ או טריגר — רק ביצוע בפועל ייתפס
--    אותו. זו המוסכמה של 0098_dryrun.sql, מאותו נימוק.
--
-- ⚠️ 🔴 **הדבר היחיד שהקובץ הזה אינו יכול לבדוק: שהתצלום נשמר.** שורת
--    ה-`events` מתגלגלת יחד עם כל השאר, ולכן "התצלום נכתב" מאומת כאן על
--    שורה שתיעלם. בדיקת האמת היחידה היא `0100_verify.sql` אחרי ההרצה
--    האמיתית, ושם היא בדיקה 9. אין archive.contract_milestones — אם ההרצה
--    האמיתית תרוץ ושורת ה-events לא תיכתב, השורה אבדה בלי העתק.
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
--   12. 🔴 אף job אחר ואף אבן דרך אחרת לא זזו — md5 לפני ואחרי.
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

  -- טביעות "מה שלא אמור לזוז". md5 על כל השורות **מלבד** השתיים שנגעו.
  v_jobs_before text;
  v_jobs_after  text;
  v_ms_before   text;
  v_ms_after    text;
  v_jobs_n_before int;
  v_jobs_n_after  int;
  v_ms_n_before   int;
  v_ms_n_after    int;

  -- מה שנקרא חזרה אחרי הכתיבה
  v_rb_dismissed boolean;
  v_rb_reason    text;
  v_rb_at        timestamptz;
  v_rb_by        uuid;
begin
  -- ── 0. הקובץ הזה הוא PRE-migration ────────────────────────────────────────
  if exists (select 1 from public.schema_ledger where version = '0100') then
    raise exception '0100 DRY RUN: 0100 כבר בפנקס — המיגרציה הוחלה. הרץ את 0100_verify.sql במקום.';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0099') then
    raise exception '0100 DRY RUN: 0099 אינה בפנקס. הפנקס הוא הרצף — המדידות כאן נגזרו ממסד אחר. הרץ אותה קודם.';
  end if;
  raise notice '✅ 1. גארדי הפנקס: 0099 קיימת, 0100 אינה.';

  -- ── 2. אבן הדרך המתה ──────────────────────────────────────────────────────
  select m.contract_id, m.job_id, m.status, m.amount, m.expected_date, m.name
    into v_contract, v_dead_job, v_status, v_amount, v_expected, v_name
  from public.contract_milestones m
  where m.id = c_dead;

  if v_contract is null then
    raise exception '0100 DRY RUN: אבן הדרך % לא נמצאה.', c_dead;
  end if;
  if v_status <> 'pending' then
    raise exception '0100 DRY RUN: status = "%" ולא pending.', v_status;
  end if;
  if v_amount <> c_amount then
    raise exception '0100 DRY RUN: סכום % ולא %.', v_amount, c_amount;
  end if;
  if v_expected is distinct from c_expected then
    raise exception '0100 DRY RUN: expected_date % ולא %.', v_expected, c_expected;
  end if;
  raise notice '✅ 2. אבן הדרך המתה: "%" · ₪% · % · status=% · חוזה %',
    v_name, v_amount, v_expected, v_status, v_contract;

  -- ── 3. job_id ─────────────────────────────────────────────────────────────
  if v_dead_job is null then
    raise exception '0100 DRY RUN: job_id ריק — היא אינה מגיעה לענף הלא-מעוגן כלל.';
  end if;
  raise notice '✅ 3. job מקושר: %', v_dead_job;

  -- ── 4. ה-job נקי ──────────────────────────────────────────────────────────
  select j.paid::text, j.invoice_biz, j.invoice_tax, j.dismissed
    into v_paid, v_biz, v_tax, v_dismissed
  from public.jobs j where j.id = v_dead_job;

  if v_paid is null then
    raise exception '0100 DRY RUN: ה-job % לא נמצא — מפתח זר שבור.', v_dead_job;
  end if;
  if coalesce(btrim(v_biz), '') <> '' then
    raise exception '0100 DRY RUN: invoice_biz = "%" — מסמך חיוב עומד על ה-job.', v_biz;
  end if;
  if coalesce(btrim(v_tax), '') <> '' then
    raise exception '0100 DRY RUN: invoice_tax = "%" — מסמך מס עומד על ה-job.', v_tax;
  end if;
  if v_paid = 'כן' then
    raise exception '0100 DRY RUN: paid = "כן" — כסף נכנס על ה-job.';
  end if;
  if v_dismissed then
    raise exception '0100 DRY RUN: ה-job כבר dismissed.';
  end if;
  raise notice '✅ 4. ה-job נקי: invoice_biz ריק · invoice_tax ריק · paid="%" · dismissed=false', v_paid;

  -- ── 5+6. המסמכים, בשתי הדלתות ─────────────────────────────────────────────
  select count(*) into v_live_docs
  from public.documents d
  where (d.job_id = v_dead_job or d.bundle_job_ids @> array[v_dead_job])
    and d.cancelled_at is null and d.archived_at is null;
  if v_live_docs <> 0 then
    raise exception '0100 DRY RUN: % מסמכים חיים על ה-job — אינו יתום.', v_live_docs;
  end if;

  select count(*) into v_cancelled_docs
  from public.documents d
  where (d.job_id = v_dead_job or d.bundle_job_ids @> array[v_dead_job])
    and d.cancelled_at is not null;
  if v_cancelled_docs < 1 then
    raise exception '0100 DRY RUN: אפס מסמכים מבוטלים — זה מקרה אחר (אבן דרך שהונפקה לתור ומעולם לא יצאה), ואסור לנקות אותו כאן.';
  end if;
  raise notice '✅ 5+6. מסמכים: 0 חיים · % מבוטלים (לפי job_id וגם bundle_job_ids)', v_cancelled_docs;

  -- ── 7. אבן הדרך החיה ──────────────────────────────────────────────────────
  select m.job_id into v_live_job
  from public.contract_milestones m
  where m.id = c_live and m.contract_id = v_contract;
  if not found then
    raise exception '0100 DRY RUN: אבן הדרך החיה % אינה תחת החוזה % — המחיקה הייתה איבוד התחייבות ולא ניקוי כפילות.', c_live, v_contract;
  end if;
  if v_live_job is null then
    raise exception '0100 DRY RUN: לאבן הדרך החיה אין job.';
  end if;
  if v_live_job = v_dead_job then
    raise exception '0100 DRY RUN: שתי אבני הדרך על אותו job % — אמור להיות בלתי אפשרי (0086).', v_dead_job;
  end if;

  select count(*) into v_live_ms_docs
  from public.documents d
  where (d.job_id = v_live_job or d.bundle_job_ids @> array[v_live_job])
    and d.cancelled_at is null and d.archived_at is null;
  if v_live_ms_docs < 1 then
    raise exception '0100 DRY RUN: לאבן הדרך החיה אין מסמך חי — אין הצדקה למחוק את הישנה.';
  end if;
  raise notice '✅ 7. אבן הדרך החיה: job % · % מסמכים חיים', v_live_job, v_live_ms_docs;

  -- ── 8. מפתחות זרים — תנאי הבעלים ──────────────────────────────────────────
  select count(*) into v_hard_fks
  from pg_constraint con
  join pg_class    rel on rel.oid = con.confrelid
  join pg_namespace ns on ns.oid = rel.relnamespace
  where con.contype = 'f' and ns.nspname = 'public' and rel.relname = 'contract_milestones';
  if v_hard_fks > 0 then
    raise exception '0100 DRY RUN: % מפתחות זרים מצביעים על contract_milestones. הכרעת הבעלים: הפניה קשיחה = לא מוחקים.', v_hard_fks;
  end if;
  raise notice '✅ 8. אפס מפתחות זרים אל contract_milestones.';

  -- ── 9. ההפניות הרכות — מדווחות, לא חוסמות ────────────────────────────────
  select count(*) into v_event_refs
  from public.events e where e.payload->>'milestone_id' = c_dead::text;
  raise notice '✅ 9. % שורות events נושאות payload.milestone_id של אבן הדרך — יתומות אחרי המחיקה, ובמכוון אינן נמחקות (יומן ביקורת).', v_event_refs;

  -- ── התצלום ────────────────────────────────────────────────────────────────
  select to_jsonb(m) into v_snapshot from public.contract_milestones m where m.id = c_dead;
  select to_jsonb(j) into v_job_snap from public.jobs j where j.id = v_dead_job;
  raise notice '📸 התצלום שיישמר ב-events: %', v_snapshot;

  -- ── טביעות "לפני" ─────────────────────────────────────────────────────────
  -- ⚠️ כאן ולא בראש הקובץ, ובמכוון: הטביעה חייבת להחריג את **ה-job** הנגוע
  --    (`v_dead_job`), והוא נודע רק אחרי שאבן הדרך נקראה בשלב 2. טביעה
  --    שהוחרג בה מזהה אבן הדרך במקום מזהה ה-job הייתה כוללת את השורה שעומדת
  --    להשתנות, והבדיקה בשלב 12 הייתה נכשלת תמיד — על שינוי שהיא עצמה ביקשה.
  -- ⚠️ `order by id` אינו קישוט: md5 של string_agg בלי סדר קבוע אינו יציב
  --    בין שתי קריאות, והבדיקה הייתה נכשלת או עוברת באקראי.
  select count(*), md5(coalesce(string_agg(t.row_text, '|' order by t.id), ''))
    into v_jobs_n_before, v_jobs_before
  from (select j.id, j::text as row_text from public.jobs j where j.id <> v_dead_job) t;

  select count(*), md5(coalesce(string_agg(t.row_text, '|' order by t.id), ''))
    into v_ms_n_before, v_ms_before
  from (select m.id, m::text as row_text from public.contract_milestones m where m.id <> c_dead) t;

  -- ── 10. הכתיבה הראשונה ────────────────────────────────────────────────────
  c_reason := 'אבן דרך יתומה: מסמכיה בוטלו והונפקו מחדש על אבן הדרך '
           || c_live::text
           || ' באותו חוזה, בעקבות שינוי ח.פ של הלקוח. נוקה במיגרציה 0100, 7.10.2026.';

  update public.jobs
     set dismissed = true, dismiss_reason = c_reason, dismissed_at = now(), dismissed_by = null
   where id = v_dead_job and dismissed = false;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '0100 DRY RUN: עדכון ה-job נגע ב-% שורות ולא 1.', v_n;
  end if;

  -- נקרא חזרה מהטבלה ולא מונח מספירת השורות (הלקח של 0083).
  select j.dismissed, j.dismiss_reason, j.dismissed_at, j.dismissed_by
    into v_rb_dismissed, v_rb_reason, v_rb_at, v_rb_by
  from public.jobs j where j.id = v_dead_job;
  if not v_rb_dismissed then
    raise exception '0100 DRY RUN: dismissed לא נכתב.';
  end if;
  if v_rb_reason <> c_reason then
    raise exception '0100 DRY RUN: dismiss_reason נקרא חזרה אחרת ממה שנכתב: "%"', v_rb_reason;
  end if;
  if v_rb_at is null then
    raise exception '0100 DRY RUN: dismissed_at נשאר ריק.';
  end if;
  if v_rb_by is not null then
    raise exception '0100 DRY RUN: dismissed_by אינו null — מיגרציה אינה אדם (מוסכמת 0041/0095).';
  end if;
  raise notice '✅ 10. ה-job עודכן ונקרא חזרה: dismissed=true · dismissed_at=% · dismissed_by=null', v_rb_at;
  raise notice '   📝 הנימוק שנכתב: %', v_rb_reason;

  -- ── 11. המחיקה ────────────────────────────────────────────────────────────
  delete from public.contract_milestones where id = c_dead;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '0100 DRY RUN: המחיקה נגעה ב-% שורות ולא 1.', v_n;
  end if;
  if exists (select 1 from public.contract_milestones where id = c_dead) then
    raise exception '0100 DRY RUN: אבן הדרך עדיין שם אחרי DELETE.';
  end if;
  if not exists (select 1 from public.contract_milestones where id = c_live) then
    raise exception '0100 DRY RUN canary: אבן הדרך החיה % נעלמה.', c_live;
  end if;
  raise notice '✅ 11. אבן הדרך נמחקה (שורה 1), והחיה % שרדה.', c_live;

  -- שורת ה-events — נכתבת כאן כדי להוכיח שהיא עוברת, ומתגלגלת יחד עם השאר.
  -- ⚠️ ראה האזהרה בכותרת: "התצלום נשמר" מאומת כאן על שורה שתיעלם.
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
    raise exception '0100 DRY RUN: שורת ה-events לא נכתבה.';
  end if;
  raise notice '✅ 11ב. שורת events נכתבה עם התצלום (ותתגלגל — ראה האזהרה בכותרת).';

  -- ── 12. 🔴 מה שלא אמור לזוז, לא זז ────────────────────────────────────────
  -- זו הטענה הנושאת: שתי שורות נגעו ואף שורה אחרת לא. ספירת שורות לבדה אינה
  -- מוכיחה זאת — היא עוברת גם אם שורה אחרת החליפה ערך.
  select count(*), md5(coalesce(string_agg(t.row_text, '|' order by t.id), ''))
    into v_jobs_n_after, v_jobs_after
  from (select j.id, j::text as row_text from public.jobs j where j.id <> v_dead_job) t;

  select count(*), md5(coalesce(string_agg(t.row_text, '|' order by t.id), ''))
    into v_ms_n_after, v_ms_after
  from (select m.id, m::text as row_text from public.contract_milestones m where m.id <> c_dead) t;

  if v_jobs_n_before <> v_jobs_n_after then
    raise exception '0100 DRY RUN: מספר שורות jobs השתנה (% → %).', v_jobs_n_before, v_jobs_n_after;
  end if;
  if v_jobs_before <> v_jobs_after then
    raise exception '0100 DRY RUN: טביעת jobs שאינם ה-job הנגוע השתנתה — נגענו ב-job שלא היה אמור לזוז.';
  end if;
  if v_ms_n_before - 1 <> v_ms_n_after then
    raise exception '0100 DRY RUN: מספר אבני הדרך ירד ב-% ולא ב-1.', v_ms_n_before - v_ms_n_after;
  end if;
  if v_ms_before <> v_ms_after then
    raise exception '0100 DRY RUN: טביעת אבני הדרך שאינן הנמחקת השתנתה — נגענו באבן דרך שלא הייתה אמורה לזוז.';
  end if;
  raise notice '✅ 12. אפס נזק צדדי: % שורות jobs ללא שינוי (md5 זהה) · אבני דרך % → % (ההפרש 1 בדיוק, md5 של השאר זהה).',
    v_jobs_n_after, v_ms_n_before, v_ms_n_after;

  -- ── הגלגול ────────────────────────────────────────────────────────────────
  raise exception E'✅ 0100 DRY RUN עבר — **הכול גולגל, אפס שינוי נשאר על המסד.**\nאבן דרך "%" (₪%) · job % · % מסמכים מבוטלים · % שורות events יתומות · המחליפה % עם % מסמכים חיים.\nאפשר להריץ את supabase/migrations/0100_orphan_milestone_ey_cleanup.sql.\n⚠️ השגיאה הזו היא הפלט הצפוי.',
    v_name, c_amount, v_dead_job, v_cancelled_docs, v_event_refs, c_live, v_live_ms_docs;
end $dry$;
