-- ============================================================================
-- 0121 — job נוצר בכל מעבר של הפקה למצב "בוצעה", לא רק ל-הוקלט (B38, 21.10)
--
-- ⚠️ להריץ את supabase/verify/0121_dryrun.sql לפני, ואת 0121_verify.sql אחרי.
--    כלל 50: קובצי האימות אינם יושבים בתיקיית המיגרציות.
--
-- למה (הכרעת בעלים 21.10, B38 הכרעה 3): ה-job נולד היום רק בשתי נקודות
-- כניסה — מעבר ל-'הוקלט' ומעבר ל-'אושר_ע"י_לקוח' (0060/0090). הפקה שהסטטוס
-- שלה קופץ מעל 'הוקלט' — קפיצה ידנית ("פעולות חריגות"), גרירה בלוח, או
-- derive_production_status כששלב העריכה מתחיל לפני שההקלטה סומנה — עוברת
-- ל-'בעריכה' / 'נשלח_ללקוח' בלי job, ונשארת בלעדיו עד אישור הלקוח. נמצא
-- ב-21.10 (B37): שתי הפקות "שומעת רגע?!" קפצו מ-'עתיד_להתחיל' ל-'נשלח_ללקוח'.
-- B38 מעביר את הזמנת העבודה לרגע ה-job, ולכן הרגע הזה חייב לקרות בכל מעבר
-- כזה.
--
-- מה משתנה: שער הכניסה של on_production_approved בלבד. נקודות הכניסה הישנות
-- נשמרות **כמו שהן** (המעבר ל-הוקלט ממשיך לקרוא ל-'recorded' גם כשהוא מגיע
-- ממצב שכבר "בוצע", כמו קודם), ונוספת אחת: כל מעבר ממצב שלא בוצע
-- ('עתיד_להתחיל', 'בהקלטה', 'בוטל') למצב שבוצע — 'recorded'. כלומר קבוצת
-- הקריאות היא על-קבוצה של הקודמת; אף קריאה קיימת לא הוסרה.
--
-- מה שומר מפני job כפול: ensure_job_for_production עצמה, שלא נגעת —
--   · הגארד של 0060 (`exists job_productions`) — אין job שני להפקה
--   · 'עתיד_להתחיל' / 'בהקלטה' — job_skipped_not_recorded (0061)
--   · cancelled_at / merged_into — יציאה שקטה, כמו היום
-- והשמות נקובים במפורש, לא בסדר ה-enum: 'בוטל' הוא הערך האחרון, וכל תנאי
-- מסוג ">= הוקלט" היה גורף הפקות מבוטלות (ההערה של 0060/0061).
--
-- הצפה: נבדק קודם המעבר ורק אחריו ה-kind (הסדר של 0090), כך שעדכון סטטוס
-- בין שני מצבים "שבוצעו" (בעריכה → נערך) אינו כותב דבר, גם על internal.
--
-- 🔴 אפס תיקון רטרואקטיבי: הפקות שכבר נמצאות במצב "בוצעה" בלי job אינן
--    מקבלות job מהמיגרציה (אין מעבר). הכרעת בעלים 21.10: הסטטוס של שתי
--    ההפקות של "שומעת רגע?!" מ-21.10 לא משתנה.
--
-- אפס שינוי סכימה · אפס DELETE · אפס UPDATE על נתונים · אפס שורה חדשה מלבד
-- האירוע ושורת הפנקס.
--
-- כלל 49 — השפעת ACL, מוצהרת: לא נוצר אף אובייקט נושא-ACL. הפונקציה קיימת,
-- נשארת SECURITY DEFINER עם search_path='public' ובעלות postgres;
-- CREATE OR REPLACE שומר על הגרנטים. trg_on_production_approved אינו נוצר
-- מחדש ואינו נגע.
-- ============================================================================

-- ── 0. guards ────────────────────────────────────────────────────────────────
do $pre$
begin
  if exists (select 1 from public.schema_ledger where version = '0121') then
    raise exception '0121 כבר רשומה בפנקס — אל תריץ שוב';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0120') then
    raise exception '0121: 0120 טרם הוחלה — הרץ אותה קודם';
  end if;
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'productions' and t.tgname = 'trg_on_production_approved' and not t.tgisinternal
  ) then
    raise exception '0121: trg_on_production_approved אינו קיים — עצור וברר';
  end if;
  if to_regprocedure('public.ensure_job_for_production(uuid,text)') is null then
    raise exception '0121: ensure_job_for_production(uuid,text) אינה קיימת — עצור וברר';
  end if;
end $pre$;

-- ── 1. on_production_approved ────────────────────────────────────────────────
create or replace function public.on_production_approved()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_billing_mode text;
  v_reason       text;
  -- "בוצעה" = כל מצב מלבד שלושת אלה. בשמם, לא לפי סדר ה-enum (ראה הכותרת).
  v_new_done     boolean := new.status not in ('עתיד_להתחיל', 'בהקלטה', 'בוטל');
  v_old_done     boolean := old.status is not null and old.status not in ('עתיד_להתחיל', 'בהקלטה', 'בוטל');
begin
  -- שער ראשון: האם זו נקודת כניסה? (המעבר קודם, ה-kind אחר כך — 0090)
  if new.status = 'אושר_ע"י_לקוח' and old.status is distinct from 'אושר_ע"י_לקוח' then
    v_reason := 'client_approved';                       -- 0033/0060, כמו קודם
  elsif (new.status = 'הוקלט' and old.status is distinct from 'הוקלט')   -- 0060, כמו קודם
     or (v_new_done and not v_old_done) then             -- 0121: כל מעבר אל "בוצעה"
    v_reason := 'recorded';
  else
    return new;
  end if;

  -- שער שני: ה-kind. מדבר, לא שותק (0090).
  if new.kind <> 'client' then
    select s.billing_mode::text into v_billing_mode
    from public.shows s where s.id = new.show_id;

    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('production', new.id, 'job_skipped_not_client', auth.uid(),
            jsonb_build_object('production_id', new.id,
                               'client_id',     new.client_id,
                               'kind',          new.kind::text,
                               'billing_mode',  v_billing_mode,
                               'status',        new.status,
                               'fired_by',      'trigger'));
    return new;
  end if;

  perform public.ensure_job_for_production(new.id, v_reason);
  return new;
end;
$function$;

comment on function public.on_production_approved() is
  'יוצר job להפקת client: במעבר לאישור לקוח (client_approved), במעבר ל-הוקלט, ו-0121: בכל מעבר ממצב שלא בוצע (עתיד_להתחיל/בהקלטה/בוטל) למצב שבוצע (recorded) — קפיצה ידנית, גרירה, או שלב עריכה לפני סימון ההקלטה. job כפול נמנע ב-ensure_job_for_production (0060). kind<>client כותב job_skipped_not_client (0090). המעבר נבדק לפני ה-kind כדי לא להציף.';

-- ── 2. שער: הפונקציה נשארה כפי שצריך ─────────────────────────────────────────
do $guard$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'on_production_approved'
      and p.prosecdef
      and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=public%'
      and p.prosrc like '%v_new_done%'
  ) then
    raise exception '0121 עצרה: on_production_approved איבדה SECURITY DEFINER / search_path, או שהגוף החדש לא נכנס.';
  end if;
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'productions' and t.tgname = 'trg_on_production_approved' and not t.tgisinternal
  ) then
    raise exception '0121 עצרה: trg_on_production_approved אינו קיים.';
  end if;
end $guard$;

-- ── 3. שובל האודיט ───────────────────────────────────────────────────────────
-- actor_id נשאר null במכוון: מיגרציה עשתה זאת, לא אדם.
insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
values ('schema', '00000000-0000-0000-0000-000000000000', 'job_entry_widened', null,
        jsonb_build_object(
          'migration', '0121',
          'function', 'public.on_production_approved()',
          'new_entry', 'any transition from עתיד_להתחיל/בהקלטה/בוטל to a performed status -> recorded',
          'kept_entries', jsonb_build_array('הוקלט -> recorded', 'אושר_ע"י_לקוח -> client_approved'),
          'productions_touched', 0,
          'jobs_touched', 0,
          'source', 'B38 owner decision 3, 2026-10-21'));

insert into public.schema_ledger (version, applied_at, applied_by, note)
values ('0121', now(), 'bnaya',
        'B38 (הכרעת בעלים 3, 21.10): job נוצר בכל מעבר של הפקת client ממצב שלא בוצע (עתיד_להתחיל/בהקלטה/בוטל) למצב שבוצע — קפיצה ידנית, גרירה בלוח, שלב עריכה לפני סימון ההקלטה, אישור לקוח — ולא רק במעבר ל-הוקלט. נקודות הכניסה הקודמות נשמרו כמו שהן (הוקלט → recorded, אושר → client_approved), כך שקבוצת הקריאות היא על-קבוצה של הקודמת. ensure_job_for_production לא נגעה: גארד הכפילות של 0060, השער של 0061 (עתיד_להתחיל/בהקלטה) ויציאת cancelled_at/merged_into ממשיכים לשמור. המעבר נבדק לפני ה-kind (הסדר של 0090) כדי שעדכון בין שני מצבים שבוצעו לא יכתוב אירוע. אפס תיקון רטרואקטיבי — הפקות שכבר בוצעו בלי job (למשל שתי ההפקות של "שומעת רגע?!" מ-21.10) אינן נגעות. כלל 49: לא נוצר אובייקט נושא-ACL. אפס שינוי סכימה, אפס DELETE, אפס UPDATE על נתונים. הרצה מדומה: supabase/verify/0121_dryrun.sql; אימות: supabase/verify/0121_verify.sql.');
