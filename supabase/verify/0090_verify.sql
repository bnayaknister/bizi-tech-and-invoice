-- ============================================================================
-- 0090 — שאילתת אימות. להריץ אחרי המיגרציה.
-- כלל 50: אימות חי כאן, לעולם לא ב-supabase/migrations/.
--
-- הקובץ מחולק לשני חלקים, ובכוונה — הם עונים על שתי שאלות שונות:
--
--   ── חלק א' (קריאה בלבד) ──────────────────────────────────────────────────
--   "האם המיגרציה הוחלה, והאם המבנה נכון?"
--   שאילתת SELECT אחת שמחזירה שורה של בוליאנים. כל אחד מהם חייב להיות true.
--   ⚠️ `Success. No rows returned` אינו הוכחה — רק השורה שחוזרת.
--   זה מה שמריצים תמיד. הוא אינו נוגע בדבר.
--
--   ── חלק ב' (חי, ומגלגל את עצמו) ──────────────────────────────────────────
--   "והאם השער באמת יורה?"
--   חלק א' יכול להראות שהפונקציה הוחלפה, אבל לא שהיא מתנהגת. חלק ב' מניע
--   הפקה אמיתית דרך מעבר סטטוס, מוודא שנכתב job_skipped_not_client ושלא נוצר
--   job, ואז נופל ב-raise exception. הגלגול מובטח ע"י PostgreSQL ולכן שינוי
--   הסטטוס והאירוע שנכתב **אינם נשארים**.
--   ⚠️ להריץ אותו כבלוק נפרד, ולצפות ל"שגיאה" שמתחילה ב-✅.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- חלק א' — קריאה בלבד. שמונה בדיקות, כולן חייבות להחזיר true.
-- ════════════════════════════════════════════════════════════════════════════
select
  -- 1. שורת הפנקס — התנאי היחיד שמעיד שהקובץ באמת רץ
  (select count(*) = 1 from public.schema_ledger where version = '0090')             as ledger_row,

  -- 2. אירוע האודיט של המיגרציה נכתב
  (select count(*) = 1 from public.events
    where event_type = 'kind_gate_audited'
      and payload->>'migration' = '0090')                                            as audit_event,

  -- 3. שתי הפונקציות שמרו על SECURITY DEFINER
  (select count(*) = 2 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname in ('on_production_approved', 'ensure_job_for_production'))       as both_secdef,

  -- 4. ושתיהן שמרו על search_path=public
  (select count(*) = 2 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and array_to_string(p.proconfig, ',') like '%search_path=public%'
      and p.proname in ('on_production_approved', 'ensure_job_for_production'))       as both_search_path,

  -- 5. שתיהן אכן מכילות את השער החדש
  (select count(*) = 2 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosrc like '%job_skipped_not_client%'
      and p.proname in ('on_production_approved', 'ensure_job_for_production'))       as gate_present,

  -- 6. ⚠️ שני מסלולי הדחייה הישנים לא נמחקו בדרך — 0060 ו-0061 שלמים
  (select p.prosrc like '%job_skipped_not_recorded%'
          and p.prosrc like '%client_approved_already_billed%'
          and p.prosrc like '%client_approved_job_created%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'ensure_job_for_production')           as old_paths_intact,

  -- 7. הטריגר לא נוצר מחדש ולא אבד — עדיין AFTER UPDATE OF status
  (select pg_get_triggerdef(t.oid) like '%AFTER UPDATE OF status%'
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'productions' and t.tgname = 'trg_on_production_approved'
      and not t.tgisinternal)                                                        as trigger_intact,

  -- 8. 🔴 אף הפקה לא תוקנה. ההכרעה (P9, 18.9) היא לא לגעת ב-110, ולכן
  --    מספר ההפקות kind='internal' על תוכנית per_episode עם לקוח חייב להישאר
  --    בדיוק כפי שהיה לפני המיגרציה. אם המספר ירד — מישהו "תיקן" אותן.
  --    ⚠️ 110 הוא תצלום של 18.9. הבדיקה הזו נועדה לרוץ מיד אחרי המיגרציה;
  --    בהרצה מאוחרת יותר המספר עשוי לזוז מסיבות לגיטימיות (הפקה חדשה על
  --    תוכנית ב-billing_mode='none' שקיבלה לקוח, למשל), ואז יש לקרוא אותו
  --    כ"לא ירד" ולא כ"שווה בדיוק".
  (select count(*) = 110 from public.productions p
     join public.shows s on s.id = p.show_id
    where p.kind = 'internal' and s.billing_mode = 'per_episode'
      and coalesce(p.client_id, s.client_id) is not null
      and p.merged_into is null)                                                     as none_reclassified;


-- ════════════════════════════════════════════════════════════════════════════
-- חלק ב' — חי. מוכיח שהשער יורה בפועל, ומגלגל את עצמו.
-- להריץ בנפרד. הצלחה = "שגיאה" שמתחילה ב-✅.
-- ════════════════════════════════════════════════════════════════════════════
do $live$
declare
  v_prod        uuid;
  v_before_ev   int;
  v_after_ev    int;
  v_jobs_before int;
  v_jobs_after  int;
  v_payload     jsonb;
begin
  -- הפקה internal אמיתית על תוכנית מחויבת עם לקוח — הצורה שהתחקיר מצא
  select p.id into v_prod
  from public.productions p join public.shows s on s.id = p.show_id
  where p.kind = 'internal' and s.billing_mode = 'per_episode'
    and coalesce(p.client_id, s.client_id) is not null
    and p.cancelled_at is null and p.merged_into is null
    and p.status <> 'הוקלט'
  limit 1;

  if v_prod is null then
    raise exception '❌ 0090 VERIFY: לא נמצאה הפקה internal מתאימה לבדיקה.';
  end if;

  select count(*) into v_before_ev from public.events
   where event_type = 'job_skipped_not_client' and entity_id = v_prod;
  select count(*) into v_jobs_before from public.jobs;

  -- נקודת הכניסה הראשונה של 0060
  update public.productions set status = 'הוקלט' where id = v_prod;

  select count(*) into v_after_ev from public.events
   where event_type = 'job_skipped_not_client' and entity_id = v_prod;
  select count(*) into v_jobs_after from public.jobs;

  if v_after_ev <> v_before_ev + 1 then
    raise exception '❌ 0090 VERIFY: השער לא כתב אירוע (% → %) על הפקה %.',
      v_before_ev, v_after_ev, v_prod;
  end if;

  if v_jobs_after <> v_jobs_before then
    raise exception '❌ 0090 VERIFY: נוצר job על הפקה חסומה! % → %.',
      v_jobs_before, v_jobs_after;
  end if;

  select payload into v_payload from public.events
   where event_type = 'job_skipped_not_client' and entity_id = v_prod
   order by created_at desc limit 1;

  if v_payload->>'billing_mode' is null or v_payload->>'kind' is null then
    raise exception '❌ 0090 VERIFY: המטען חסר שדות — %', v_payload::text;
  end if;

  raise exception '✅ 0090 VERIFY OK — השער ירה על הפקה %, אפס jobs חדשים (%). מטען: %. הכל מגולגל.',
    v_prod, v_jobs_after, v_payload::text;
end $live$;
