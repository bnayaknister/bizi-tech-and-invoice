-- ============================================================================
-- 0109 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- ═══ הקובץ הזה מבצע את כל השינויים ואז מגלגל אותם ═══
-- גוף המיגרציה הועתק לכאן **מילה במילה** בסקריפט (לא ביד). הקובץ מריץ אותו,
-- מוכיח את התוצאה, ומסיים ב-`raise exception` — כך שאפס שינוי נשאר על המסד.
-- **גם הצלחה היא exception.** השורה האדומה בסוף היא הפלט הצפוי.
--
-- ═══ כל הדוח נמצא בהודעת השגיאה, ובמכוון ═══
-- Supabase SQL Editor אינו מציג NOTICE. כל מספר מופיע כ-`label=value`.
-- ============================================================================

do $dry$
declare
  v_n int;
  v_merged int;
  v_bad int;
  v_rep text := '';
  v_msg text;
  v_ok boolean;
  v_md5_b text; v_md5_a text;
  v_md5_live_b text; v_md5_live_a text;
  v_nclients int;
  v_some uuid;
  v_live uuid;
  v_caught int := 0;
begin
  begin
    select md5(coalesce(string_agg((to_jsonb(t) - 'status')::text, '|' order by t.id), '')) into v_md5_b from public.clients t;
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_md5_live_b from public.clients t where t.merged_into is null;
    select count(*) into v_nclients from public.clients;
    -- ════ גוף 0109, מילה במילה ════
    if exists (select 1 from public.schema_ledger where version = '0109') then
      raise exception '0109 כבר הוחלה';
    end if;
    if not exists (select 1 from public.schema_ledger where version = '0108') then
      raise exception '0108 טרם הוחלה — הרץ אותה קודם';
    end if;

    -- ── 0. תנאי מוקדם: שורה ממוזגת היא active, ושום דבר אינו ממוזג אל שורה ממוזגת ──
    select count(*) into v_bad from public.clients
     where merged_into is not null and status <> 'active';
    if v_bad <> 0 then
      raise exception '0109: nmerged_not_active=% — שורה ממוזגת בסטטוס pending/rejected; לבדוק ידנית לפני', v_bad;
    end if;
    select count(*) into v_bad from public.clients c
      join public.clients k on k.id = c.merged_into
     where k.merged_into is not null;
    if v_bad <> 0 then
      raise exception '0109: nchained=% — שורה ממוזגת אל שורה שגם היא ממוזגת', v_bad;
    end if;

    -- ── 1. ערך רביעי ──────────────────────────────────────────────────────────
    alter table public.clients drop constraint clients_status_chk;
    alter table public.clients
      add constraint clients_status_chk check (status in ('pending', 'active', 'rejected', 'merged'));

    -- ── 2. השורות הממוזגות ────────────────────────────────────────────────────
    select count(*) into v_merged from public.clients where merged_into is not null;
    update public.clients set status = 'merged'
     where merged_into is not null and status <> 'merged';
    get diagnostics v_n = row_count;
    if v_n <> v_merged then
      raise exception '0109: עודכנו % מתוך % שורות ממוזגות', v_n, v_merged;
    end if;

    -- ── 3. שני הסימנים הולכים יחד ──────────────────────────────────────────────
    alter table public.clients
      add constraint clients_merged_status_chk
      check ((merged_into is not null) = (status = 'merged'));

    -- ── 4. canary ──────────────────────────────────────────────────────────────
    select count(*) into v_bad from public.clients where status = 'active' and merged_into is not null;
    if v_bad <> 0 then raise exception '0109 canary: nactive_merged=%', v_bad; end if;
    select count(*) into v_n from public.clients where status = 'merged';
    if v_n <> v_merged then raise exception '0109 canary: nmerged_status=% nmerged_into=%', v_n, v_merged; end if;

    insert into public.schema_ledger (version, applied_at, applied_by, note)
    values ('0109', now(), 'bnaya',
      'B24: clients.status מקבל ערך רביעי merged; כל שורה עם merged_into עברה ל-status=merged (' || v_merged || ' שורות); '
      'CHECK clients_merged_status_chk: merged_into לא ריק אם ורק אם status=merged. אפס מחיקות, אפס עמודות חדשות. '
      'שורה ממוזגת נעלמת מכל רשימה שמסננת status=active.');

    -- ════ ההוכחות ════
    select md5(coalesce(string_agg((to_jsonb(t) - 'status')::text, '|' order by t.id), '')) into v_md5_a from public.clients t;
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_md5_live_a from public.clients t where t.merged_into is null;
    v_rep := v_rep || E'\n  nclients=' || v_nclients || ' nmerged=' || v_merged;
    if v_md5_a <> v_md5_b then raise exception 'md5: ערך שאינו status השתנה ב-clients'; end if;
    v_rep := v_rep || E'\n  md5 clients (ללא status): ללא שינוי';
    if v_md5_live_a <> v_md5_live_b then raise exception 'md5: שורה לא ממוזגת השתנתה'; end if;
    v_rep := v_rep || E'\n  md5 שורות לא ממוזגות (כולל status): ללא שינוי';

    -- רשימה שמסננת status=active אינה רואה אף שורה ממוזגת
    select count(*) into v_n from public.clients where status = 'active' and merged_into is not null;
    if v_n <> 0 then raise exception 'שורה ממוזגת עדיין active: n=%', v_n; end if;
    v_rep := v_rep || E'\n  active_and_merged=0';

    -- ה-CHECK החדש: שתי ההפרות נדחות
    if v_merged > 0 then
      select id into v_some from public.clients where merged_into is not null limit 1;
      begin
        update public.clients set status = 'active' where id = v_some;
        raise exception 'NOT_CAUGHT';
      exception when check_violation then v_caught := v_caught + 1;
      end;
    end if;
    select id into v_live from public.clients where merged_into is null and status = 'active' limit 1;
    if v_live is not null then
      begin
        update public.clients set status = 'merged' where id = v_live;
        raise exception 'NOT_CAUGHT';
      exception when check_violation then v_caught := v_caught + 1;
      end;
    end if;
    v_rep := v_rep || E'\n  check_violations_caught=' || v_caught;
  exception when others then
    v_msg := E'❌ 0109 dryrun נכשלה.\n═══ מה נבדק עד לנקודת הכשל ═══'
          || v_rep
          || E'\n\n═══ השגיאה ═══\n  ' || sqlstate || ' ' || sqlerrm
          || E'\n\nהכול גולגל. אפס שינוי נשאר על המסד.';
    raise exception '%', v_msg;
  end;

  v_msg := E'✅ 0109 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n═══ הדוח ═══'
        || v_rep
        || E'\n\n═══ מה הוכח ═══\n  · CHECK הסטטוס מקבל merged; כל שורה עם merged_into עברה ל-merged\n  · אף ערך אחר ב-clients לא זז (md5 בלי status); שורות לא ממוזגות לא זזו בכלל\n  · אין שורה active עם merged_into\n  · CHECK החדש דוחה ממוזגת שחוזרת ל-active, ו-merged בלי merged_into\n\nעכשיו אפשר להריץ את supabase/migrations/0109_merged_client_status.sql';
  raise exception '%', v_msg;
end $dry$;
