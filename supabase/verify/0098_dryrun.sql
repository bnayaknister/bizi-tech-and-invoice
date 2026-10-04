-- ============================================================================
-- 0098 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- ═══ הקובץ הזה מבצע את כל השינויים ואז מגלגל אותם ═══
-- הוא מוסיף את העמודה ואת ה-CHECK, מכניס וממש מעדכן **חוזה בדיקה אמיתי**,
-- מוכיח את **שבעת** הגבולות, מודד את ההרשאות, ומסיים ב-`raise exception` —
-- כך שאפס שינוי נשאר על המסד. **גם הצלחה היא exception.**
-- אם אתם רואים ✅ — הכול נבדק והכול גולגל.
--
-- ⚠️ שורת השגיאה האדומה בסוף היא הפלט הצפוי, לא תקלה.
--
-- ═══ מה נבדק ═══
--   1. null עובר.        ← "לא חובה" היא הכרעת הבעלים
--   2. 1 עובר.           ← הגבול התחתון הוא 1 ולא 2
--   3. 6 עובר.           ← המקרה הראשון: חבילת EY
--   4. 500 עובר.         ← הגבול העליון הוא גבול כולל
--   5. 0 נדחה.           ← מצב אחד, ייצוג אחד: "חוזה רגיל" הוא null
--   6. 501 נדחה.         ← הגבול הוא גבול, לא המלצה
--   7. מספר שלילי נדחה.  ← -6 אינו "מינוס שש פרקים"
--   8. הערך נכנס באמת ונקרא חזרה ← CHECK שעובר על שורה שלא נכנסה אינו
--                                   מוכיח דבר (הלקח של 0097 מבחן 6)
--   9. ההרשאות — מי קורא את העמודה, בשני הכיוונים.
--
-- ⚠️ הבדיקות רצות גם ב-INSERT וגם ב-UPDATE. CHECK חל על שניהם, אבל המסלול
--    שהאפליקציה תשתמש בו הוא UPDATE על חוזה קיים ("קבע 6 פרקים לחוזה הזה"),
--    וקובץ שבדק רק INSERT היה מאשר את הצד שלא ישמש.
--
-- ⚠️ חוזה הבדיקה נכנס עם `show_id = null` במכוון: `contracts_one_active_per_show`
--    (0056) הוא אינדקס ייחודי חלקי, וחוזה בדיקה שהיה מצביע על תוכנית עם חוזה
--    פעיל היה נדחה מסיבה שאין לה שום קשר לעמודה שהקובץ בא לבדוק.
--
-- ⚠️ `status = 'closed'` על חוזה הבדיקה, גם הוא במכוון: גם אם משהו יקרא את
--    הטבלה בתוך הטרנזקציה הזו, חוזה סגור אינו נכנס לשום מסלול חיוב.
-- ============================================================================

do $dry$
declare
  v_fail text := '';
  v_rep  text := '';
  v_client uuid;
  v_id     uuid;
  v_read   integer;
  v_tbl_sel boolean;
begin
  -- ── 0. הקובץ הזה הוא PRE-migration ────────────────────────────────────────
  if exists (select 1 from public.schema_ledger where version = '0098') then
    raise exception '0098 DRY RUN: 0098 כבר בפנקס — המיגרציה הוחלה. הקובץ הזה נועד להרצה לפניה, והוא היה בודק את העמודה הקיימת ולא את ההגדרה. הרץ את 0098_verify.sql במקום.';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'contracts'
               and column_name = 'included_episodes') then
    raise exception '0098 DRY RUN: העמודה included_episodes כבר קיימת — אל תריץ את הקובץ הזה. בדוק מי הוסיף אותה.';
  end if;

  -- לקוח כלשהו, רק כדי שאפשר יהיה להכניס חוזה: client_id הוא NOT NULL.
  -- `merged_into is null` — לקוח שהתמזג הוא שורה פרושה (0050/0051), ואף
  -- שהכול מגולגל, חוזה בדיקה שמצביע עליה קורא רע בלוג אם משהו ייפול באמצע.
  select id into v_client from public.clients
    where merged_into is null order by created_at limit 1;
  if v_client is null then
    raise exception '0098 DRY RUN: אין אף לקוח בטבלה — אי אפשר להכניס חוזה בדיקה. הקובץ אינו יוצר לקוח, במכוון.';
  end if;

  -- ── 1. העמודה וה-CHECK, בדיוק כפי שהמיגרציה מגדירה אותם ───────────────────
  alter table public.contracts add column included_episodes integer null;
  alter table public.contracts
    add constraint contracts_included_episodes_chk
    check (included_episodes is null or included_episodes between 1 and 500);

  -- ── 2. null עובר, ב-INSERT ────────────────────────────────────────────────
  begin
    insert into public.contracts (client_id, name, total_amount, status, included_episodes)
    values (v_client, '0098 DRY — חוזה בדיקה', 1, 'closed', null)
    returning id into v_id;
    v_rep := v_rep || '· null עבר ';
  exception when others then
    raise exception '0098 DRY RUN: חוזה עם included_episodes = null נדחה (%) — זו הכרעת הבעלים "לא חובה" והקובץ אינו יכול להמשיך בלעדיה', sqlerrm;
  end;

  -- ── 3. 1 / 6 / 500 עוברים ב-UPDATE, וה-6 נקרא חזרה ───────────────────────
  begin
    update public.contracts set included_episodes = 1 where id = v_id;
    v_rep := v_rep || '· 1 עבר ';
  exception when others then
    v_fail := v_fail || 'מבחן 2: 1 נדחה (' || sqlerrm || ') — הגבול התחתון גבוה מ-1; ';
  end;

  begin
    update public.contracts set included_episodes = 6 where id = v_id;
    select included_episodes into v_read from public.contracts where id = v_id;
    if v_read = 6 then
      v_rep := v_rep || '· 6 עבר ונקרא חזרה ';
    else
      v_fail := v_fail || 'מבחן 3: נכתב 6 ונקרא ' || coalesce(v_read::text, 'null') || '; ';
    end if;
  exception when others then
    v_fail := v_fail || 'מבחן 3: 6 נדחה (' || sqlerrm || ') — זהו המקרה הראשון, חבילת EY; ';
  end;

  begin
    update public.contracts set included_episodes = 500 where id = v_id;
    v_rep := v_rep || '· 500 עבר ';
  exception when others then
    v_fail := v_fail || 'מבחן 4: 500 נדחה (' || sqlerrm || ') — הגבול העליון אמור להיות כולל; ';
  end;

  -- ── 4. 0 נדחה ─────────────────────────────────────────────────────────────
  -- מצב אחד, ייצוג אחד: "חוזה רגיל לפי אבני דרך" הוא null ולא 0.
  begin
    update public.contracts set included_episodes = 0 where id = v_id;
    v_fail := v_fail || 'מבחן 5: 0 עבר — שני ייצוגים למצב "חוזה רגיל", וכל קורא עתידי יצטרך לבדוק את שניהם לנצח; ';
  exception when check_violation then
    v_rep := v_rep || '· 0 נדחה ';
  when others then
    v_fail := v_fail || 'מבחן 5: 0 נדחה בשגיאה שאינה check_violation (' || sqlerrm || ') — האילוץ אינו זה שתפס; ';
  end;

  -- ── 5. 501 נדחה ───────────────────────────────────────────────────────────
  begin
    update public.contracts set included_episodes = 501 where id = v_id;
    v_fail := v_fail || 'מבחן 6: 501 עבר — הגבול העליון אינו נאכף; ';
  exception when check_violation then
    v_rep := v_rep || '· 501 נדחה ';
  when others then
    v_fail := v_fail || 'מבחן 6: 501 נדחה בשגיאה שאינה check_violation (' || sqlerrm || '); ';
  end;

  -- ── 6. מספר שלילי נדחה ────────────────────────────────────────────────────
  begin
    update public.contracts set included_episodes = -6 where id = v_id;
    v_fail := v_fail || 'מבחן 7: -6 עבר — אין דבר כזה מינוס פרקים; ';
  exception when check_violation then
    v_rep := v_rep || '· שלילי נדחה ';
  when others then
    v_fail := v_fail || 'מבחן 7: -6 נדחה בשגיאה שאינה check_violation (' || sqlerrm || '); ';
  end;

  -- הערך שרד את שלוש הדחיות ונשאר 500 — דחייה אינה אמורה לשנות את העמודה.
  select included_episodes into v_read from public.contracts where id = v_id;
  if v_read is distinct from 500 then
    v_fail := v_fail || 'מבחן 8: אחרי שלוש דחיות הערך הוא ' || coalesce(v_read::text, 'null') || ' ולא 500 — דחייה שינתה את העמודה; ';
  else
    v_rep := v_rep || '· דחייה לא שינתה את הערך ';
  end if;

  -- גם INSERT נדחה, לא רק UPDATE: ה-CHECK חל על שני המסלולים, ואפליקציה
  -- עתידית שתיצור חוזה עם מכסה ישר ב-INSERT חייבת להיתקל באותו קיר.
  begin
    insert into public.contracts (client_id, name, total_amount, status, included_episodes)
    values (v_client, '0098 DRY — אפס', 1, 'closed', 0);
    v_fail := v_fail || 'מבחן 9: INSERT עם 0 עבר — ה-CHECK חל על UPDATE בלבד?; ';
  exception when check_violation then
    v_rep := v_rep || '· INSERT עם 0 נדחה ';
  when others then
    v_fail := v_fail || 'מבחן 9: INSERT עם 0 נדחה בשגיאה שאינה check_violation (' || sqlerrm || '); ';
  end;

  -- ── 7. ההרשאות — מי קורא את העמודה ────────────────────────────────────────
  -- 🔴 זה הממצא שהמיגרציה נשענת עליו, ונמדד כאן ולא מונח: אין בשום מיגרציה
  --    grant או revoke שנוקב ב-contracts, ולכן ל-authenticated אמור להיות
  --    SELECT **ברמת הטבלה** — ואז עמודה חדשה נולדת קריאה בלי שום גרנט.
  --    `has_table_privilege` אינו מתחשב בהרשאות עמודתיות, ולכן זו בדיוק
  --    השאלה. אם ההנחה שגויה, הענף השני במיגרציה הוא שיתפוס אותה — והשורה
  --    הזו היא שתגיד לכם מראש מה יקרה.
  v_tbl_sel := has_table_privilege('authenticated', 'public.contracts', 'select');
  if v_tbl_sel then
    v_rep := v_rep || '· ל-authenticated SELECT ברמת הטבלה (גרנט עמודתי לא יידרש) ';
  else
    v_rep := v_rep || '· ⚠️ אין SELECT ברמת הטבלה — המיגרציה תנפיק גרנט עמודתי ';
  end if;

  if not has_column_privilege('authenticated', 'public.contracts', 'included_episodes', 'select') then
    if v_tbl_sel then
      v_fail := v_fail || 'מבחן 10: יש SELECT ברמת הטבלה אבל העמודה החדשה אינה קריאה — ההנחה על ירושת ההרשאה שגויה, והמיגרציה חייבת להעניק גרנט עמודתי תמיד; ';
    else
      -- המצב שהמיגרציה מטפלת בו. מוכיחים שהגרנט שלה אכן פותר אותו.
      execute 'grant select (included_episodes) on public.contracts to authenticated';
      if has_column_privilege('authenticated', 'public.contracts', 'included_episodes', 'select') then
        v_rep := v_rep || '· הגרנט העמודתי תופס ';
      else
        v_fail := v_fail || 'מבחן 10: גם הגרנט העמודתי אינו הופך את העמודה לקריאה; ';
      end if;
    end if;
  else
    v_rep := v_rep || '· העמודה קריאה ל-authenticated ';
  end if;

  if has_column_privilege('anon', 'public.contracts', 'included_episodes', 'select') then
    v_fail := v_fail || 'מבחן 11: ל-anon יש SELECT על included_episodes — העמודה נולדה פתוחה; ';
  elsif has_table_privilege('anon', 'public.contracts', 'select') then
    v_fail := v_fail || 'מבחן 11: ל-anon יש SELECT ברמת הטבלה על contracts — השלילה של 0068:180 נשברה; ';
  else
    v_rep := v_rep || '· anon אינו רואה דבר ';
  end if;

  -- RLS הוא מה שמגן על הכסף כאן, ולא הרשאות עמודתיות. אם הוא כבוי, העמודה
  -- החדשה גלויה לכל סשן מחובר ללא קשר ל-can_view_money.
  if not exists (select 1 from pg_class where oid = 'public.contracts'::regclass and relrowsecurity) then
    v_fail := v_fail || 'מבחן 12: RLS כבוי על contracts — included_episodes לא תהיה מוגנת; ';
  elsif not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'contracts' and policyname = 'contracts_view') then
    v_fail := v_fail || 'מבחן 12: ה-policy contracts_view אינו קיים; ';
  else
    v_rep := v_rep || '· RLS דלוק ו-contracts_view במקומו ';
  end if;

  -- ── 8. הגארד הכספי — שהטביעה שהמיגרציה דורשת אכן מתקיימת ─────────────────
  -- נבדק כאן כדי שהמיגרציה לא תיפול על השומר הזה אחרי שכבר הוסיפה עמודה.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'guard_contract_money_columns'
      and pg_get_functiondef(p.oid) like '%total_amount%'
      and pg_get_functiondef(p.oid) like '%client_id%'
      and pg_get_functiondef(p.oid) like '%show_id%'
      and pg_get_functiondef(p.oid) not like '%included_episodes%'
  ) then
    v_fail := v_fail || 'מבחן 13: גוף guard_contract_money_columns אינו הגוף של 0056 — שומר הטביעה במיגרציה יעצור אותה. בדוק מה הפונקציה עושה לפני שתריץ; ';
  else
    v_rep := v_rep || '· הגארד הוא הגוף של 0056 ';
  end if;

  -- ══ הדוח ══════════════════════════════════════════════════════════════════
  if v_fail <> '' then
    raise exception E'❌ 0098 DRY RUN FAILED — %\n(הכול גולגל, אפס שינוי על המסד)', v_fail;
  end if;

  raise exception E'✅ 0098 DRY RUN OK — %\n\nהכל מגולגל, אפס שינוי על המסד. העמודה, ה-CHECK, חוזה הבדיקה והגרנט — כולם נעלמו עם הטרנזקציה.\nהשלב הבא: supabase/migrations/0098_contract_included_episodes.sql', v_rep;
end $dry$;
