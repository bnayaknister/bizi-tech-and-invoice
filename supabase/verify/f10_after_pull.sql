-- ============================================================================
-- F10 — הבדיקה שמריצים אחרי המשיכה הראשונה שרצה עם הקוד החדש.
-- קריאה בלבד. אינה שייכת למיגרציה אחת ולכן אינה נושאת מספר — כלל 50.
--
-- ⚠️ קו הבסיס נלקח **19.9, אחרי 0094 ולפני שהמשיכה הראשונה רצה**. אם המשיכה
--    כבר רצה כשאתה קורא את זה, השורות כבר זזו וזו הבדיקה שתאמר לך זאת.
--
-- מה אמור לקרות, ורק זה:
--   · שלושת המסמכים 10248, 10265, 10260 מקבלים client_id.
--     כולם `type = 100` (הזמנות עבודה) — ולכן הם יוצאים מ**תג** "לא משויך"
--     ואינם משנים את **הטבלה** שבלשונית, שמסננת ללא-חיוב.
--   · התג יורד מ-25 ל-22.
--   · שום מסמך אחר אינו משנה `client_id`.
--
-- 🔴 הבדיקה השלישית היא העיקר. קל לראות ששלושה זזו; מה שקשה לראות הוא
--    שמשהו רביעי זז בשקט. `fp_others` הוא md5 על (id, client_id) של **כל
--    1,110 המסמכים האחרים**, כפי שהיו רגע לפני. אם הוא זז — משהו שלא
--    התכוונו אליו קיבל לקוח, וצריך לעצור ולברר לפני המשיכה הבאה.
--
-- הרצה: להדביק ולקרוא את השורה שחוזרת. כל העמודות חייבות `true`.
-- ============================================================================
select
  -- 1. שלושת המסמכים קיבלו את הלקוח הנכון
  (select count(*) = 2 from public.documents
    where morning_doc_number in ('10248','10265')
      and client_id = 'b42808ad-4e91-4951-bcff-23111644a88b')            as tal_medical_two_to_svetlana,

  (select count(*) = 1 from public.documents
    where morning_doc_number = '10260'
      and client_id = '261c0445-c013-4f87-9dc6-e82f8c7e9c30')            as shachaf_one_to_defacto,

  -- 2. התג ירד מ-25 ל-22
  (select count(*) = 22 from public.documents
    where client_id is null and archived_at is null and cancelled_at is null)
                                                                          as unmatched_badge_22,

  -- 3. 🔴 ושום מסמך אחר לא זז. קו הבסיס: 850c2eff… על 1,110 מסמכים, 19.9.
  (select md5(coalesce(string_agg(d.id::text||'|'||coalesce(d.client_id::text,'-'), ',' order by d.id),''))
          = '850c2efffe2f8bf7d7fe1ab0e92b96ad'
     from public.documents d
    where d.morning_doc_number not in ('10248','10265','10260'))          as nothing_else_moved,

  (select count(*) = 1110 from public.documents
    where morning_doc_number not in ('10248','10265','10260'))            as still_1110_others,

  -- 4. ⚠️ והטבלה בלשונית לא זזה — שלושתם type=100 ולכן מחוץ למסנן החיוב.
  --    (הסכום נשאר יציב רק בזכות B19; לפני התיקון הוא היה קופץ.)
  (select count(*) = 4 from public.documents
    where client_id is null and archived_at is null and cancelled_at is null
      and type in (300,305,320,400))                                      as billing_rows_still_4,

  -- 5. והאוטו-לינק לא נגע בכלום: אפס אירוע קישור מאז קו הבסיס
  (select count(*) = 0 from public.events
    where event_type = 'document_reconciled'
      and created_at > timestamptz '2026-09-19 13:00:00+00'
      and coalesce(payload->>'auto', 'false') = 'true')                   as no_auto_links;


-- ── ואם משהו כן זז: מי, בדיוק ────────────────────────────────────────────
-- להריץ רק אם `nothing_else_moved` חזר false.
select d.morning_doc_number, d.type, d.amount, d.document_date,
       d.morning_client_name, d.morning_client_id, c.name as got_client, d.updated_at
from public.documents d
left join public.clients c on c.id = d.client_id
where d.morning_doc_number not in ('10248','10265','10260')
  and d.client_id is not null
  and d.updated_at > timestamptz '2026-09-19 13:00:00+00'
order by d.updated_at desc;
