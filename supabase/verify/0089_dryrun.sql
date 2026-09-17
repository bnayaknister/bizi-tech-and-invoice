-- ============================================================================
-- 0089 — הרצה מדומה. להריץ לפני קובץ המיגרציה.
--
-- מה זה עושה: יוצר את due_date_for בתוך טרנזקציה, משווה אותה מול הלוגיקה
-- הישנה של compute_due_date (0002) על כל שישה ערכי payment_terms כפול רשימת
-- תאריכים שנבחרה לשבור אותה, ואז מוודא שכל שורת jobs קיימת מקבלת בדיוק את
-- ה-due_date שהיא נושאת היום. מסתיים ב-raise exception — הגלגול מובטח ע"י
-- PostgreSQL, לא ע"י ה-API, ולכן שום דבר כאן אינו נשאר על המסד.
--
-- Management API אינו מחזיר NOTICE, ולכן כל הדוח רוכב על הודעת ה-exception.
-- הצלחה נראית כך:  ✅ 0089 DRY RUN OK — ...   (בתוך הודעת שגיאה)
-- כישלון נראית כך: ❌ ...
-- ============================================================================
do $dry$
declare
  v_terms   text[] := array['immediate','net_30','net_60','eom_30','eom_60','eom_90'];
  v_dates   date[] := array[
    -- סופי חודש, כי eom הוא "סוף החודש ואז +N"
    '2026-01-31','2026-04-30','2026-11-30','2026-12-31',
    -- פברואר, מעוברת ולא מעוברת
    '2026-02-01','2026-02-28','2024-02-29','2028-02-29',
    -- חציית שנה
    '2025-12-31','2026-12-01',
    -- תאריכים אמיתיים מהספרים
    '2026-07-01','2026-08-13','2026-09-09','2026-09-17'
  ]::date[];
  t         text;
  b         date;
  v_old     date;
  v_new     date;
  v_cases   int := 0;
  v_bad     int := 0;
  v_report  text := '';
  v_jobs_total int := 0;
  v_jobs_bad   int := 0;
  v_jobs_rep   text := '';
  v_stale      int := 0;
  v_stale_rep  text := '';
  v_msg     text;
  r         record;
begin
  -- ── הפונקציה החדשה, בדיוק כפי שהמיגרציה תיצור אותה ──────────────────────
  execute $f$
    create or replace function public.due_date_for(base date, terms public.payment_terms)
    returns date language sql immutable as $body$
      select case terms
        when 'net_30' then base + 30
        when 'net_60' then base + 60
        when 'eom_30' then (date_trunc('month', base) + interval '1 month - 1 day')::date + 30
        when 'eom_60' then (date_trunc('month', base) + interval '1 month - 1 day')::date + 60
        when 'eom_90' then (date_trunc('month', base) + interval '1 month - 1 day')::date + 90
        else base
      end
    $body$;
  $f$;

  -- ── מבחן 1: חדש מול ישן, כל ערך כפול כל תאריך ──────────────────────────
  foreach t in array v_terms loop
    foreach b in array v_dates loop
      -- הלוגיקה הישנה, מועתקת מילה במילה מ-compute_due_date ב-0002:258
      v_old := case t::public.payment_terms
        when 'net_30' then b + 30
        when 'net_60' then b + 60
        when 'eom_30' then (date_trunc('month', b) + interval '1 month - 1 day')::date + 30
        when 'eom_60' then (date_trunc('month', b) + interval '1 month - 1 day')::date + 60
        when 'eom_90' then (date_trunc('month', b) + interval '1 month - 1 day')::date + 90
        else b
      end;
      v_new := public.due_date_for(b, t::public.payment_terms);
      v_cases := v_cases + 1;
      if v_old is distinct from v_new then
        v_bad := v_bad + 1;
        v_report := v_report || format(E'\n    %s @ %s : ישן=%s חדש=%s', t, b, v_old, v_new);
      end if;
    end loop;
  end loop;

  -- ── מבחן 2: terms = NULL (לקוח שלא נמצא) חייב להחזיר את הבסיס ───────────
  -- לא STRICT, במכוון: STRICT היה מחזיר NULL וכותב due_date ריק על כל job
  -- שה-client_id שלו ריק. ה-else של 0002 מחזיר את הבסיס, וזו ההתנהגות שנשמרת.
  foreach b in array v_dates loop
    v_cases := v_cases + 1;
    if public.due_date_for(b, null) is distinct from b then
      v_bad := v_bad + 1;
      v_report := v_report || format(E'\n    NULL @ %s : חדש=%s (ציפייה %s)', b, public.due_date_for(b, null), b);
    end if;
  end loop;

  -- ── מבחן 3: בסיס NULL — הישן עושה coalesce(new.date, current_date) לפני
  --    ה-case, ולכן הפונקציה עצמה לעולם אינה מקבלת NULL. נבדק רק שאינה נופלת.
  v_cases := v_cases + 1;
  perform public.due_date_for(null, 'eom_60');

  -- ── מבחן 4: כל שורת jobs קיימת — ישן מול חדש על אותו בסיס בדיוק ────────
  --
  -- ⚠️ זה המבחן הנכון, והגרסה הראשונה שלו הייתה שגויה. היא השוותה את העמודה
  -- השמורה מול חישוב מחדש, ונכשלה על 4 שורות — ואף אחת מהן לא בגלל 0089:
  -- ל-3 מהן date ריק, כלומר הבסיס הוא current_date, וערך שנכתב ב-12.7 לעולם
  -- לא ישווה לחישוב של היום. השאלה שמיגרציה צריכה לענות עליה היא "האם
  -- הפונקציה מחזירה בדיוק מה שה-case הישן החזיר", ועליה בלבד.
  for r in
    select j.id, coalesce(j.date, current_date) as base, c.payment_terms as terms,
           case c.payment_terms
             when 'net_30' then coalesce(j.date, current_date) + 30
             when 'net_60' then coalesce(j.date, current_date) + 60
             when 'eom_30' then (date_trunc('month', coalesce(j.date, current_date)) + interval '1 month - 1 day')::date + 30
             when 'eom_60' then (date_trunc('month', coalesce(j.date, current_date)) + interval '1 month - 1 day')::date + 60
             when 'eom_90' then (date_trunc('month', coalesce(j.date, current_date)) + interval '1 month - 1 day')::date + 90
             else coalesce(j.date, current_date)
           end as old_val,
           public.due_date_for(coalesce(j.date, current_date), c.payment_terms) as new_val
      from public.jobs j
      left join public.clients c on c.id = j.client_id
  loop
    v_jobs_total := v_jobs_total + 1;
    if r.old_val is distinct from r.new_val then
      v_jobs_bad := v_jobs_bad + 1;
      if v_jobs_bad <= 12 then
        v_jobs_rep := v_jobs_rep || format(E'\n    job %s  base=%s terms=%s  ישן=%s חדש=%s',
                                           left(r.id::text, 8), r.base, r.terms, r.old_val, r.new_val);
      end if;
    end if;
  end loop;

  -- ── מבחן 5: מידע בלבד, אינו מפיל — עמודות due_date שהתיישנו ────────────
  -- הטריגר יורה על date ועל client_id בלבד. שינוי payment_terms אצל הלקוח
  -- אינו מרענן את ה-jobs שלו, ושורה עם date ריק קפאה על current_date של יום
  -- הכתיבה. שני הדברים קדמו ל-0089, ו-0089 אינה נוגעת באף אחד מהם.
  for r in
    select j.id, j.date, j.due_date as stored, c.payment_terms as terms,
           public.due_date_for(coalesce(j.date, current_date), c.payment_terms) as recomputed
      from public.jobs j
      left join public.clients c on c.id = j.client_id
     where j.due_date is distinct from public.due_date_for(coalesce(j.date, current_date), c.payment_terms)
  loop
    v_stale := v_stale + 1;
    v_stale_rep := v_stale_rep || format(E'\n    job %s  date=%s terms=%s  שמור=%s לפי-התנאים=%s%s',
                                         left(r.id::text, 8), coalesce(r.date::text, '(ריק)'), r.terms,
                                         r.stored, r.recomputed,
                                         case when r.date is null then '   [date ריק — קפא על current_date של יום הכתיבה]'
                                              else '   ⚠ תנאי התשלום השתנו אחרי כתיבת השורה' end);
  end loop;

  -- ── הדוח ────────────────────────────────────────────────────────────────
  -- נבנה ל-v_msg ואז נזרק בפלייסהולדר אחד: כל % בתוך טקסט שנבנה ב-format
  -- היה נקרא כפלייסהולדר נוסף ע"י raise ומפיל אותו על "too few parameters".
  if v_bad > 0 or v_jobs_bad > 0 then
    v_msg := format(
      E'❌ 0089 DRY RUN נכשלה\n  מקרים: %s · נכשלו: %s%s\n  שורות jobs: %s · נכשלו: %s%s',
      v_cases, v_bad, v_report, v_jobs_total, v_jobs_bad, v_jobs_rep);
    raise exception '%', v_msg;
  end if;

  v_msg := format(
    E'✅ 0089 DRY RUN OK — אפס הפרשים. גולגל, שום דבר לא נכתב.\n'
    '  %s מקרים (6 ערכי terms × 14 תאריכים, ועוד terms=NULL ובסיס ריק) — כולם זהים ללוגיקה של 0002\n'
    '  %s שורות jobs — הפונקציה מחזירה בדיוק מה שה-case הישן מחזיר, על אותו בסיס\n'
    '  אפשר להריץ את supabase/migrations/0089_due_date_for.sql\n'
    '\n  ℹ️ מידע בלבד, קדם ל-0089 ואינו נוגע בה — %s שורות נושאות due_date מיושן:%s',
    v_cases, v_jobs_total, v_stale, coalesce(nullif(v_stale_rep, ''), ' אין'));
  raise exception '%', v_msg;
end $dry$;
