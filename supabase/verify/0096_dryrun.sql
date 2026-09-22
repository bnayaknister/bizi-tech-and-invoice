-- ============================================================================
-- 0096 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- ═══ הקובץ הזה מבצע את כל השינויים ואז מגלגל אותם ═══
-- הוא יוצר את שתי הטבלאות, את האינדקסים ואת אילוץ ה-EXCLUDE, מכניס שורות
-- בדיקה, מוכיח **כל אחד** מה-CHECK-ים ואת שני הצדדים של ה-EXCLUDE, ומסיים
-- ב-`raise exception` — כך שאפס שינוי נשאר על המסד. **גם הצלחה היא
-- exception.** אם אתם רואים ✅ — הכול נבדק והכול גולגל.
--
-- ⚠️ שורת השגיאה האדומה בסוף היא הפלט הצפוי, לא תקלה.
--
-- ═══ 🎯 ובנוסף, הקובץ הזה עונה על השאלה הפתוחה ═══
-- `btree_gist` **אינה מותקנת** על המסד (נמדד 22.9 מהמיגרציות: `0001:5`
-- מתקינה `pgcrypto` ורק אותה). כאן היא נוצרת **בתוך הטרנזקציה שמתגלגלת**,
-- ולכן זו הדרך היחידה לגלות אם היא בכלל **זמינה** בפרויקט הזה — בלי להתקין
-- כלום בפועל. הדוח בסוף אומר מה נמצא:
--
--   ✅ btree_gist AVAILABLE      → אפשר לסמן install_btree_gist := true
--   ❌ btree_gist NOT AVAILABLE  → ההחלטה נסגרת מעצמה: accept_app_only,
--                                  והבטחת אי-החפיפה נשארת באפליקציה.
--
-- מבחן 9 ו-10 הם הלב: **שתי בקשות ממתינות חופפות חייבות להיות מותרות**
-- (שני לקוחות ביקשו את אותה משבצת — מצב תקין שהבעלים מכריע בו), ו**שתי
-- מאושרות חופפות חייבות להידחות**. אילוץ שחוסם את הראשון היה שובר את
-- הפיצ׳ר; אילוץ שמתיר את השני היה מוכר את אותו חדר פעמיים.
-- ============================================================================

do $dry$
declare
  v_fail text := '';
  v_rep  text := '';
  v_gist_available boolean := false;
  v_gist_err text := null;
  v_show uuid;
  v_link uuid;
  v_n int;
  v_t0 timestamptz := '2026-10-05 09:00:00+03';
  v_t1 timestamptz := '2026-10-05 10:30:00+03';
  v_t2 timestamptz := '2026-10-05 10:00:00+03'; -- חופף ל-[t0,t1)
  v_t3 timestamptz := '2026-10-05 11:30:00+03';
begin
  -- ── 0. הקובץ הזה הוא PRE-migration. אם הטבלאות קיימות, הוא אינו בודק דבר ──
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name in ('booking_links','booking_requests')) then
    raise exception '0096 DRY RUN: הטבלאות כבר קיימות — המיגרציה כנראה הוחלה. הקובץ הזה נועד להרצה לפניה, והוא לא היה בודק את ההגדרה אלא רק את הקיים. הרץ את 0096_verify.sql במקום.';
  end if;

  select id into v_show from public.shows order by name limit 1;
  if v_show is null then
    raise exception '0096 DRY RUN: אין אף שורה ב-shows — אין FK לתלות בו את הבדיקה.';
  end if;

  -- ── 1. האם btree_gist זמינה בכלל? ─────────────────────────────────────────
  -- נוצרת כאן ומתגלגלת עם כל השאר. זה מודד זמינות בלי להתקין.
  begin
    create extension if not exists btree_gist;
    v_gist_available := true;
    v_rep := v_rep || '· btree_gist זמינה ונוצרה (ותתגלגל) ';
  exception when others then
    v_gist_available := false;
    v_gist_err := sqlerrm;
    v_rep := v_rep || '· btree_gist ❌ אינה זמינה: ' || coalesce(v_gist_err,'?') || ' ';
  end;

  -- ── 2. הטבלאות, בדיוק כמו במיגרציה ────────────────────────────────────────
  create table public.booking_links (
    id          uuid primary key default gen_random_uuid(),
    show_id     uuid not null references public.shows(id) on delete cascade,
    token       text not null unique,
    created_at  timestamptz not null default now(),
    created_by  uuid references public.profiles(id),
    revoked_at  timestamptz,
    revoked_by  uuid references public.profiles(id),
    constraint booking_links_token_len check (char_length(token) between 20 and 200)
  );
  create unique index booking_links_one_active_per_show
    on public.booking_links (show_id) where revoked_at is null;

  create table public.booking_requests (
    id          uuid primary key default gen_random_uuid(),
    show_id     uuid not null references public.shows(id) on delete cascade,
    link_id     uuid not null references public.booking_links(id) on delete restrict,
    studio      text not null,
    start_at    timestamptz not null,
    end_at      timestamptz not null,
    note        text,
    status      text not null default 'pending',
    created_at  timestamptz not null default now(),
    decided_at  timestamptz,
    decided_by  uuid references public.profiles(id),
    constraint booking_requests_status_chk check (status in ('pending','approved','declined')),
    constraint booking_requests_studio_chk check (studio in ('גבעון','גבעון גדול','חשמונאים')),
    constraint booking_requests_range_chk  check (end_at > start_at),
    constraint booking_requests_note_len_chk check (note is null or char_length(note) <= 500),
    constraint booking_requests_decided_chk
      check ((status = 'pending' and decided_at is null) or (status <> 'pending' and decided_at is not null))
  );

  if v_gist_available then
    alter table public.booking_requests
      add constraint booking_requests_no_overlap_approved
      exclude using gist (studio with =, tstzrange(start_at, end_at) with &&)
      where (status = 'approved');
  end if;

  -- ── 3. שורות תקינות נכנסות ────────────────────────────────────────────────
  insert into public.booking_links (show_id, token)
  values (v_show, 'dryrun-token-0000000000000000000000000000')
  returning id into v_link;
  v_rep := v_rep || '· קישור נוצר ';

  insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, note)
  values (v_show, v_link, 'גבעון', v_t0, v_t1, 'הערה תקינה');
  select count(*) into v_n from public.booking_requests;
  if v_n <> 1 then v_fail := v_fail || 'מבחן 3: בקשה תקינה לא נכנסה; '; end if;

  -- ── 4. CHECK: status ──────────────────────────────────────────────────────
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, status, decided_at)
    values (v_show, v_link, 'גבעון', v_t2, v_t3, 'maybe', now());
    v_fail := v_fail || 'מבחן 4: status=''maybe'' לא נדחה; ';
  exception when check_violation then v_rep := v_rep || '· status נדחה ';
  end;

  -- ── 5. CHECK: studio — כולל TLV, שהוא הלב ─────────────────────────────────
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at)
    values (v_show, v_link, 'TLV', v_t2, v_t3);
    v_fail := v_fail || 'מבחן 5: TLV לא נדחה — חדר שאינו פתוח להזמנה נכנס; ';
  exception when check_violation then v_rep := v_rep || '· TLV נדחה ';
  end;
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at)
    values (v_show, v_link, 'גבעון קטן', v_t2, v_t3);
    v_fail := v_fail || 'מבחן 5b: ''גבעון קטן'' (וריאנט, לא קנוני) לא נדחה; ';
  exception when check_violation then v_rep := v_rep || '· וריאנט לא-קנוני נדחה ';
  end;
  -- ושלושת הקנוניים כן נכנסים
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at)
    values (v_show, v_link, 'גבעון גדול', v_t0, v_t1),
           (v_show, v_link, 'חשמונאים',   v_t0, v_t1);
    v_rep := v_rep || '· שלושת הקנוניים נכנסים ';
  exception when others then
    v_fail := v_fail || 'מבחן 5c: חדר קנוני נדחה בטעות (' || sqlerrm || '); ';
  end;

  -- ── 6. CHECK: end_at > start_at ───────────────────────────────────────────
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at)
    values (v_show, v_link, 'גבעון', v_t1, v_t0);
    v_fail := v_fail || 'מבחן 6: end_at < start_at לא נדחה; ';
  exception when check_violation then v_rep := v_rep || '· טווח הפוך נדחה ';
  end;
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at)
    values (v_show, v_link, 'גבעון', v_t0, v_t0);
    v_fail := v_fail || 'מבחן 6b: end_at = start_at (אורך אפס) לא נדחה; ';
  exception when check_violation then v_rep := v_rep || '· אורך אפס נדחה ';
  end;

  -- ── 7. CHECK: אורך הערה ───────────────────────────────────────────────────
  -- הגבול עצמו נבדק משני צדיו: 500 עובר, 501 נדחה. ">= 500" היה עובר גם אם
  -- הגבול היה 5000 (מלכודת 3 מההנדאוף — ספירה רופפת אינה בודקת דבר).
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, note)
    values (v_show, v_link, 'גבעון', v_t2, v_t3, repeat('א', 500));
    v_rep := v_rep || '· הערה של 500 עוברת ';
  exception when others then
    v_fail := v_fail || 'מבחן 7: הערה של בדיוק 500 תווים נדחתה (' || sqlerrm || '); ';
  end;
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, note)
    values (v_show, v_link, 'גבעון', v_t2, v_t3, repeat('א', 501));
    v_fail := v_fail || 'מבחן 7b: הערה של 501 תווים לא נדחתה; ';
  exception when check_violation then v_rep := v_rep || '· 501 נדחית ';
  end;
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, note)
    values (v_show, v_link, 'גבעון', v_t2, v_t3, null);
    v_rep := v_rep || '· הערה null מותרת ';
  exception when others then
    v_fail := v_fail || 'מבחן 7c: הערה null נדחתה, והיא אופציונלית (' || sqlerrm || '); ';
  end;

  -- ── 8. CHECK: החלטה וחותמת נוסעות יחד ─────────────────────────────────────
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, status)
    values (v_show, v_link, 'גבעון', v_t2, v_t3, 'approved');
    v_fail := v_fail || 'מבחן 8: approved בלי decided_at לא נדחה; ';
  exception when check_violation then v_rep := v_rep || '· approved בלי חותמת נדחה ';
  end;
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, status, decided_at)
    values (v_show, v_link, 'גבעון', v_t2, v_t3, 'pending', now());
    v_fail := v_fail || 'מבחן 8b: pending עם decided_at לא נדחה; ';
  exception when check_violation then v_rep := v_rep || '· pending עם חותמת נדחה ';
  end;

  -- ── 9. 🎯 שתי בקשות ממתינות חופפות — חייבות להיות מותרות ──────────────────
  -- שני לקוחות ביקשו את אותה משבצת. זה מצב תקין, והבעלים מכריע ביניהן.
  -- אילוץ שחוסם את זה שובר את הפיצ׳ר.
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at)
    values (v_show, v_link, 'גבעון', v_t0, v_t1),
           (v_show, v_link, 'גבעון', v_t2, v_t3);
    v_rep := v_rep || '· ✅ שתי ממתינות חופפות מותרות ';
  exception when others then
    v_fail := v_fail || 'מבחן 9: שתי בקשות PENDING חופפות נדחו — זה שובר את הפיצ׳ר (' || sqlerrm || '); ';
  end;

  -- ── 10. 🎯 שתי מאושרות חופפות באותו חדר — חייבות להידחות ──────────────────
  if v_gist_available then
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, status, decided_at)
    values (v_show, v_link, 'חשמונאים', v_t0, v_t1, 'approved', now());
    begin
      insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, status, decided_at)
      values (v_show, v_link, 'חשמונאים', v_t2, v_t3, 'approved', now());
      v_fail := v_fail || 'מבחן 10: שתי מאושרות חופפות באותו חדר נכנסו — החדר נמכר פעמיים; ';
    exception when exclusion_violation then v_rep := v_rep || '· ✅ שתי מאושרות חופפות נדחות ';
    end;

    -- 10b. אותו טווח, חדר אחר — חייב לעבור. גבעון וגבעון גדול הם שני חדרים.
    begin
      insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, status, decided_at)
      values (v_show, v_link, 'גבעון גדול', v_t0, v_t1, 'approved', now());
      v_rep := v_rep || '· אותו טווח בחדר אחר מותר ';
    exception when others then
      v_fail := v_fail || 'מבחן 10b: אותו טווח בחדר אחר נדחה — האילוץ מתעלם מ-studio (' || sqlerrm || '); ';
    end;

    -- 10c. חצי-פתוח: [09:00,10:30) ו-[10:30,12:00) נוגעים ואינם חופפים.
    begin
      insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, status, decided_at)
      values (v_show, v_link, 'חשמונאים', v_t1, '2026-10-05 12:00:00+03', 'approved', now());
      v_rep := v_rep || '· ✅ הזמנות גב-אל-גב מותרות ';
    exception when exclusion_violation then
      v_fail := v_fail || 'מבחן 10c: הזמנה שמתחילה בדיוק כשהקודמת נגמרה נדחתה — tstzrange אמור להיות חצי-פתוח; ';
    end;

    -- 10d. מאושרת + ממתינה חופפות — מותר, כי ה-WHERE מסנן ל-approved
    begin
      insert into public.booking_requests (show_id, link_id, studio, start_at, end_at)
      values (v_show, v_link, 'חשמונאים', v_t0, v_t1);
      v_rep := v_rep || '· ממתינה חופפת למאושרת מותרת ';
    exception when others then
      v_fail := v_fail || 'מבחן 10d: בקשה ממתינה נדחתה בגלל מאושרת חופפת — ה-WHERE של האילוץ שגוי (' || sqlerrm || '); ';
    end;

    -- 10e. declined אינו חוסם
    begin
      insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, status, decided_at)
      values (v_show, v_link, 'חשמונאים', v_t0, v_t1, 'declined', now());
      v_rep := v_rep || '· נדחתה אינה חוסמת ';
    exception when others then
      v_fail := v_fail || 'מבחן 10e: בקשה declined נחסמה ע"י מאושרת חופפת (' || sqlerrm || '); ';
    end;
  else
    v_rep := v_rep || '· ⚠️ מבחני 10a-e דולגו: btree_gist אינה זמינה ולכן אין EXCLUDE לבדוק ';
  end if;

  -- ── 11. קישור פעיל אחד לכל תוכנית ─────────────────────────────────────────
  begin
    insert into public.booking_links (show_id, token)
    values (v_show, 'dryrun-token-1111111111111111111111111111');
    v_fail := v_fail || 'מבחן 11: קישור פעיל שני לאותה תוכנית נכנס; ';
  exception when unique_violation then v_rep := v_rep || '· קישור פעיל שני נדחה ';
  end;
  -- ואחרי שלילה — קישור חדש מותר
  update public.booking_links set revoked_at = now() where show_id = v_show and revoked_at is null;
  begin
    insert into public.booking_links (show_id, token)
    values (v_show, 'dryrun-token-2222222222222222222222222222');
    v_rep := v_rep || '· ✅ אחרי שלילה, קישור חדש מותר ';
  exception when others then
    v_fail := v_fail || 'מבחן 11b: אחרי שלילת הקישור, קישור חדש נדחה — האינדקס אינו חלקי (' || sqlerrm || '); ';
  end;
  -- ושני קישורים שנשללו לאותה תוכנית מותרים
  begin
    update public.booking_links set revoked_at = now() where show_id = v_show and revoked_at is null;
    insert into public.booking_links (show_id, token)
    values (v_show, 'dryrun-token-3333333333333333333333333333');
    v_rep := v_rep || '· שלושה קישורים שנשללו מותרים ';
  exception when others then
    v_fail := v_fail || 'מבחן 11c: קישורים מרובים שנשללו נדחו (' || sqlerrm || '); ';
  end;

  -- ── 12. FK: link_id הוא restrict, ולא cascade ────────────────────────────
  -- בקשות הן רשומת אודיט. מחיקת קישור אינה מוחקת את ההיסטוריה שלו.
  begin
    delete from public.booking_links where id = v_link;
    v_fail := v_fail || 'מבחן 12: מחיקת קישור שיש לו בקשות עברה — ההיסטוריה ניתנת למחיקה; ';
  exception when foreign_key_violation then v_rep := v_rep || '· מחיקת קישור עם בקשות נחסמה ';
  end;

  -- ── 13. אורך הטוקן ────────────────────────────────────────────────────────
  -- ⚠️ קודם שוללים את הקישור הפעיל, ואז תופסים check_violation בדיוק.
  -- בלי זה המבחן היה עובר מהסיבה הלא נכונה: אחרי 11c יש קישור פעיל, ולכן
  -- הכנסה נוספת נדחית ע"י האינדקס הייחודי — ו-`when others` היה קורא לזה
  -- הצלחה גם אם אילוץ אורך הטוקן לא היה קיים בכלל.
  update public.booking_links set revoked_at = now() where show_id = v_show and revoked_at is null;
  begin
    insert into public.booking_links (show_id, token) values (v_show, 'short');
    v_fail := v_fail || 'מבחן 13: טוקן קצר (5 תווים) נכנס; ';
  exception
    when check_violation then v_rep := v_rep || '· טוקן קצר נדחה ';
    when unique_violation then v_fail := v_fail || 'מבחן 13: נדחה ע"י האינדקס הייחודי ולא ע"י אילוץ האורך — המבחן לא בדק את מה שהתיימר; ';
  end;

  -- ══ הדוח ══════════════════════════════════════════════════════════════════
  if v_fail <> '' then
    raise exception E'❌ 0096 DRY RUN FAILED — %\n(הכול גולגל, אפס שינוי על המסד)\nbtree_gist זמינה: %', v_fail, v_gist_available;
  end if;

  raise exception E'✅ 0096 DRY RUN OK — %\n\n🎯 ההכרעה: btree_gist % — %\n\nהכל מגולגל, אפס שינוי על המסד.',
    v_rep,
    case when v_gist_available then 'ZMINA / AVAILABLE' else 'LO ZMINA / NOT AVAILABLE' end,
    case when v_gist_available
      then 'אפשר לסמן install_btree_gist := true במיגרציה. ההבטחה תשב במסד.'
      else 'ההחלטה נסגרת מעצמה: accept_app_only := true, וההבטחה נשארת באפליקציה — כל נתיב אישור חייב לנעול select ... for update.' end;
end $dry$;
