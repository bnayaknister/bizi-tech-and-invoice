-- ============================================================================
-- 0095 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. תשע עמודות, **כולן חייבות להיות true**.
-- `Success. No rows returned` אינו הוכחה לכלום כאן — יש שורה אחת, וצריך
-- להסתכל עליה.
--
-- השורה השנייה בקובץ (מתחת) היא המצאי המלא אחרי הנרמול: כל ערך מובחן בשתי
-- הטבלאות, כדי שאפשר יהיה לראות בעיניים שנשארו בדיוק השמות שאמורים להישאר.
-- ============================================================================

with
c(addr_he, addr_en) as (values (
  'החשמונאים 105, תל אביב-יפו, 6713320, ישראל',
  'HaHashmonaim St 105, Tel Aviv-Yafo, 6713320, Israel'
)),
old_spellings as (
  select (select count(*) from public.shows, c
           where default_studio in ('גבעון קטן', 'גבעון בוט׳', 'גבעון בחוץ', c.addr_he, c.addr_en))
       + (select count(*) from public.productions, c
           where studio in ('גבעון קטן', 'גבעון בוט׳', 'גבעון בחוץ', c.addr_he, c.addr_en))
      as n
),
counts as (
  select
    (select count(*) from public.productions where studio = 'גבעון גדול')            as gadol,
    (select count(*) from public.productions where studio = 'TLV')                    as tlv,
    (select count(*) from public.productions
      where studio in ('ריברסייד', 'שניט', 'חריש', 'הקלטת חוץ', 'מיאמי?!'))          as outside,
    (select count(*) from public.productions where studio is null)                    as prod_null,
    (select count(*) from public.shows       where default_studio is null)            as shows_null,
    (select count(*) from public.events
      where event_type = 'studio_names_normalized'
        and payload->>'via' = '0095')                                                 as ledger
)
select
  -- 1. אפס איותים ישנים בשתי הטבלאות. זה המבחן המרכזי.
  (select n from old_spellings) = 0                                as no_old_spellings,

  -- 2. 🔴 גבעון גדול = 5 בדיוק: 4 שהיו + "גבעון בחוץ" האחד.
  --    מספר גדול יותר = חדר נבלע לתוך חדר. אין ממה לשחזר.
  (select gadol from counts) = 5                                   as gadol_is_5,

  -- 3. TLV לא זז — אולפן של העסק, בשימוש מועט, נשאר כפי שהוא.
  --    ⚠️ מלאו כאן את הספירה מהמצאי שלפני המיגרציה במקום 1, אם אינה 1.
  (select tlv from counts) >= 1                                    as tlv_still_there,

  -- 4. חמשת השמות שאינם אולפני העסק עדיין שם, כולם.
  (select outside from counts) = 5                                 as outside_names_intact,

  -- 5+6. NULL לא זז באף טבלה. (מחרוזת ריקה נספרת בשורת המצאי למטה.)
  (select prod_null  from counts) > 0                              as prod_nulls_exist,
  (select shows_null from counts) > 0                              as shows_nulls_exist,

  -- 7. הפנקס נכתב — בלעדיו אין שום תיעוד שהמיגרציה רצה.
  (select ledger from counts) = 1                                  as ledger_row_written,

  -- 8. שלושת החדרים הקנוניים קיימים ב-productions.
  (select count(distinct studio) from public.productions
    where studio in ('גבעון', 'גבעון גדול', 'חשמונאים')) = 3       as three_canonical_rooms,

  -- 9. אף תוכנית אינה מצביעה על איות שאינו קנוני או TLV.
  --    (NULL ומחרוזת ריקה מוחרגים — לא נגענו בהם בכוונה.)
  (select count(*) from public.shows
    where default_studio is not null
      and btrim(default_studio) <> ''
      and default_studio not in ('גבעון', 'גבעון גדול', 'חשמונאים', 'TLV')) = 0
                                                                   as shows_all_canonical;

-- ── המצאי המלא אחרי הנרמול — להסתכל, לא להשוות אוטומטית ────────────────────
-- שתי הטבלאות זו מתחת לזו. הצפוי: גבעון · גבעון גדול · חשמונאים · TLV,
-- ולצידם חמשת השמות החיצוניים ב-productions בלבד.
select 'shows.default_studio' as tbl,
       coalesce(nullif(btrim(default_studio), ''), '(NULL/ריק)') as value,
       count(*) as rows
from public.shows
group by 2
union all
select 'productions.studio',
       coalesce(nullif(btrim(studio), ''), '(NULL/ריק)'),
       count(*)
from public.productions
group by 2
order by 1, 3 desc;
