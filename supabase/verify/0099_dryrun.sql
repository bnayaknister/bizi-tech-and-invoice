-- ============================================================================
-- 0099 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- מבצע את כל השינויים ואז מגלגל אותם. **גם הצלחה היא exception** — אם אתם
-- רואים ✅, הכול נבדק והכול גולגל, ואפס שינוי נשאר על המסד.
--
-- ═══ מה נבדק ═══
--   1. חמש העמודות נוצרות, כולן nullable.
--   2. calendar_write_status: null עובר, 'created' עובר, 'failed' עובר,
--      ערך שרירותי נדחה.
--   3. production_id: FK תקין עובר, FK על production שלא קיים נדחה.
--   4. production_id: שתי בקשות על אותה הפקה — השנייה נדחית (האינדקס
--      הייחודי החלקי).
--   5. ON DELETE SET NULL: מחיקת ה-production שהבקשה מצביעה עליו **לא**
--      מוחקת את שורת הבקשה — רק מאפסת את production_id שלה.
--   6. ההרשאה העמודתית, בדיוק כפי שהמיגרציה מעניקה אותה.
-- ============================================================================

do $dry$
declare
  v_fail text := '';
  v_rep  text := '';
  v_show uuid;
  v_link uuid;
  v_prod1 uuid;
  v_prod2 uuid;
  v_req1 uuid;
  v_req2 uuid;
  v_t0 timestamptz := '2026-10-05 09:00:00+03';
  v_t1 timestamptz := '2026-10-05 10:30:00+03';
  v_remaining int;
begin
  -- ── 0. הקובץ הזה הוא PRE-migration ────────────────────────────────────────
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'booking_requests') then
    raise exception '0099 DRY RUN: הטבלה booking_requests אינה קיימת — 0096 טרם הוחלה.';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'booking_requests'
               and column_name = 'production_id') then
    raise exception '0099 DRY RUN: העמודה production_id כבר קיימת — המיגרציה כנראה הוחלה. הרץ את 0099_verify.sql במקום.';
  end if;

  select id into v_show from public.shows order by name limit 1;
  if v_show is null then
    raise exception '0099 DRY RUN: אין אף שורה ב-shows — אין FK לתלות בו את הבדיקה.';
  end if;

  -- ── 1. העמודות, ה-CHECK, ה-FK וה-אינדקס, בדיוק כפי שהמיגרציה כותבת אותם ──
  alter table public.booking_requests
    add column calendar_event_id     text null,
    add column calendar_event_uid    text null,
    add column calendar_write_status text null,
    add column calendar_write_error  text null,
    add column production_id        uuid null references public.productions(id) on delete set null;

  alter table public.booking_requests
    add constraint booking_requests_calendar_write_status_chk
    check (calendar_write_status is null or calendar_write_status in ('created', 'failed'));

  create unique index booking_requests_production_id_key
    on public.booking_requests (production_id) where production_id is not null;

  v_rep := v_rep || '· חמש העמודות, ה-CHECK, ה-FK וה-אינדקס נוצרו ';

  -- נתוני בדיקה: קישור שנשלל מראש (לא להתנגש באינדקס "קישור פעיל אחד
  -- לתוכנית"), ושתי הפקות ZTEST מינימליות לתלות בהן FK.
  insert into public.booking_links (show_id, token, revoked_at)
  values (v_show, 'dryrun-0099-token-0000000000000000000000', now())
  returning id into v_link;

  insert into public.productions (podcast_name) values ('ZTEST 0099 dryrun prod 1') returning id into v_prod1;
  insert into public.productions (podcast_name) values ('ZTEST 0099 dryrun prod 2') returning id into v_prod2;

  -- ── 2. calendar_write_status: null / 'created' / 'failed' עוברים ─────────
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, calendar_write_status)
    values (v_show, v_link, 'גבעון', v_t0, v_t1, null);
    v_rep := v_rep || '· null עבר ';
  exception when others then
    v_fail := v_fail || 'מבחן 2a: null נדחה (' || sqlerrm || '); ';
  end;
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, calendar_write_status)
    values (v_show, v_link, 'גבעון', v_t0, v_t1, 'created');
    v_rep := v_rep || E'· \'created\' עבר ';
  exception when others then
    v_fail := v_fail || 'מבחן 2b: ''created'' נדחה (' || sqlerrm || '); ';
  end;
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, calendar_write_status)
    values (v_show, v_link, 'גבעון', v_t0, v_t1, 'failed');
    v_rep := v_rep || E'· \'failed\' עבר ';
  exception when others then
    v_fail := v_fail || 'מבחן 2c: ''failed'' נדחה (' || sqlerrm || '); ';
  end;

  -- ── 3. ערך שרירותי נדחה ───────────────────────────────────────────────────
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, calendar_write_status)
    values (v_show, v_link, 'גבעון', v_t0, v_t1, 'pending');
    v_fail := v_fail || E'מבחן 3: ''pending'' נכנס — ה-CHECK לא אוכף; ';
  exception
    when check_violation then v_rep := v_rep || '· ערך לא-חוקי נדחה ';
    when others then v_fail := v_fail || 'מבחן 3: נדחה ע"י משהו אחר ולא ה-CHECK (' || sqlerrm || '); ';
  end;

  -- ── 4. production_id: FK תקין עובר, FK שקרי נדחה ─────────────────────────
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, production_id)
    values (v_show, v_link, 'גבעון', v_t0, v_t1, v_prod1)
    returning id into v_req1;
    v_rep := v_rep || '· production_id תקין עבר ';
  exception when others then
    v_fail := v_fail || 'מבחן 4a: production_id תקין נדחה (' || sqlerrm || '); ';
  end;
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, production_id)
    values (v_show, v_link, 'גבעון', v_t0, v_t1, gen_random_uuid());
    v_fail := v_fail || 'מבחן 4b: production_id שקרי נכנס — ה-FK לא אוכף; ';
  exception
    when foreign_key_violation then v_rep := v_rep || '· production_id שקרי נדחה ';
    when others then v_fail := v_fail || 'מבחן 4b: נדחה ע"י משהו אחר ולא ה-FK (' || sqlerrm || '); ';
  end;

  -- ── 5. שתי בקשות על אותה הפקה — השנייה נדחית ─────────────────────────────
  begin
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, production_id)
    values (v_show, v_link, 'חשמונאים', v_t0, v_t1, v_prod1);
    v_fail := v_fail || 'מבחן 5: שתי בקשות על אותה הפקה נכנסו — האינדקס הייחודי לא אוכף; ';
  exception
    when unique_violation then v_rep := v_rep || '· production_id כפול נדחה ';
    when others then v_fail := v_fail || 'מבחן 5: נדחה ע"י משהו אחר ולא ע"י הייחודיות (' || sqlerrm || '); ';
  end;

  -- ── 6. ON DELETE SET NULL — מחיקת ה-production לא מוחקת את הבקשה ────────
  insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, production_id)
  values (v_show, v_link, 'חשמונאים', v_t0, v_t1, v_prod2)
  returning id into v_req2;
  delete from public.productions where id = v_prod2;
  if not exists (select 1 from public.booking_requests where id = v_req2) then
    v_fail := v_fail || 'מבחן 6: מחיקת ה-production מחקה גם את הבקשה — ON DELETE SET NULL לא תפס, ה-FK ככל הנראה CASCADE; ';
  else
    select production_id into v_prod2 from public.booking_requests where id = v_req2; -- re-read, now expect null
    if v_prod2 is not null then
      v_fail := v_fail || 'מבחן 6: הבקשה שרדה אך production_id עדיין לא-null; ';
    else
      v_rep := v_rep || '· מחיקת production שרדה את הבקשה ואיפסה production_id ל-null ';
    end if;
  end if;

  -- ── 7. ההרשאה העמודתית, בדיוק כפי שהמיגרציה מעניקה אותה ──────────────────
  grant select (
    calendar_event_id, calendar_event_uid, calendar_write_status,
    calendar_write_error, production_id
  ) on public.booking_requests to authenticated;
  if not has_column_privilege('authenticated', 'public.booking_requests', 'production_id', 'select') then
    v_fail := v_fail || 'מבחן 7: הגרנט העמודתי ל-authenticated לא תפס (production_id); ';
  elsif has_column_privilege('anon', 'public.booking_requests', 'production_id', 'select') then
    v_fail := v_fail || 'מבחן 7: ל-anon יש SELECT על production_id — העמודה נולדה פתוחה; ';
  else
    v_rep := v_rep || '· authenticated קורא, anon לא ';
  end if;

  -- ══ הדוח ══════════════════════════════════════════════════════════════════
  if v_fail <> '' then
    raise exception E'❌ 0099 DRY RUN FAILED — %\n(הכול גולגל, אפס שינוי על המסד)', v_fail;
  end if;

  raise exception E'✅ 0099 DRY RUN OK — %\n\nהכל מגולגל, אפס שינוי על המסד.\nהשלב הבא: supabase/migrations/0099_booking_calendar_write.sql', v_rep;
end $dry$;
