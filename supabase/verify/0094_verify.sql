-- ============================================================================
-- 0094 — שאילתת אימות. להריץ אחרי המיגרציה.
-- כלל 50: אימות חי כאן, לעולם לא ב-supabase/migrations/.
--
--   ── חלק א' (קריאה בלבד) ──────────────────────────────────────────────────
--   "האם הטבלה נוצרה, נזרעה נכון, ו**שום דבר אחר לא זז**?"
--   SELECT אחד שמחזיר שורת בוליאנים. כל אחד חייב להיות true.
--   ⚠️ `Success. No rows returned` אינו הוכחה — רק השורה שחוזרת.
--
--   ── חלק ב' (חי, ומגלגל את עצמו) ──────────────────────────────────────────
--   "והאם הטריגרים והאילוצים באמת עובדים?"
--   חלק א' מראה שהמבנה קיים. הוא אינו מראה שהוא **מתנהג**. חלק ב' מפעיל את
--   טריגר הסנכרון על לקוח מדומה דרך כל ארבעת המעברים — מיפוי, החלפה, ביטול,
--   מיפוי חוזר — מנסה לשבור את שני האילוצים, ואז נופל ב-raise exception.
--   ⚠️ להריץ כבלוק נפרד, ולצפות ל"שגיאה" שמתחילה ב-✅.
--
-- 🔴 **הטענה המרכזית של 0094 היא שהוא אינרטי**, ולכן בדיקות 12-15 בחלק א׳
--    אינן קישוט: אם אחת מהן תיפול, הקובץ שינה התנהגות ולא רק מבנה.
--
-- ⚠️ כלל 51 חל כאן: `is null` תמיד כתנאי נפרד; וכל בדיקה מנוסחת "ציפיתי
--    ל-N, קבל N". הבדיקה היחידה שמנוסחת "ודא שאין כלום" — `anon_has_no_grant`
--    — נושאת לצידה שער בקרה חיובי (`authenticated_has_4`), שמוכיח שהשאילתה
--    על `role_table_grants` בכלל מוצאת שורות.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- חלק א' — קריאה בלבד. 18 בדיקות, כולן חייבות להחזיר true.
-- ════════════════════════════════════════════════════════════════════════════
select
  -- 1. שורת הפנקס — התנאי היחיד שמעיד שהקובץ באמת רץ
  (select count(*) = 1 from public.schema_ledger where version = '0094')                as ledger_row,

  -- 2. אירוע האודיט
  (select count(*) = 1 from public.events
    where event_type = 'client_morning_ids_created' and payload->>'migration' = '0094')  as audit_event,

  -- ---- המבנה ----------------------------------------------------------------
  -- 3. הטבלה קיימת
  (select to_regclass('public.client_morning_ids') is not null)                          as table_exists,

  -- 4. ה-PK הוא הזוג ולא המזהה לבדו — שיתוף מזהה בין לקוחות חייב להישאר אפשרי
  (select pg_get_constraintdef(oid) = 'PRIMARY KEY (client_id, morning_client_id)'
     from pg_constraint
    where conrelid = 'public.client_morning_ids'::regclass and contype = 'p')            as pk_is_the_pair,

  -- 5. האינדקס החלקי שאוכף ראשי יחיד.
  --    ⚠️ שלושה `like` נפרדים ולא מחרוזת אחת: Postgres מרנדר את תנאי ה-WHERE
  --    בעצמו, ועל עמודה בוליאנית הוא עשוי לכתוב `WHERE is_primary` או
  --    `WHERE (is_primary)`. בדיקה שתלויה בסוגריים הייתה נשברת על שינוי
  --    ניסוח של המסד ולא על שינוי אמיתי.
  (select count(*) = 1 from pg_indexes
    where schemaname = 'public' and indexname = 'client_morning_ids_one_primary'
      and indexdef like '%UNIQUE%' and indexdef like '%WHERE%'
      and indexdef like '%is_primary%')                                                  as one_primary_index,

  -- 6. שני הטריגרים
  (select count(*) = 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'clients' and t.tgname = 'trg_sync_primary_morning_id'
      and not t.tgisinternal)                                                            as sync_trigger,
  (select count(*) = 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'client_morning_ids' and t.tgname = 'trg_client_morning_ids_not_merged'
      and not t.tgisinternal)                                                            as merged_guard_trigger,

  -- 7. ⚠️ ההבחנה INSERT/UPDATE נעשית ב-TG_OP ולא ב-`old is null`. זו הבדיקה
  --    שמונעת חזרה לבאג שמבחן 5 בהרצה המדומה תפס — ראה כלל 51.
  (select p.prosrc like '%tg_op%' and p.prosrc not like '%old is not null%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sync_primary_morning_id')                as uses_tg_op,

  -- ---- הזריעה ---------------------------------------------------------------
  -- 8. 63 שורות בפילוח הנכון
  (select count(*) = 63 from public.client_morning_ids)                                  as sixty_three_rows,
  (select count(*) = 60 from public.client_morning_ids where is_primary)                 as sixty_primaries,
  (select count(*) = 3  from public.client_morning_ids where not is_primary)             as three_aliases,

  -- 9. כל ראשי תואם את העמודה שממנה נגזר — תו בתו
  (select count(*) = 60 from public.clients c
     join public.client_morning_ids m on m.client_id = c.id and m.is_primary
    where c.morning_client_id = m.morning_client_id and c.merged_into is null)           as primaries_match_column,

  -- 10. 🔴 שלושת האליאסים, כל אחד עם הראיה ב-note
  (select count(*) = 3 from public.client_morning_ids
    where not is_primary and note like 'F10 ·%' and morning_name is not null
      and (client_id, morning_client_id) in (
        ('b42808ad-4e91-4951-bcff-23111644a88b', '90b369a5-b071-4a83-8c32-880671625eaf'),
        ('b42808ad-4e91-4951-bcff-23111644a88b', '3236ef61-db85-491e-a407-e81b493e79ea'),
        ('261c0445-c013-4f87-9dc6-e82f8c7e9c30', 'fcf1e261-214c-4195-a372-4380e7bb9b5f')))
                                                                                          as three_aliases_seeded,

  -- 11. סבטלנה: 3 מזהים, אחד ראשי — המפה רבים-לאחד בפעולה
  (select count(*) = 3 from public.client_morning_ids
    where client_id = 'b42808ad-4e91-4951-bcff-23111644a88b')                            as svetlana_three_ids,
  (select count(*) = 1 from public.client_morning_ids
    where client_id = 'b42808ad-4e91-4951-bcff-23111644a88b' and is_primary)             as svetlana_one_primary,

  -- ---- 🔴 האינרטיות: הטענה המרכזית של הקובץ ---------------------------------
  -- 12. אפס מסמך קיבל client_id. הקוראים עדיין על העמודה.
  (select count(*) = 25 from public.documents
    where client_id is null and archived_at is null and cancelled_at is null)            as unmatched_still_25,

  -- 13. שלושת המסמכים שהמפה **תפתור** עדיין חסרי לקוח — הם יזוזו רק
  --     אחרי סבב הקוד, ולא אחרי המיגרציה הזו.
  (select count(*) = 3 from public.documents
    where client_id is null and archived_at is null and cancelled_at is null
      and morning_client_id in ('90b369a5-b071-4a83-8c32-880671625eaf',
                                '3236ef61-db85-491e-a407-e81b493e79ea',
                                'fcf1e261-214c-4195-a372-4380e7bb9b5f'))                 as three_docs_still_waiting,

  -- 14. הזנב של T21 לא זז
  (select count(*) = 104 from (
     select distinct d.id from public.documents d
     join public.invoices i
       on i.morning_doc_id in ('biz-'||d.morning_doc_number||'.0','tax-'||d.morning_doc_number||'.0')
     where d.type in (300,305,320) and d.job_id is null
       and d.archived_at is null and d.cancelled_at is null
       and (d.bundle_job_ids is null or cardinality(d.bundle_job_ids) = 0)) x)           as tail_still_104,

  -- 15. ⚠️ 2b73787f עדיין משותף לשני לקוחות — ה-PK לא חסם שיתוף לגיטימי (F16)
  (select count(*) = 2 from public.client_morning_ids
    where morning_client_id = '2b73787f-b09e-48dc-810e-3aacb0b5a394')                    as shared_id_survived,

  -- ---- כלל 49: ה-ACL נמדד, לא מונח ------------------------------------------
  -- 16. ⚠️ ל-anon אין גרנט. 0 הוא התשובה כאן, ולכן 17 הוא שער הבקרה שלו:
  --     אם שניהם יחזירו "אין" — השאילתה שבורה, לא המסד נקי. ראה T20.
  (select count(*) = 0 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'client_morning_ids' and grantee = 'anon')
                                                                                          as anon_has_no_grant,
  -- 17. שער הבקרה: ל-authenticated יש בדיוק ארבע, במראָה ל-clients
  (select count(*) = 4 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'client_morning_ids' and grantee = 'authenticated'
      and privilege_type in ('SELECT','INSERT','UPDATE','DELETE'))                       as authenticated_has_4,

  -- 18. RLS דולקת עם ארבע policies
  (select relrowsecurity from pg_class where oid = 'public.client_morning_ids'::regclass) as rls_on,
  (select count(*) = 4 from pg_policies
    where schemaname = 'public' and tablename = 'client_morning_ids')                    as four_policies;


-- ════════════════════════════════════════════════════════════════════════════
-- חלק ב' — חי. מפעיל את הטריגרים ומנסה לשבור את האילוצים, ומגלגל את עצמו.
-- להריץ בנפרד. הצלחה = "שגיאה" שמתחילה ב-✅.
-- ════════════════════════════════════════════════════════════════════════════
do $live$
declare
  v_tmp     uuid;
  v_merged  uuid;
  v_note    text;
  v_note2   text;
  v_blocked boolean;
  v_n int;
  v_fail text := '';
  v_rep  text := '';
begin
  -- ── מבחן 1: מיפוי לקוח חדש מגיע לטבלה בלי שאיש נגע בה ────────────────────
  insert into public.clients (name, normalized_name, morning_client_id)
  values ('ZZ-0094-verify', 'zz-0094-verify', 'zz-v-1') returning id into v_tmp;
  if (select count(*) from public.client_morning_ids
       where client_id = v_tmp and morning_client_id = 'zz-v-1' and is_primary) <> 1 then
    v_fail := v_fail || 'מבחן 1: הטריגר לא סנכרן INSERT. ';
  else
    v_rep := v_rep || 'מבחן 1 — INSERT סונכרן כ-is_primary. | ';
  end if;

  -- ── מבחן 2: 🔴 החלפת מזהה — הישן **נשאר כאליאס**, לא נמחק ────────────────
  update public.clients set morning_client_id = 'zz-v-2' where id = v_tmp;
  select note into v_note from public.client_morning_ids
   where client_id = v_tmp and morning_client_id = 'zz-v-1';
  if (select count(*) from public.client_morning_ids where client_id = v_tmp) <> 2 then
    v_fail := v_fail || 'מבחן 2: הישן נמחק במקום להישאר כאליאס — יתומים חדשים. ';
  elsif (select count(*) from public.client_morning_ids
          where client_id = v_tmp and morning_client_id = 'zz-v-1' and not is_primary) <> 1
     or (select count(*) from public.client_morning_ids
          where client_id = v_tmp and morning_client_id = 'zz-v-2' and is_primary) <> 1 then
    v_fail := v_fail || 'מבחן 2: ההורדה/העלאה לא התבצעו כנדרש. ';
  elsif v_note not like '%ירד מראשי%zz-v-2%' then
    v_fail := v_fail || format('מבחן 2: ה-note אינו מתעד מתי ולמה. הוא: [%s]. ', v_note);
  else
    v_rep := v_rep || 'מבחן 2 — הישן נשאר כאליאס עם note מתוארך, החדש עלה לראשי. | ';
  end if;

  -- ── מבחן 3: 🔴 ביטול מיפוי — אליאסים נשארים, **אפס ראשי** ────────────────
  -- זה מה שמבטיח שההנפקה תסרב ללקוח שהמיפוי שלו בוטל במכוון.
  update public.clients set morning_client_id = null where id = v_tmp;
  if (select count(*) from public.client_morning_ids where client_id = v_tmp) <> 2 then
    v_fail := v_fail || 'מבחן 3: ביטול מיפוי לא השאיר את שתי השורות. ';
  elsif (select count(*) from public.client_morning_ids where client_id = v_tmp and is_primary) <> 0 then
    v_fail := v_fail || 'מבחן 3: נשאר ראשי אחרי ביטול — ההנפקה תחשוב שהלקוח ממופה. ';
  elsif (select note from public.client_morning_ids
          where client_id = v_tmp and morning_client_id = 'zz-v-2') not like '%המיפוי בוטל%' then
    v_fail := v_fail || 'מבחן 3: ה-note אינו מתעד שהמיפוי בוטל. ';
  else
    v_rep := v_rep || 'מבחן 3 — ביטול: 2 אליאסים, אפס ראשי (ההנפקה תסרב). | ';
  end if;

  -- ── מבחן 4: מיפוי חוזר מחזיר לראשי, ושמירה חוזרת שותקת ───────────────────
  update public.clients set morning_client_id = 'zz-v-2' where id = v_tmp;
  select note into v_note from public.client_morning_ids
   where client_id = v_tmp and morning_client_id = 'zz-v-2';
  update public.clients set morning_client_id = 'zz-v-2' where id = v_tmp;
  select note into v_note2 from public.client_morning_ids
   where client_id = v_tmp and morning_client_id = 'zz-v-2';
  if (select count(*) from public.client_morning_ids where client_id = v_tmp and is_primary) <> 1 then
    v_fail := v_fail || 'מבחן 4: מיפוי חוזר לא החזיר בדיוק ראשי אחד. ';
  elsif v_note is distinct from v_note2 then
    v_fail := v_fail || 'מבחן 4: שמירה חוזרת של אותו ערך שינתה את ה-note. ';
  else
    v_rep := v_rep || 'מבחן 4 — מיפוי חוזר החזיר לראשי; שמירה חוזרת שותקת. | ';
  end if;

  -- ── מבחן 5: ראשי שני נחסם ────────────────────────────────────────────────
  v_blocked := false;
  begin
    insert into public.client_morning_ids (client_id, morning_client_id, is_primary)
    values (v_tmp, 'zz-v-3', true);
  exception when unique_violation then v_blocked := true;
  end;
  if not v_blocked then
    v_fail := v_fail || 'מבחן 5: ראשי שני עבר! ההנפקה לא תדע לאן להוציא. ';
  else
    v_rep := v_rep || 'מבחן 5 — ראשי שני נחסם ע"י client_morning_ids_one_primary. | ';
  end if;

  -- ── מבחן 6: ⚠️ אליאס על שורה מוזגת נחסם ──────────────────────────────────
  -- זה מה שהזיז 14 מסמכים בעבר כששורת [מוזג] זכתה במיון לפי שם.
  select id into v_merged from public.clients where merged_into is not null limit 1;
  if v_merged is null then
    v_fail := v_fail || 'מבחן 6: לא נמצאה שורה מוזגת לבדיקה. ';
  else
    v_blocked := false;
    begin
      insert into public.client_morning_ids (client_id, morning_client_id, is_primary)
      values (v_merged, 'zz-v-merged', false);
    exception when check_violation then v_blocked := true;
    end;
    if not v_blocked then
      v_fail := v_fail || 'מבחן 6: אליאס על שורה מוזגת עבר! שורה שהוצאה משימוש חזרה להיות יעד. ';
    else
      v_rep := v_rep || 'מבחן 6 — אליאס על שורה מוזגת נחסם. | ';
    end if;
  end if;

  -- ── מבחן 7: מחיקת לקוח גוררת את שורותיו (on delete cascade) ──────────────
  delete from public.clients where id = v_tmp;
  select count(*) into v_n from public.client_morning_ids where client_id = v_tmp;
  if v_n <> 0 then
    v_fail := v_fail || format('מבחן 7: נותרו %s שורות יתומות אחרי מחיקת הלקוח. ', v_n);
  else
    v_rep := v_rep || 'מבחן 7 — מחיקת לקוח גררה את שורותיו (cascade). | ';
  end if;

  -- ── הדוח ─────────────────────────────────────────────────────────────────
  if v_fail <> '' then
    raise exception '❌ 0094 VERIFY FAILED — %', v_fail;
  end if;

  raise exception '✅ 0094 VERIFY OK — % הכל מגולגל, אפס שינוי על המסד.', v_rep;
end $live$;
