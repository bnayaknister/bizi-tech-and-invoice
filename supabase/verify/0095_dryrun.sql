-- ============================================================================
-- 0095 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- מה המיגרציה עושה: מאחדת איותים של אותו חדר לשם קנוני — 3 שורות ב-`shows`,
-- 15 ב-`productions`. 🔴 בלתי הפיך: הערך הקודם אינו נשמר בשום מקום.
--
-- ═══ הקובץ הזה מבצע את כל השינויים ואז מגלגל אותם ═══
-- הוא מריץ בדיוק את אותם UPDATE-ים, בודק 12 מבחנים על המצב שנוצר, ומסיים
-- ב-`raise exception` — כך שאפס שורות נשארות משונות. **גם הצלחה היא
-- exception.** אם אתם רואים ✅ — הכול נבדק והכול גולגל.
--
-- ⚠️ שורת השגיאה האדומה בסוף היא הפלט הצפוי, לא תקלה.
--
-- ═══ מה שהמבחנים כאן שומרים עליו, ולמה דווקא הם ═══
-- מבחן 6 הוא הלב: "גבעון" ו"גבעון גדול" הם שני חדרים אמיתיים, ואיחוד שלהם
-- בטעות הוא הנזק היחיד כאן שאי אפשר לתקן. מבחנים 7-11 הם הצד השני של אותו
-- מטבע — הם מוכיחים שמה ש**לא** אמור לזוז באמת לא זז: חמשת השמות שאינם
-- אולפני העסק, TLV, ו-NULL.
-- ============================================================================

do $dry$
declare
  c_addr_he constant text := 'החשמונאים 105, תל אביב-יפו, 6713320, ישראל';
  c_addr_en constant text := 'HaHashmonaim St 105, Tel Aviv-Yafo, 6713320, Israel';

  v_fail text := '';
  v_rep  text := '';

  -- לפני
  b_shows_katan   int;
  b_prod_gadol    int;
  b_prod_null     int;
  b_shows_null    int;
  b_tlv           int;
  b_outside       int;
  -- אחרי
  n_shows_katan   int;
  n_prod_katan    int;
  n_prod_bot      int;
  n_prod_bahutz   int;
  n_prod_addr_he  int;
  n_prod_addr_en  int;
  n_prod_total    int;
  a_prod_gadol    int;
  a_prod_gavon    int;
  a_hash          int;
  a_prod_null     int;
  a_shows_null    int;
  a_tlv           int;
  a_outside       int;
  a_leftovers     int;
begin
  -- ══ צילום מצב לפני ════════════════════════════════════════════════════════
  select count(*) into b_shows_katan from public.shows       where default_studio = 'גבעון קטן';
  select count(*) into b_prod_gadol  from public.productions where studio = 'גבעון גדול';
  select count(*) into b_prod_null   from public.productions where studio is null;
  select count(*) into b_shows_null  from public.shows       where default_studio is null;
  select count(*) into b_tlv         from public.productions where studio = 'TLV';
  select count(*) into b_outside     from public.productions
    where studio in ('ריברסייד', 'שניט', 'חריש', 'הקלטת חוץ', 'מיאמי?!');

  v_rep := v_rep || format('לפני — shows גבעון קטן=%s · גבעון גדול=%s · TLV=%s · חיצוניים=%s · NULL(prod)=%s | ',
                           b_shows_katan, b_prod_gadol, b_tlv, b_outside, b_prod_null);

  -- ══ השינויים, זהים לקובץ המיגרציה ═════════════════════════════════════════
  update public.shows set default_studio = 'גבעון' where default_studio = 'גבעון קטן';
  get diagnostics n_shows_katan = row_count;

  update public.productions set studio = 'גבעון' where studio = 'גבעון קטן';
  get diagnostics n_prod_katan = row_count;
  update public.productions set studio = 'גבעון' where studio = 'גבעון בוט׳';
  get diagnostics n_prod_bot = row_count;
  update public.productions set studio = 'גבעון גדול' where studio = 'גבעון בחוץ';
  get diagnostics n_prod_bahutz = row_count;
  update public.productions set studio = 'חשמונאים' where studio = c_addr_he;
  get diagnostics n_prod_addr_he = row_count;
  update public.productions set studio = 'חשמונאים' where studio = c_addr_en;
  get diagnostics n_prod_addr_en = row_count;

  n_prod_total := n_prod_katan + n_prod_bot + n_prod_bahutz + n_prod_addr_he + n_prod_addr_en;

  -- ══ המבחנים ═══════════════════════════════════════════════════════════════

  -- 1 — shows: גבעון קטן → גבעון, 3 שורות
  if n_shows_katan <> 3 then
    v_fail := v_fail || format('מבחן 1: shows גבעון קטן — צפוי 3, בפועל %s. ', n_shows_katan);
  else
    v_rep := v_rep || 'מבחן 1 — shows: 3 שורות גבעון קטן→גבעון. | ';
  end if;

  -- 2 — productions: גבעון קטן, 8 שורות
  if n_prod_katan <> 8 then
    v_fail := v_fail || format('מבחן 2: גבעון קטן — צפוי 8, בפועל %s. ', n_prod_katan);
  else
    v_rep := v_rep || 'מבחן 2 — 8 שורות גבעון קטן→גבעון. | ';
  end if;

  -- 3 — productions: גבעון בוט׳ (גרש עברי U+05F3), שורה אחת
  if n_prod_bot <> 1 then
    v_fail := v_fail || format('מבחן 3: גבעון בוט׳ — צפוי 1, בפועל %s. ', n_prod_bot);
  else
    v_rep := v_rep || 'מבחן 3 — שורה אחת גבעון בוט׳→גבעון. | ';
  end if;

  -- 4 — ⚠️ גבעון בחוץ → גבעון גדול. הכרעת בעלים, הפוכה מהאינטואיציה.
  if n_prod_bahutz <> 1 then
    v_fail := v_fail || format('מבחן 4: גבעון בחוץ — צפוי 1, בפועל %s. ', n_prod_bahutz);
  else
    v_rep := v_rep || 'מבחן 4 — שורה אחת גבעון בחוץ→גבעון גדול (הכרעת בעלים). | ';
  end if;

  -- 5 — שתי הכתובות → חשמונאים, 3 + 2
  if n_prod_addr_he <> 3 or n_prod_addr_en <> 2 then
    v_fail := v_fail || format('מבחן 5: כתובות — צפוי 3+2, בפועל %s+%s. ', n_prod_addr_he, n_prod_addr_en);
  else
    v_rep := v_rep || 'מבחן 5 — 3 עברית + 2 אנגלית → חשמונאים. | ';
  end if;

  -- 6 — 🔴 המבחן שבגללו הקובץ הזה קיים.
  -- "גבעון גדול" חייב לעלות ב-1 בדיוק, ורק מ"גבעון בחוץ". כל מספר אחר
  -- פירושו שחדר שלם נבלע לתוך חדר אחר, ואין ממה לשחזר.
  select count(*) into a_prod_gadol from public.productions where studio = 'גבעון גדול';
  if a_prod_gadol <> b_prod_gadol + 1 then
    v_fail := v_fail || format('מבחן 6 🔴: גבעון גדול היה %s וצריך להיות %s, בפועל %s. ',
                               b_prod_gadol, b_prod_gadol + 1, a_prod_gadol);
  else
    v_rep := v_rep || format('מבחן 6 🔴 — גבעון גדול %s→%s, רק גבעון בחוץ נכנס. | ',
                             b_prod_gadol, a_prod_gadol);
  end if;

  -- 7 — אף איות ישן לא שרד באף אחת מהטבלאות
  select
    (select count(*) from public.shows
      where default_studio in ('גבעון קטן', 'גבעון בוט׳', 'גבעון בחוץ', c_addr_he, c_addr_en))
  + (select count(*) from public.productions
      where studio in ('גבעון קטן', 'גבעון בוט׳', 'גבעון בחוץ', c_addr_he, c_addr_en))
  into a_leftovers;
  if a_leftovers <> 0 then
    v_fail := v_fail || format('מבחן 7: נשארו %s איותים ישנים. ', a_leftovers);
  else
    v_rep := v_rep || 'מבחן 7 — אפס איותים ישנים בשתי הטבלאות. | ';
  end if;

  -- 8 — חמשת השמות שאינם אולפני העסק לא זזו
  select count(*) into a_outside from public.productions
    where studio in ('ריברסייד', 'שניט', 'חריש', 'הקלטת חוץ', 'מיאמי?!');
  if a_outside <> b_outside then
    v_fail := v_fail || format('מבחן 8: חיצוניים היו %s ועכשיו %s. ', b_outside, a_outside);
  else
    v_rep := v_rep || format('מבחן 8 — 5 השמות החיצוניים: %s, לא זזו. | ', a_outside);
  end if;

  -- 9 — TLV לא זז (הכרעת בעלים: נשאר כפי שהוא)
  select count(*) into a_tlv from public.productions where studio = 'TLV';
  if a_tlv <> b_tlv then
    v_fail := v_fail || format('מבחן 9: TLV היה %s ועכשיו %s. ', b_tlv, a_tlv);
  else
    v_rep := v_rep || format('מבחן 9 — TLV: %s, לא זז. | ', a_tlv);
  end if;

  -- 10 — NULL לא זז בשתי הטבלאות
  select count(*) into a_prod_null  from public.productions where studio is null;
  select count(*) into a_shows_null from public.shows       where default_studio is null;
  if a_prod_null <> b_prod_null or a_shows_null <> b_shows_null then
    v_fail := v_fail || format('מבחן 10: NULL זז — prod %s→%s, shows %s→%s. ',
                               b_prod_null, a_prod_null, b_shows_null, a_shows_null);
  else
    v_rep := v_rep || format('מבחן 10 — NULL: prod %s, shows %s, לא זזו. | ', a_prod_null, a_shows_null);
  end if;

  -- 11 — הסכומים: גבעון גדל ב-9, חשמונאים ב-5
  select count(*) into a_prod_gavon from public.productions where studio = 'גבעון';
  select count(*) into a_hash       from public.productions where studio = 'חשמונאים';
  if n_prod_katan + n_prod_bot <> 9 then
    v_fail := v_fail || format('מבחן 11: גבעון היה צריך לקבל 9, קיבל %s. ', n_prod_katan + n_prod_bot);
  else
    v_rep := v_rep || format('מבחן 11 — גבעון עכשיו %s, חשמונאים %s. | ', a_prod_gavon, a_hash);
  end if;

  -- 12 — הסך הכולל
  if n_prod_total <> 15 then
    v_fail := v_fail || format('מבחן 12: סה"כ productions — צפוי 15, בפועל %s. ', n_prod_total);
  else
    v_rep := v_rep || 'מבחן 12 — סה"כ 15 שורות ב-productions, 3 ב-shows. | ';
  end if;

  -- ══ הדוח ══════════════════════════════════════════════════════════════════
  if v_fail <> '' then
    raise exception '❌ 0095 DRY RUN FAILED — % || (הכול גולגל, אפס שינוי על המסד)', v_fail;
  end if;

  raise exception '✅ 0095 DRY RUN OK — % הכל מגולגל, אפס שינוי על המסד.', v_rep;
end $dry$;
