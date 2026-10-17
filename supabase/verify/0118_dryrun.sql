-- ============================================================================
-- 0118 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- גוף המיגרציה הועתק לכאן **מילה במילה** בסקריפט (לא ביד), ואחריו
-- supabase/verify/_0118_dryrun_tests.sql. הקובץ יוצר את שתי הפונקציות, מוכיח
-- את ההתנהגות על פריט אמיתי (נעץ, ביטול, אישור מחדש, דחיות, הרשאות), ומסיים
-- ב-`raise exception` — אפס שינוי נשאר. **גם הצלחה היא exception.** השורה
-- האדומה בסוף היא הפלט הצפוי. Supabase SQL Editor אינו מציג NOTICE — כל
-- הדוח בהודעת השגיאה.
-- ============================================================================

do $dry$
declare
  v_rep         text := '';
  v_msg         text;
  v_caught      int := 0;
  v_item        uuid;
  v_prod        uuid;
  v_ver         uuid;
  v_drive       uuid;
  v_link        uuid;
  v_other_link  uuid;
  v_kind        text;
  v_res         jsonb;
  v_n           bigint;
  v_jobs_before bigint;
begin
  begin

    -- ════ גוף 0118, מילה במילה ════
    declare
      v_n   bigint;
    begin
      -- ═══ 0. guards ═══
      if exists (select 1 from public.schema_ledger where version = '0118') then
        raise exception '0118 כבר רשומה בפנקס — אל תריץ שוב';
      end if;
      if not exists (select 1 from public.schema_ledger where version = '0117') then
        raise exception '0117 טרם הוחלה — הרץ אותה קודם';
      end if;
      if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and p.proname = 'create_review_pin') then
        raise exception '0118: create_review_pin (0114) חסרה — עצור וברר';
      end if;
      if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname in ('review_item_comment', 'review_item_reapprove')) then
        raise exception '0118: הפונקציות כבר קיימות — עצור וברר';
      end if;
      select count(*) into v_n from information_schema.columns
       where table_schema = 'public' and table_name = 'client_review_approvals'
         and column_name in ('revoked_at', 'revoked_reason', 'link_id', 'version_id', 'decided_at');
      if v_n <> 5 then
        raise exception '0118: client_review_approvals אינה בצורה ש-0114 השאירה (%/5)', v_n;
      end if;

      -- ═══ 1. review_item_comment ═══
      create function public.review_item_comment(
        p_link_id    uuid,
        p_item_id    uuid,
        p_version_id uuid,
        p_kind       text,
        p_time_ms    int,
        p_body       text
      )
        returns jsonb
        language plpgsql security definer set search_path = public
      as $fn$
      declare
        v_item    public.client_review_items;
        v_link    public.client_review_links;
        v_prod    public.productions;
        v_after   boolean;
        v_comment public.client_review_comments;
        v_revoked int := 0;
        v_note    text;
      begin
        select * into v_item from public.client_review_items where id = p_item_id for update;
        if v_item.id is null then
          raise exception 'review_item_comment: פריט % לא קיים', p_item_id;
        end if;
        select * into v_link from public.client_review_links where id = p_link_id;
        if v_link.id is null or v_link.production_id <> v_item.production_id then
          raise exception 'review_item_comment: הקישור אינו של ההפקה של הפריט';
        end if;
        select * into v_prod from public.productions where id = v_item.production_id for update;
        if v_prod.status = 'בוטל' then
          raise exception 'review_item_comment: ההפקה בוטלה';
        end if;
        if p_body is null or btrim(p_body) = '' or char_length(p_body) > 2000 then
          raise exception 'review_item_comment: גוף ההערה ריק או ארוך מ-2000 תווים';
        end if;
        if p_version_id is not null and not exists (
             select 1 from public.client_review_versions where id = p_version_id and item_id = p_item_id) then
          raise exception 'review_item_comment: הגרסה אינה של הפריט';
        end if;

        v_after := v_link.responded_at is not null;

        if p_kind = 'pin' then
          if p_version_id is null or p_time_ms is null or p_time_ms < 0 then
            raise exception 'review_item_comment: נעץ צריך גרסה וזמן';
          end if;
          if not exists (select 1 from public.client_review_versions where id = p_version_id and source = 'bunny') then
            raise exception 'review_item_comment: נעץ רק על גרסת Bunny';
          end if;
          v_comment := public.create_review_pin(p_version_id, p_link_id, p_time_ms, btrim(p_body), 'client', null, null, v_after);
        elsif p_kind = 'general' then
          insert into public.client_review_comments (item_id, version_id, link_id, kind, body, author_kind, after_response)
          values (p_item_id, p_version_id, p_link_id, 'general', btrim(p_body), 'client', v_after)
          returning * into v_comment;
        else
          raise exception 'review_item_comment: סוג הערה לא מוכר: %', p_kind;
        end if;

        if v_item.approved then
          -- the revoke (owner 16.10): the ledger keeps the approval, marked
          update public.client_review_approvals
             set revoked_at = now(), revoked_reason = 'client_comment'
           where item_id = p_item_id and decision = 'approved' and revoked_at is null;
          get diagnostics v_revoked = row_count;

          v_note := case when v_item.kind = 'reel' then 'ריל ' || v_item.reel_index || ': ' || btrim(p_body) else btrim(p_body) end;
          update public.client_review_items
             set approved = false, approved_at = null, last_note = v_note
           where id = p_item_id;

          update public.productions
             set status = 'בעריכה',
                 needs_attention = true,
                 review_ack_at = null, review_ack_by = null, review_ack_link_id = null,
                 review_episode_approved = case when v_item.kind = 'episode' then false else review_episode_approved end,
                 review_episode_note     = case when v_item.kind = 'episode' then v_note else review_episode_note end,
                 review_reels_approved   = case when v_item.kind = 'reel' then false else review_reels_approved end,
                 review_reels_note       = case when v_item.kind = 'reel' then v_note else review_reels_note end
           where id = v_item.production_id;

          insert into public.events (entity_type, entity_id, event_type, payload)
          values ('production', v_item.production_id, 'client_review_approval_revoked',
                  jsonb_build_object('item_id', p_item_id, 'version_id', p_version_id, 'link_id', p_link_id,
                                     'comment_id', v_comment.id, 'kind', p_kind,
                                     'from_status', v_prod.status::text, 'approvals_revoked', v_revoked));
        elsif v_after then
          update public.productions set needs_attention = true where id = v_item.production_id;
          insert into public.events (entity_type, entity_id, event_type, payload)
          values ('production', v_item.production_id, 'client_review_post_response_comment',
                  jsonb_build_object('item_id', p_item_id, 'version_id', p_version_id, 'link_id', p_link_id,
                                     'comment_id', v_comment.id, 'kind', p_kind));
        end if;

        return jsonb_build_object(
          'comment_id', v_comment.id,
          'pin_number', v_comment.pin_number,
          'after_response', v_after,
          'revoked', v_item.approved,
          'approvals_revoked', v_revoked,
          'from_status', v_prod.status::text);
      end;
      $fn$;

      -- ═══ 2. review_item_reapprove ═══
      create function public.review_item_reapprove(
        p_link_id    uuid,
        p_item_id    uuid,
        p_version_id uuid
      )
        returns jsonb
        language plpgsql security definer set search_path = public
      as $fn$
      declare
        v_item       public.client_review_items;
        v_link       public.client_review_links;
        v_prod       public.productions;
        v_last       public.client_review_approvals;
        v_re_in      boolean;
        v_ep_ok      boolean;
        v_re_ok      boolean;
        v_all        boolean;
        v_status     text;
      begin
        select * into v_item from public.client_review_items where id = p_item_id for update;
        if v_item.id is null then
          raise exception 'review_item_reapprove: פריט % לא קיים', p_item_id;
        end if;
        select * into v_link from public.client_review_links where id = p_link_id;
        if v_link.id is null or v_link.production_id <> v_item.production_id then
          raise exception 'review_item_reapprove: הקישור אינו של ההפקה של הפריט';
        end if;
        select * into v_prod from public.productions where id = v_item.production_id for update;
        if v_prod.status = 'בוטל' then
          raise exception 'review_item_reapprove: ההפקה בוטלה';
        end if;
        if v_item.approved then
          raise exception 'review_item_reapprove: הפריט כבר מאושר';
        end if;
        if p_version_id is null or not exists (
             select 1 from public.client_review_versions where id = p_version_id and item_id = p_item_id) then
          raise exception 'review_item_reapprove: אישור צריך גרסה של הפריט';
        end if;

        -- decision 2: only an approval revoked BY A COMMENT, with a comment from this link since
        select * into v_last from public.client_review_approvals
         where item_id = p_item_id
         order by decided_at desc, created_at desc, id desc
         limit 1;
        if v_last.id is null or v_last.decision <> 'approved' or v_last.revoked_reason is distinct from 'client_comment' then
          raise exception 'review_item_reapprove: אין אישור שבוטל בהערה על הפריט';
        end if;
        if not exists (select 1 from public.client_review_comments
                        where item_id = p_item_id and link_id = p_link_id and author_kind = 'client'
                          and created_at >= v_last.revoked_at - interval '1 second') then
          raise exception 'review_item_reapprove: הביטול לא נעשה מהקישור הזה';
        end if;

        insert into public.client_review_approvals (item_id, version_id, link_id, decision, decided_at)
        values (p_item_id, p_version_id, p_link_id, 'approved', now());
        update public.client_review_items
           set approved = true, approved_at = now(), last_note = null
         where id = p_item_id;

        -- the same "is the in-scope set approved" reading as applyResponse (item mode)
        v_re_in := v_link.scope in ('reels', 'all') and v_prod.review_reels_required;
        select coalesce(bool_and(approved), true) into v_ep_ok
          from public.client_review_items where production_id = v_item.production_id and kind = 'episode';
        select coalesce(bool_and(approved), true) into v_re_ok
          from public.client_review_items where production_id = v_item.production_id and kind = 'reel';
        -- links.ts item mode, verbatim in meaning: episodeApproved = the episode
        -- item's own state (true when there is none) whatever the link's scope;
        -- reels count only when in scope
        v_all := v_ep_ok and (not v_re_in or v_re_ok);

        update public.productions
           set review_episode_approved = case when v_item.kind = 'episode' then true else review_episode_approved end,
               review_episode_note     = case when v_item.kind = 'episode' then null else review_episode_note end,
               review_reels_approved   = case when v_item.kind = 'reel' and v_re_ok then true else review_reels_approved end,
               review_reels_note       = case when v_item.kind = 'reel' and v_re_ok then null else review_reels_note end
         where id = v_item.production_id;

        if v_all and v_prod.status <> 'אושר_ע"י_לקוח' then
          -- fires guard_client_approval_transition (service role passes) and
          -- on_production_approved (job already linked → client_approved_already_billed)
          update public.productions set status = 'אושר_ע"י_לקוח' where id = v_item.production_id;
        end if;
        select status::text into v_status from public.productions where id = v_item.production_id;

        insert into public.events (entity_type, entity_id, event_type, payload)
        values ('production', v_item.production_id, 'client_review_reapproved',
                jsonb_build_object('item_id', p_item_id, 'version_id', p_version_id, 'link_id', p_link_id,
                                   'approved_all', v_all, 'from_status', v_prod.status::text, 'to_status', v_status));

        return jsonb_build_object('approved_all', v_all, 'from_status', v_prod.status::text, 'status', v_status);
      end;
      $fn$;

      -- ═══ 3. permissions — service_role only ═══
      revoke all on function public.review_item_comment(uuid, uuid, uuid, text, int, text) from public, anon, authenticated;
      revoke all on function public.review_item_reapprove(uuid, uuid, uuid) from public, anon, authenticated;
      grant execute on function public.review_item_comment(uuid, uuid, uuid, text, int, text) to service_role;
      grant execute on function public.review_item_reapprove(uuid, uuid, uuid) to service_role;

      -- ═══ 4. CANARY ═══
      if has_function_privilege('anon', 'public.review_item_comment(uuid, uuid, uuid, text, int, text)', 'EXECUTE')
         or has_function_privilege('authenticated', 'public.review_item_comment(uuid, uuid, uuid, text, int, text)', 'EXECUTE')
         or has_function_privilege('anon', 'public.review_item_reapprove(uuid, uuid, uuid)', 'EXECUTE')
         or has_function_privilege('authenticated', 'public.review_item_reapprove(uuid, uuid, uuid)', 'EXECUTE') then
        raise exception '0118 canary: לסשן יש EXECUTE על פונקציות ההערה/אישור מחדש';
      end if;
      if not (has_function_privilege('service_role', 'public.review_item_comment(uuid, uuid, uuid, text, int, text)', 'EXECUTE')
              and has_function_privilege('service_role', 'public.review_item_reapprove(uuid, uuid, uuid)', 'EXECUTE')) then
        raise exception '0118 canary: ל-service_role אין EXECUTE';
      end if;
      select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('review_item_comment', 'review_item_reapprove')
         and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=public%';
      if v_n <> 2 then
        raise exception '0118 canary: הפונקציות אינן security definer עם search_path קבוע (%/2)', v_n;
      end if;

      raise notice '0118 OK — review_item_comment + review_item_reapprove, service_role בלבד';

      -- ═══ 5. ledger row, last ═══
      insert into public.schema_ledger (version, applied_at, applied_by, note)
      values ('0118', now(), current_user,
        'E13-8, הכרעות בעלים 16.10 ו-17.10: שתי פונקציות אטומיות לראוט הפריט הבודד. '
        || 'review_item_comment: נעץ (דרך create_review_pin, רק על גרסת bunny) או הערה כללית; על פריט מאושר מבטלת את האישור (revoked_at, client_comment, לא מחיקה), הפריט חוזר לממתין, ההפקה לבעריכה עם needs_attention ואיפוס review_ack — גם מהופץ; אחרי תשובה גם על פריט ממתין מדליקה needs_attention. '
        || 'review_item_reapprove: רק פריט שאישורו בוטל בהערה מאותו קישור; אישור חדש על הגרסה; כשכל הפריטים בתחום מאושרים — אושר_ע"י_לקוח (on_production_approved מוצא job קיים, אין חיוב שני); needs_attention לא נכבה (עד קיבלתי). '
        || 'נעילה על שורת הפריט. אפס טבלאות, אפס עמודות, אפס שינוי נתונים. EXECUTE ל-service_role בלבד.');
    end;

    -- ════ ההוכחות (רצות אחרי גוף 0118, בתוך אותה טרנזקציה שתתגלגל לאחור) ════
    -- פריט אמיתי עם גרסת bunny וקישור. כל מה שמשתנה כאן מתגלגל לאחור בסוף.
    select i.id, i.production_id, i.kind, v.id
      into v_item, v_prod, v_kind, v_ver
      from public.client_review_items i
      join public.client_review_versions v on v.item_id = i.id and v.source = 'bunny'
      join public.productions p on p.id = i.production_id and p.status <> 'בוטל'
     where exists (select 1 from public.client_review_links l where l.production_id = i.production_id)
     order by i.created_at, i.id
     limit 1;
    if v_item is null then
      raise exception 'dryrun: צריך פריט עם גרסת bunny ועם קישור להפקה שלו';
    end if;
    select id into v_link from public.client_review_links where production_id = v_prod order by created_at desc, id limit 1;
    select id into v_other_link from public.client_review_links where production_id <> v_prod order by created_at desc, id limit 1;
    select count(*) into v_jobs_before from public.job_productions where production_id = v_prod;
    v_rep := v_rep || E'\n  פריט בדיקה: ' || v_item || ' (' || v_kind || ') · גרסה ' || v_ver || ' · jobs מקושרים: ' || v_jobs_before;

    -- הכנה: קישור שנענה, הפריט מאושר עם שורת אישור, ההפקה "הופץ" ובארכיון, "קיבלתי" על הסבב
    update public.client_review_links set responded_at = coalesce(responded_at, now() - interval '1 day') where id = v_link;
    update public.client_review_items set approved = true, approved_at = now() - interval '1 day' where production_id = v_prod;
    insert into public.client_review_approvals (item_id, version_id, link_id, decision, decided_at)
    values (v_item, v_ver, v_link, 'approved', now() - interval '1 day');
    update public.productions set status = 'הופץ' where id = v_prod;
    update public.productions
       set board_archived_at = now(), needs_attention = false, review_ack_at = now(), review_ack_link_id = v_link,
           review_episode_approved = true, review_reels_approved = true
     where id = v_prod;
    if not exists (select 1 from public.v_review_media_purge_due where item_id = v_item) then
      raise exception 'dryrun: הכנה — לפריט אין אישור תקף בתצוגת המחיקה';
    end if;

    -- 1. נעץ על פריט מאושר → ביטול
    v_res := public.review_item_comment(v_link, v_item, v_ver, 'pin', 42180, 'dryrun 0118 נעץ');
    if not (v_res->>'revoked')::boolean or (v_res->>'pin_number') is null or not (v_res->>'after_response')::boolean then
      raise exception 'dryrun: נעץ על פריט מאושר לא החזיר ביטול: %', v_res;
    end if;
    if not exists (select 1 from public.client_review_comments
                    where id = (v_res->>'comment_id')::uuid and kind = 'pin' and time_ms = 42180
                      and version_id = v_ver and link_id = v_link and author_kind = 'client' and after_response) then
      raise exception 'dryrun: הנעץ לא נשמר כמו שצריך (זמן במילישניות, גרסה, קישור)';
    end if;
    if exists (select 1 from public.client_review_approvals where item_id = v_item and decision = 'approved' and revoked_at is null)
       or not exists (select 1 from public.client_review_approvals where item_id = v_item and revoked_reason = 'client_comment') then
      raise exception 'dryrun: האישור לא סומן כמבוטל (client_comment)';
    end if;
    if (select approved from public.client_review_items where id = v_item) then
      raise exception 'dryrun: הפריט נשאר מאושר';
    end if;
    select count(*) into v_n from public.productions
     where id = v_prod and status = 'בעריכה' and needs_attention and review_ack_link_id is null and review_ack_at is null
       and board_archived_at is null
       and (case when v_kind = 'episode' then not review_episode_approved else not review_reels_approved end);
    if v_n <> 1 then
      raise exception 'dryrun: ההפקה לא עברה לבעריכה עם נקודה אדומה, איפוס קיבלתי, יציאה מהארכיון ודגל כבוי';
    end if;
    if not exists (select 1 from public.events where entity_id = v_prod and event_type = 'client_review_approval_revoked'
                    and payload->>'from_status' = 'הופץ' and payload->>'item_id' = v_item::text) then
      raise exception 'dryrun: אין אירוע client_review_approval_revoked עם from_status הופץ';
    end if;
    if exists (select 1 from public.v_review_media_purge_due where item_id = v_item) then
      raise exception 'dryrun: שעון המחיקה לא נעצר (יש עדיין אישור תקף בתצוגה)';
    end if;
    v_rep := v_rep || E'\n  ✓ נעץ (42180ms) על פריט מאושר: האישור מבוטל ולא נמחק, הפריט ממתין, ההפקה הופץ→בעריכה, נקודה אדומה, קיבלתי אופס, יצאה מהארכיון, שעון המחיקה נעצר';

    -- 2. הערה כללית על אותו פריט (עכשיו ממתין) → בלי ביטול נוסף, נקודה אדומה
    update public.productions set needs_attention = false where id = v_prod;
    v_res := public.review_item_comment(v_link, v_item, null, 'general', null, 'dryrun 0118 כללית');
    if (v_res->>'revoked')::boolean or not (select needs_attention from public.productions where id = v_prod)
       or not exists (select 1 from public.events where entity_id = v_prod and event_type = 'client_review_post_response_comment') then
      raise exception 'dryrun: הערה אחרי תשובה על פריט ממתין: %', v_res;
    end if;
    v_rep := v_rep || E'\n  ✓ הערה כללית אחרי תשובה על פריט ממתין: נשמרת, נקודה אדומה, בלי ביטול נוסף';

    -- 3. אישור מחדש מאותו קישור → כל הפריטים מאושרים → אושר_ע"י_לקוח, בלי job שני, הנקודה נשארת
    v_res := public.review_item_reapprove(v_link, v_item, v_ver);
    if not (v_res->>'approved_all')::boolean or v_res->>'status' <> 'אושר_ע"י_לקוח' then
      raise exception 'dryrun: אישור מחדש לא החזיר את ההפקה לאושר_ע"י_לקוח: %', v_res;
    end if;
    if not (select approved from public.client_review_items where id = v_item)
       or not exists (select 1 from public.client_review_approvals where item_id = v_item and decision = 'approved' and revoked_at is null and link_id = v_link and version_id = v_ver)
       or not exists (select 1 from public.v_review_media_purge_due where item_id = v_item and approved_at > now() - interval '1 minute') then
      raise exception 'dryrun: אישור מחדש — שורת אישור חדשה / הפריט / שעון מחיקה חדש';
    end if;
    if not (select needs_attention from public.productions where id = v_prod) then
      raise exception 'dryrun: הנקודה האדומה כבתה באישור מחדש (הכרעה 3: נשארת עד קיבלתי)';
    end if;
    select count(*) into v_n from public.job_productions where production_id = v_prod;
    if (v_jobs_before >= 1 and v_n <> v_jobs_before) or (v_jobs_before = 0 and v_n > 1) then
      raise exception 'dryrun: מספר ה-jobs השתנה באישור מחדש: % → %', v_jobs_before, v_n;
    end if;
    v_rep := v_rep || E'\n  ✓ אישור מחדש: שורת אישור חדשה על הגרסה, הפריט מאושר, אושר_ע"י_לקוח, שעון 90 יום מחדש, הנקודה נשארת, jobs: ' || v_jobs_before || ' → ' || v_n;

    -- 4. הדחיות
    begin
      perform public.review_item_reapprove(v_link, v_item, v_ver);
      raise exception 'dryrun: אישור מחדש פעמיים עבר';
    exception when raise_exception then
      if sqlerrm not like '%כבר מאושר%' then raise; end if;
      v_caught := v_caught + 1;
    end;
    begin
      perform public.review_item_comment(v_link, v_item, v_ver, 'pin', null, 'x');
      raise exception 'dryrun: נעץ בלי זמן עבר';
    exception when raise_exception then
      if sqlerrm not like '%נעץ צריך גרסה וזמן%' then raise; end if;
      v_caught := v_caught + 1;
    end;
    begin
      perform public.review_item_comment(v_link, v_item, v_ver, 'general', null, '   ');
      raise exception 'dryrun: הערה ריקה עברה';
    exception when raise_exception then
      if sqlerrm not like '%ריק%' then raise; end if;
      v_caught := v_caught + 1;
    end;
    begin
      perform public.review_item_comment(v_link, v_item, v_ver, 'bogus', null, 'x');
      raise exception 'dryrun: סוג לא מוכר עבר';
    exception when raise_exception then
      if sqlerrm not like '%סוג הערה לא מוכר%' then raise; end if;
      v_caught := v_caught + 1;
    end;
    -- נעץ על גרסת drive (נוצרת כאן, מתגלגלת לאחור)
    insert into public.client_review_versions (item_id, number, source, media_link)
    values (v_item, (select coalesce(max(number), 0) + 1 from public.client_review_versions where item_id = v_item), 'drive', 'https://drive.google.com/file/d/dryrun0118/view')
    returning id into v_drive;
    begin
      perform public.review_item_comment(v_link, v_item, v_drive, 'pin', 1000, 'x');
      raise exception 'dryrun: נעץ על גרסת drive עבר';
    exception when raise_exception then
      if sqlerrm not like '%רק על גרסת Bunny%' then raise; end if;
      v_caught := v_caught + 1;
    end;
    if v_other_link is not null then
      begin
        perform public.review_item_comment(v_other_link, v_item, v_ver, 'general', null, 'x');
        raise exception 'dryrun: קישור של הפקה אחרת עבר';
      exception when raise_exception then
        if sqlerrm not like '%אינו של ההפקה%' then raise; end if;
        v_caught := v_caught + 1;
      end;
    else
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  (אין קישור של הפקה אחרת — בדיקת הקישור הזר דולגה)';
    end if;
    -- אישור שבוטל בגרירה אחורה (לא בהערה) → אין אישור מחדש
    update public.client_review_approvals set revoked_at = now(), revoked_reason = 'board_rollback'
     where item_id = v_item and decision = 'approved' and revoked_at is null;
    update public.client_review_items set approved = false where id = v_item;
    begin
      perform public.review_item_reapprove(v_link, v_item, v_ver);
      raise exception 'dryrun: אישור מחדש אחרי ביטול שלא בהערה עבר';
    exception when raise_exception then
      if sqlerrm not like '%אין אישור שבוטל בהערה%' then raise; end if;
      v_caught := v_caught + 1;
    end;
    begin
      perform public.review_item_reapprove(v_link, v_item, null);
      raise exception 'dryrun: אישור מחדש בלי גרסה עבר';
    exception when raise_exception then
      if sqlerrm not like '%אישור צריך גרסה%' then raise; end if;
      v_caught := v_caught + 1;
    end;
    v_rep := v_rep || E'\n  ✓ נדחו: אישור כפול, נעץ בלי זמן, הערה ריקה, סוג לא מוכר, נעץ על drive, קישור זר, אישור מחדש אחרי ביטול בגרירה, אישור בלי גרסה';

    -- 5. קישור חי (לפני תשובה), פריט ממתין → ההערה נשמרת, ההפקה לא זזה
    update public.client_review_links set responded_at = null where id = v_link;
    update public.productions set needs_attention = false where id = v_prod;
    select status::text into v_kind from public.productions where id = v_prod;
    v_res := public.review_item_comment(v_link, v_item, v_ver, 'pin', 5000, 'dryrun 0118 לפני תשובה');
    if (v_res->>'after_response')::boolean or (v_res->>'revoked')::boolean
       or (select needs_attention from public.productions where id = v_prod)
       or (select status::text from public.productions where id = v_prod) <> v_kind then
      raise exception 'dryrun: נעץ בקישור חי על פריט ממתין הזיז את ההפקה: %', v_res;
    end if;
    v_rep := v_rep || E'\n  ✓ נעץ בקישור חי לפני תשובה: after_response=false, ההפקה לא זזה';

    -- 6. הרשאות
    execute 'set local role authenticated';
    begin
      perform public.review_item_comment(v_link, v_item, v_ver, 'general', null, 'x');
      raise exception 'dryrun: authenticated הריץ את review_item_comment';
    exception when insufficient_privilege then v_caught := v_caught + 1;
    end;
    begin
      perform public.review_item_reapprove(v_link, v_item, v_ver);
      raise exception 'dryrun: authenticated הריץ את review_item_reapprove';
    exception when insufficient_privilege then v_caught := v_caught + 1;
    end;
    execute 'reset role';

    if v_caught <> 10 then
      raise exception 'dryrun: נתפסו % דחיות במקום 10', v_caught;
    end if;
    v_rep := v_rep || E'\n  ✓ authenticated נדחה בשתי הפונקציות · סה"כ 10/10 דחיות כצפוי';
    raise exception 'DRYRUN_PASS';
  exception when others then
    if sqlerrm = 'DRYRUN_PASS' then
      v_msg := E'✅ 0118 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n═══ מה הוכח ═══' || v_rep;
    else
      v_msg := E'❌ 0118 dryrun נכשלה.\n═══ מה נבדק עד לנקודת הכשל ═══' || v_rep
            || E'\n\n═══ השגיאה ═══\n  ' || sqlstate || ' ' || sqlerrm;
    end if;
  end;
  raise exception '%', v_msg;
end $dry$;
