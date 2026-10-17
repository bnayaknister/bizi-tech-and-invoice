-- ============================================================================
-- 0118 — E13-8: a client's comment on one item, and its re-approval, each as
-- ONE transaction.
--
-- Plan: docs/plans/E13-review-bunny.md §9.2 E13-8 (b)–(d). Owner decisions
-- 16.10 (§4b (2), (3)) and 17.10 (E13-8 decisions 1–9, decision 7 = this file).
--
-- WHY FUNCTIONS: a comment on an APPROVED item revokes the approval, and that
-- touches five rows in four tables (the comment, the approval ledger, the
-- item, the production's flags and its status). The public response path
-- (applyResponse) writes each one separately and survives a partial failure
-- by recording it; here a half-done revoke would leave an item "pending" while
-- its approval still counts for the 90-day deletion (v_review_media_purge_due
-- reads the ledger) — so it is all or nothing, under a lock on the item row,
-- so that two taps at once cannot revoke or re-approve twice.
--
-- 1. review_item_comment(link, item, version, kind, time_ms, body)
--    · writes the comment — a pin through create_review_pin (0114: numbered
--      per version under a lock), or a general comment. after_response is
--      decided HERE from the link's responded_at, never by the caller.
--    · a pin needs a 'bunny' version: a Drive version has no playback time.
--    · on an APPROVED item (owner 16.10): every valid approval of the item is
--      revoked (revoked_at, revoked_reason 'client_comment' — never deleted),
--      the item goes back to pending, the track flag drops, and the
--      production goes to בעריכה with needs_attention and the "קיבלתי"
--      columns cleared — from אושר_ע"י_לקוח and from הופץ alike. Leaving the
--      board archive is 0112's trigger (any status change). NO MONEY MOVES:
--      guard_client_approval_transition and on_production_approved fire only
--      on ENTERING אושר_ע"י_לקוח; no job, document or pending document is
--      touched.
--    · on a pending item: the comment only; after a response it also lights
--      needs_attention (owner 17.10, decision 8: the red dot is the alert).
--      Before the first response (decision 1: pins on a live link) nothing on
--      the production moves — the client's response is still to come.
-- 2. review_item_reapprove(link, item, version)
--    · only an item whose approval was revoked BY A COMMENT, with a comment
--      from THIS link since the revoke (decision 2). A "revisions" item is
--      approved in the next round, not here.
--    · writes a new approval on the given version (cra_version_chk: a live
--      approval always names its version — an item without versions cannot
--      be re-approved, decision 6), the item approved again, its track flag.
--    · when every in-scope item is approved: status אושר_ע"י_לקוח, the same
--      move applyResponse makes. on_production_approved then finds the job
--      already linked (0090: job_productions) and writes
--      client_approved_already_billed instead of a second job. The deal
--      invoice (per_episode) is the app's step, as in applyResponse, and
--      findBilledEvidence skips it when already billed.
--    · needs_attention is NOT cleared (decision 3): the comment has not been
--      read yet; "קיבלתי" clears it.
--
-- Version checks the caller must also make (the app knows what the client
-- was SHOWN): the version is the item's latest shown version (E13-6 rules).
-- Here only the structural facts: it belongs to the item (the composite FKs
-- of 0114 enforce that too), and a pin's version is 'bunny'.
--
-- No table, no column, no data change. Both functions: SECURITY DEFINER,
-- search_path pinned, EXECUTE for service_role only (the public routes run as
-- the service role; no session may call them).
-- database.types.ts gains the two functions under Functions: run gen types
-- after applying (the routes of E13-8b call them typed).
-- Order: supabase/verify/0118_dryrun.sql → this file → supabase/verify/0118_verify.sql
-- ============================================================================

do $mig$
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
end $mig$;
