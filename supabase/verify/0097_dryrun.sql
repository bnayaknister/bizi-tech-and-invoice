-- ============================================================================
-- 0097 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- ═══ הקובץ הזה מבצע את כל השינויים ואז מגלגל אותם ═══
-- הוא מוסיף את העמודה ואת ה-CHECK, מכניס שורות בדיקה אמיתיות, מוכיח את
-- **ארבעת** הגבולות, ומסיים ב-`raise exception` — כך שאפס שינוי נשאר על
-- המסד. **גם הצלחה היא exception.** אם אתם רואים ✅ — הכול נבדק והכול גולגל.
--
-- ⚠️ שורת השגיאה האדומה בסוף היא הפלט הצפוי, לא תקלה.
--
-- ═══ מה נבדק ═══
--   1. 120 תווים **עבריים** עוברים.  ← זה המבחן שמפריד char_length
--      מ-octet_length: 120 תווים עבריים הם 240 בתים. גבול בבתים היה נכשל
--      כאן, ובאמת היה חותך שם עברי באמצע. המבחן נכתב בעברית במכוון.
--   2. 121 תווים נדחים.              ← הגבול הוא גבול, לא המלצה
--   3. null עובר.                    ← "רשות" היא הכרעת הבעלים
--   4. מחרוזת ריקה נדחית.            ← מצב אחד, ייצוג אחד. האפליקציה
--                                       מתרגמת '' ל-null לפני ההכנסה
--   5. תו אחד עובר.                  ← הגבול התחתון הוא 1 ולא 2
--   6. השורה נכנסת באמת ונקראת חזרה  ← CHECK שעובר על שורה שלא נכנסה
--                                       אינו מוכיח דבר
--
-- כל שורות הבדיקה נכנסות תחת `link` שנוצר כאן ו-`revoked_at = now()` מראש:
-- ⚠️ בלי זה האינדקס הייחודי החלקי `booking_links_one_active_per_show` היה
-- דוחה את ההכנסה אם לתוכנית שנבחרה כבר יש קישור פעיל — והקובץ היה נופל
-- מסיבה שאין לה שום קשר לעמודה שהוא בא לבדוק.
-- ============================================================================

do $dry$
declare
  v_fail text := '';
  v_rep  text := '';
  v_show uuid;
  v_link uuid;
  v_id   uuid;
  v_read text;
  v_120  text := repeat('א', 120);
  v_121  text := repeat('א', 121);
  v_t0 timestamptz := '2026-10-05 09:00:00+03';
  v_t1 timestamptz := '2026-10-05 10:30:00+03';
begin
  -- ── 0. הקובץ הזה הוא PRE-migration ────────────────────────────────────────
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'booking_requests') then
    raise exception '0097 DRY RUN: הטבלה booking_requests אינה קיימת — 0096 טרם הוחלה. הרץ אותה קודם.';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'booking_requests' and column_name = 'guest') then
    raise exception '0097 DRY RUN: העמודה guest כבר קיימת — המיגרציה כנראה הוחלה. הקובץ הזה נועד להרצה לפניה, והוא לא היה בודק את ההגדרה אלא רק את הקיים. הרץ את 0097_verify.sql במקום.';
  end if;

  select id into v_show from public.shows order by name limit 1;
  if v_show is null then
    raise exception '0097 DRY RUN: אין אף שורה ב-shows — אין FK לתלות בו את הבדיקה.';
  end if;

  -- ── 1. העמודה וה-CHECK, בדיוק כפי שהמיגרציה כותבת אותם ────────────────────
  alter table public.booking_requests add column guest text null;
  alter table public.booking_requests
    add constraint booking_requests_guest_len_chk
    check (guest is null or char_length(guest) between 1 and 120);
  v_rep := v_rep || '· העמודה וה-CHECK נוצרו ';

  -- קישור בדיקה, שנשלל מראש כדי לא להתנגש באינדקס הייחודי החלקי
  insert into public.booking_links (show_id, token, revoked_at)
  values (v_show, 'dryrun-0097-token-0000000000000000000000', now())
  returning id into v_link;

  -- ── 2. null עובר ──────────────────────────────────────────────────────────
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, guest)
    values (v_show, v_link, 'גבעון', v_t0, v_t1, null);
    v_rep := v_rep || '· null עבר ';
  exception when others then
    v_fail := v_fail || 'מבחן 2: null נדחה (' || sqlerrm || ') — "רשות" נשבר; ';
  end;

  -- ── 3. 120 תווים עבריים עוברים, ונקראים חזרה שלמים ────────────────────────
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, guest)
    values (v_show, v_link, 'גבעון', v_t0, v_t1, v_120)
    returning id into v_id;
    -- ⚠️ קריאה חזרה, לא רק הכנסה: אילוץ שעבר על שורה שנכתבה חלקית אינו מוכיח
    -- דבר. כאן נמדד שהמסד שמר 120 תווים ו-240 בתים — זה ההבדל בין
    -- char_length ל-octet_length, בשורה אחת.
    select guest into v_read from public.booking_requests where id = v_id;
    if char_length(v_read) <> 120 then
      v_fail := v_fail || 'מבחן 3: נשמרו ' || char_length(v_read) || ' תווים במקום 120; ';
    elsif octet_length(v_read) <> 240 then
      v_fail := v_fail || 'מבחן 3: 120 תווים עבריים אמורים להיות 240 בתים, נמדדו ' || octet_length(v_read) || ' — הקידוד אינו UTF-8; ';
    else
      v_rep := v_rep || '· 120 תווים עבריים (240 בתים) עברו ונקראו שלמים ';
    end if;
  exception when check_violation then
    v_fail := v_fail || 'מבחן 3: 120 תווים נדחו — הגבול נכתב בבתים ולא בתווים, והוא חותך שם עברי ב-60 תווים; ';
  when others then
    v_fail := v_fail || 'מבחן 3: 120 תווים נדחו מסיבה אחרת (' || sqlerrm || '); ';
  end;

  -- ── 4. 121 תווים נדחים ────────────────────────────────────────────────────
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, guest)
    values (v_show, v_link, 'גבעון', v_t0, v_t1, v_121);
    v_fail := v_fail || 'מבחן 4: 121 תווים נכנסו — הגבול אינו גבול; ';
  exception
    when check_violation then v_rep := v_rep || '· 121 תווים נדחו ';
    when others then v_fail := v_fail || 'מבחן 4: 121 תווים נדחו ע"י משהו אחר ולא ע"י ה-CHECK (' || sqlerrm || ') — המבחן לא בדק את מה שהתיימר; ';
  end;

  -- ── 5. מחרוזת ריקה נדחית ──────────────────────────────────────────────────
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, guest)
    values (v_show, v_link, 'גבעון', v_t0, v_t1, '');
    v_fail := v_fail || 'מבחן 5: מחרוזת ריקה נכנסה — יש עכשיו שני ייצוגים ל"בלי אורח", ואפשר יהיה להסתמך רק על שניהם יחד; ';
  exception
    when check_violation then v_rep := v_rep || '· מחרוזת ריקה נדחתה ';
    when others then v_fail := v_fail || 'מבחן 5: מחרוזת ריקה נדחתה מסיבה אחרת (' || sqlerrm || '); ';
  end;

  -- ── 6. תו אחד עובר — הגבול התחתון הוא 1 ──────────────────────────────────
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, guest)
    values (v_show, v_link, 'חשמונאים', v_t0, v_t1, 'א');
    v_rep := v_rep || '· תו אחד עבר ';
  exception when others then
    v_fail := v_fail || 'מבחן 6: שם בן תו אחד נדחה (' || sqlerrm || ') — הגבול התחתון גבוה מ-1; ';
  end;

  -- ── 7. ההרשאה העמודתית, בדיוק כפי שהמיגרציה מעניקה אותה ──────────────────
  -- ⚠️ נבדק כאן ולא רק ב-verify: זה החלק שהכי קל לשכוח, כי הוא נראה כאילו
  -- הוא בא בירושה מ-0096 — ואינו.
  grant select (guest) on public.booking_requests to authenticated;
  if not has_column_privilege('authenticated', 'public.booking_requests', 'guest', 'select') then
    v_fail := v_fail || 'מבחן 7: הגרנט העמודתי ל-authenticated לא תפס; ';
  elsif has_column_privilege('anon', 'public.booking_requests', 'guest', 'select') then
    v_fail := v_fail || 'מבחן 7: ל-anon יש SELECT על guest — העמודה נולדה פתוחה; ';
  else
    v_rep := v_rep || '· authenticated קורא, anon לא ';
  end if;

  -- ══ הדוח ══════════════════════════════════════════════════════════════════
  if v_fail <> '' then
    raise exception E'❌ 0097 DRY RUN FAILED — %\n(הכול גולגל, אפס שינוי על המסד)', v_fail;
  end if;

  raise exception E'✅ 0097 DRY RUN OK — %\n\nהכל מגולגל, אפס שינוי על המסד. העמודה, ה-CHECK, שורות הבדיקה והגרנט — כולם נעלמו עם הטרנזקציה.\nהשלב הבא: supabase/migrations/0097_booking_request_guest.sql', v_rep;
end $dry$;
