-- 0058_restore_handle_new_user_trigger.sql
-- שחזור הטריגר trg_handle_new_user על auth.users.
--
-- רקע: הפונקציה public.handle_new_user שורדת (יושבת בסכימת public שהועברה
-- כנתונים בהגירה מסינגפור→פרנקפורט), אבל הטריגר שחובר אליה על auth.users לא
-- שרד — סכימת auth מוקמת מחדש על-ידי הפלטפורמה בפרויקט חדש, וה-binding אבד.
-- אומת 17.8: pg_trigger על auth.users ריק; הפונקציה קיימת עם הגוף המקורי מ-0002.
-- התוצאה: משתמש חדש נוצר ב-auth בלי שורת profiles → נתקע על "החשבון ממתין לאישור".
-- אף משתמש קיים לא נפגע (6 auth = 6 profiles). זה תיקון מנע לפני ההזמנה הבאה.
--
-- הרצה: SQL Editor בלבד. אין supabase db push.

do $mig$
begin
  -- גארד פנקס: לא להריץ פעמיים
  if exists (select 1 from public.schema_ledger where version = '0058') then
    raise notice '0058 already applied — skipping';
    return;
  end if;

  -- גיבוי-ביטחון: ודא שהפונקציה קיימת לפני חיבור הטריגר
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'handle_new_user' and n.nspname = 'public'
  ) then
    raise exception '0058 aborted: public.handle_new_user does not exist — restore the function first';
  end if;

  -- צור את הטריגר רק אם אינו קיים (idempotent)
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'auth.users'::regclass
      and tgname = 'trg_handle_new_user'
      and not tgisinternal
  ) then
    create trigger trg_handle_new_user
      after insert on auth.users
      for each row execute function public.handle_new_user();
    raise notice '0058: trigger trg_handle_new_user created on auth.users';
  else
    raise notice '0058: trigger already present — nothing to do';
  end if;

  -- רישום בפנקס
  insert into public.schema_ledger (version, note)
  values ('0058', 'restore trg_handle_new_user on auth.users (lost in singapore->frankfurt migration)');
end
$mig$;
