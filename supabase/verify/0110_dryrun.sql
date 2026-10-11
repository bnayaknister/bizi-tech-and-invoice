-- ============================================================================
-- 0110 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- ═══ הקובץ הזה מבצע את כל השינויים ואז מגלגל אותם ═══
-- גוף המיגרציה הועתק לכאן **מילה במילה** בסקריפט (לא ביד). הקובץ מריץ אותו,
-- מוכיח את התוצאה, ומסיים ב-`raise exception` — כך שאפס שינוי נשאר על המסד.
-- **גם הצלחה היא exception.** השורה האדומה בסוף היא הפלט הצפוי.
--
-- ═══ כל הדוח נמצא בהודעת השגיאה, ובמכוון ═══
-- Supabase SQL Editor אינו מציג NOTICE. כל מספר מופיע כ-`label=value`.
--
-- ⚠️ דורש ש-0109 כבר הוחלה (הגוף בודק את שורת הפנקס).
-- ============================================================================

do $dry$
declare
  c_keep    constant uuid := '3f010d05-5859-4a9d-89ad-f79eee55cad5';
  c_drop    constant uuid := '94b1949d-9918-470c-9438-dfadf1617880';
  c_morning constant text := '2b73787f-b09e-48dc-810e-3aacb0b5a394';
  c_tax     constant text := '540279502';
  c_name    constant text := 'גל אורן לרנר';
  c_norm    constant text := 'גלאורןלרנר';
  k record;
  d record;
  v_n int;
  v_moved jsonb := '{}'::jsonb;
  v_fk record;
  v_left int;
  v_report text := '';
  v_rep text := '';
  v_msg text;
  v_ok boolean;
  v_x text;
  v_md5_clients_b text; v_md5_clients_a text;
  v_md5_events_b text;  v_md5_events_a text;
  v_other_b jsonb := '{}'::jsonb; v_other_a jsonb := '{}'::jsonb;
  v_ours_b jsonb := '{}'::jsonb;  v_ours_a jsonb := '{}'::jsonb;
  v_jobs_keep_b int; v_docs_keep_b int; v_inv_keep_b int; v_events_b int;
begin
  begin
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_md5_clients_b from public.clients t where t.id not in ('3f010d05-5859-4a9d-89ad-f79eee55cad5', '94b1949d-9918-470c-9438-dfadf1617880');
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_md5_events_b from public.events t;
    select count(*) into v_jobs_keep_b from public.jobs where client_id = '3f010d05-5859-4a9d-89ad-f79eee55cad5';
    select count(*) into v_docs_keep_b from public.documents where client_id = '3f010d05-5859-4a9d-89ad-f79eee55cad5';
    select count(*) into v_inv_keep_b from public.invoices where client_id = '3f010d05-5859-4a9d-89ad-f79eee55cad5';
    select count(*) into v_events_b from public.events;
    create temp table _dry_due on commit drop as select id, due_date from public.jobs where client_id in ('3f010d05-5859-4a9d-89ad-f79eee55cad5', '94b1949d-9918-470c-9438-dfadf1617880');
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.contracts t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_b := v_other_b || jsonb_build_object('contracts', v_x);
    select md5(coalesce(string_agg((to_jsonb(t) - 'client_id')::text, '|' order by t.id), '')) into v_x from public.contracts t where t.client_id in (c_keep, c_drop);
    v_ours_b := v_ours_b || jsonb_build_object('contracts', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.documents t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_b := v_other_b || jsonb_build_object('documents', v_x);
    select md5(coalesce(string_agg((to_jsonb(t) - 'client_id')::text, '|' order by t.id), '')) into v_x from public.documents t where t.client_id in (c_keep, c_drop);
    v_ours_b := v_ours_b || jsonb_build_object('documents', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.invoices t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_b := v_other_b || jsonb_build_object('invoices', v_x);
    select md5(coalesce(string_agg((to_jsonb(t) - 'client_id')::text, '|' order by t.id), '')) into v_x from public.invoices t where t.client_id in (c_keep, c_drop);
    v_ours_b := v_ours_b || jsonb_build_object('invoices', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.jobs t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_b := v_other_b || jsonb_build_object('jobs', v_x);
    select md5(coalesce(string_agg((to_jsonb(t) - 'client_id' - 'due_date')::text, '|' order by t.id), '')) into v_x from public.jobs t where t.client_id in (c_keep, c_drop);
    v_ours_b := v_ours_b || jsonb_build_object('jobs', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.pending_documents t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_b := v_other_b || jsonb_build_object('pending_documents', v_x);
    select md5(coalesce(string_agg((to_jsonb(t) - 'client_id')::text, '|' order by t.id), '')) into v_x from public.pending_documents t where t.client_id in (c_keep, c_drop);
    v_ours_b := v_ours_b || jsonb_build_object('pending_documents', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.productions t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_b := v_other_b || jsonb_build_object('productions', v_x);
    select md5(coalesce(string_agg((to_jsonb(t) - 'client_id')::text, '|' order by t.id), '')) into v_x from public.productions t where t.client_id in (c_keep, c_drop);
    v_ours_b := v_ours_b || jsonb_build_object('productions', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.shows t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_b := v_other_b || jsonb_build_object('shows', v_x);
    select md5(coalesce(string_agg((to_jsonb(t) - 'client_id')::text, '|' order by t.id), '')) into v_x from public.shows t where t.client_id in (c_keep, c_drop);
    v_ours_b := v_ours_b || jsonb_build_object('shows', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.misc_productions t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_b := v_other_b || jsonb_build_object('misc_productions', v_x);
    select md5(coalesce(string_agg((to_jsonb(t) - 'client_id')::text, '|' order by t.id), '')) into v_x from public.misc_productions t where t.client_id in (c_keep, c_drop);
    v_ours_b := v_ours_b || jsonb_build_object('misc_productions', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t::text), '')) into v_x from public.client_morning_ids t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_b := v_other_b || jsonb_build_object('client_morning_ids', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.client_registrations t;
    v_other_b := v_other_b || jsonb_build_object('client_registrations', v_x);
    -- ════ גוף 0110, מילה במילה ════
    if exists (select 1 from public.schema_ledger where version = '0110') then
      raise exception '0110 כבר הוחלה';
    end if;
    if not exists (select 1 from public.schema_ledger where version = '0109') then
      raise exception '0109 טרם הוחלה — הערך status=merged חסר';
    end if;

    -- ── 0. גארדים על שתי השורות ──────────────────────────────────────────────
    select * into k from public.clients where id = c_keep for update;
    select * into d from public.clients where id = c_drop for update;
    if k.id is null or d.id is null then
      raise exception '0110: אחת השורות אינה קיימת (keep=% drop=%)', k.id is not null, d.id is not null;
    end if;
    if k.merged_into is not null or d.merged_into is not null then
      raise exception '0110: אחת השורות כבר ממוזגת — אין מה למזג';
    end if;
    if k.status <> 'active' or d.status <> 'active' then
      raise exception '0110: status keep=% drop=% — שתיהן צריכות להיות active', k.status, d.status;
    end if;
    if exists (select 1 from public.clients where merged_into = c_drop) then
      raise exception '0110: שורות אחרות ממוזגות אל 94b1949d — היו נשארות מצביעות על שורה ממוזגת';
    end if;
    if k.morning_client_id is distinct from c_morning or d.morning_client_id is distinct from c_morning then
      raise exception '0110: morning_client_id keep=% drop=% — לא מה שנמדד 11.10', k.morning_client_id, d.morning_client_id;
    end if;
    if k.tax_id is not null or d.tax_id is not null then
      raise exception '0110: tax_id כבר מלא (keep=% drop=%) — נמדד ריק 11.10', k.tax_id, d.tax_id;
    end if;
    if exists (select 1 from public.clients where tax_id = c_tax) then
      raise exception '0110: ח.פ % כבר שייך ללקוח אחר', c_tax;
    end if;
    if exists (select 1 from public.clients where normalized_name = c_norm and id not in (c_keep, c_drop)) then
      raise exception '0110: normalized_name % שייך לשורה שלישית', c_norm;
    end if;
    if k.payment_terms is distinct from d.payment_terms then
      raise exception '0110: payment_terms keep=% drop=% — העברת jobs תחשב due_date מחדש; להכריע קודם', k.payment_terms, d.payment_terms;
    end if;
    -- ה-pending_document עובר לנשארת וייפדה לפי המקצב שלה (0046/0047)
    if k.billing_cadence is distinct from d.billing_cadence or k.billing_every_n is distinct from d.billing_every_n then
      raise exception '0110: billing_cadence keep=%/% drop=%/% — שורת התור תעבור למקצב אחר; להכריע קודם',
        k.billing_cadence, k.billing_every_n, d.billing_cadence, d.billing_every_n;
    end if;

    -- הספירות של הממוזגת — כפי שנמדדו
    if (select count(*) from public.jobs where client_id = c_drop) <> 6
       or (select count(*) from public.invoices where client_id = c_drop) <> 9
       or (select count(*) from public.pending_documents where client_id = c_drop) <> 1
       or (select count(*) from public.client_morning_ids where client_id = c_drop) <> 1
       or (select count(*) from public.documents where client_id = c_drop) <> 0
       or (select count(*) from public.productions where client_id = c_drop) <> 0
       or (select count(*) from public.shows where client_id = c_drop) <> 0
       or (select count(*) from public.contracts where client_id = c_drop) <> 0
       or (select count(*) from public.misc_productions where client_id = c_drop) <> 0
       or (select count(*) from public.client_registrations where client_id = c_drop or duplicate_of_client_id = c_drop) <> 0 then
      raise exception '0110: הספירות של 94b1949d השתנו מאז המדידה של 11.10 — למדוד שוב לפני';
    end if;

    -- גארד ה-pending_document
    if exists (select 1 from public.pending_documents where client_id = c_drop and status = 'approved') then
      raise exception '0110: ה-pending_document של 94b1949d במצב approved — הנפקה בעיצומה או שקרסה באמצע. לבדוק במורנינג ולהכריע לפני';
    end if;
    if exists (
      select 1 from public.events e
        join public.pending_documents p on p.id = e.entity_id
       where p.client_id = c_drop
         and e.entity_type = 'pending_document'
         and e.event_type = 'morning_call_started'
         and e.created_at > now() - interval '30 minutes') then
      raise exception '0110: קריאה למורנינג על ה-pending_document של 94b1949d ב-30 הדקות האחרונות — לחכות ולהריץ שוב';
    end if;

    -- ── 1. ניתוק מורנינג של הממוזגת ──────────────────────────────────────────
    update public.clients set morning_client_id = null where id = c_drop;

    -- ── 2. שורת הכינוי שלה ───────────────────────────────────────────────────
    delete from public.client_morning_ids where client_id = c_drop and morning_client_id = c_morning;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception '0110: נמחקו % שורות client_morning_ids, צפויה 1', v_n; end if;
    v_moved := v_moved || jsonb_build_object('client_morning_ids_deleted', v_n);

    -- ── 3. תשע הטבלאות ───────────────────────────────────────────────────────
    update public.contracts         set client_id = c_keep where client_id = c_drop;
    get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('contracts', v_n);
    update public.documents         set client_id = c_keep where client_id = c_drop;
    get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('documents', v_n);
    update public.invoices          set client_id = c_keep where client_id = c_drop;
    get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('invoices', v_n);
    update public.jobs              set client_id = c_keep where client_id = c_drop;
    get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('jobs', v_n);
    update public.pending_documents set client_id = c_keep where client_id = c_drop;
    get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('pending_documents', v_n);
    update public.productions       set client_id = c_keep where client_id = c_drop;
    get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('productions', v_n);
    update public.shows             set client_id = c_keep where client_id = c_drop;
    get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('shows', v_n);
    update public.misc_productions  set client_id = c_keep where client_id = c_drop;
    get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('misc_productions', v_n);
    update public.client_registrations set client_id = c_keep where client_id = c_drop;
    get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('client_registrations', v_n);
    update public.client_registrations set duplicate_of_client_id = c_keep where duplicate_of_client_id = c_drop;
    get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('client_registrations_dup', v_n);

    -- ── 4. שחרור השם + סימון המיזוג ──────────────────────────────────────────
    update public.clients
       set name = '[מוזג] ' || name,
           normalized_name = 'merged:' || c_drop::text,
           merged_into = c_keep,
           status = 'merged'
     where id = c_drop;

    -- ── 5. הנשארת: השם של מורנינג וח.פ ───────────────────────────────────────
    update public.clients
       set name = c_name,
           normalized_name = c_norm,
           tax_id = c_tax
     where id = c_keep;

    -- ── 6. canary: אף עמודת FK אל clients(id) אינה מצביעה על הממוזגת ──────────
    for v_fk in
      select cl.relname as tbl, a.attname as col
        from pg_constraint con
        join pg_class cl on cl.oid = con.conrelid
        join pg_namespace ns on ns.oid = cl.relnamespace
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
       where con.contype = 'f'
         and con.confrelid = 'public.clients'::regclass
         and array_length(con.conkey, 1) = 1
    loop
      execute format('select count(*) from %I.%I where %I = $1', 'public', v_fk.tbl, v_fk.col)
        into v_left using c_drop;
      v_report := v_report || v_fk.tbl || '.' || v_fk.col || '=' || v_left || ' ';
      if v_left <> 0 then
        raise exception '0110 canary: %.% עדיין מצביעה על 94b1949d (n=%)', v_fk.tbl, v_fk.col, v_left;
      end if;
    end loop;

    if (select count(*) from public.client_morning_ids
         where client_id = c_keep and morning_client_id = c_morning and is_primary) <> 1 then
      raise exception '0110 canary: לנשארת אין שורת client_morning_ids ראשית עם 2b73787f';
    end if;
    if (select count(*) from public.clients where normalized_name = c_norm) <> 1 then
      raise exception '0110 canary: normalized_name % אינו ייחודי', c_norm;
    end if;
    if exists (select 1 from public.clients where id = c_drop
                and (morning_client_id is not null or merged_into <> c_keep or status <> 'merged')) then
      raise exception '0110 canary: השורה הממוזגת לא סומנה כמצופה';
    end if;

    insert into public.events (entity_type, entity_id, event_type, payload)
    values ('client', c_keep, 'client_merged',
            jsonb_build_object('merged_from', c_drop, 'ticket', 'P26', 'moved', v_moved,
                               'renamed_to', c_name, 'tax_id', c_tax));

    insert into public.schema_ledger (version, applied_at, applied_by, note)
    values ('0110', now(), 'bnaya',
      'P26: "גל אורן לרנר" 94b1949d מוזג אל 3f010d05 (הכרעת בעלים 11.10). הועברו: ' || v_moved::text || '. '
      'שורת client_morning_ids של הממוזגת נמחקה (לנשארת אותו מזהה 2b73787f). '
      'הממוזגת: morning_client_id=null, name=[מוזג] …, normalized_name=merged:<id>, merged_into=3f010d05, status=merged. '
      'הנשארת: name="גל אורן לרנר" (השם שמורנינג שולח), normalized_name=גלאורןלרנר, tax_id=540279502. '
      'events נשארים על המזהה הישן. canary: אפס הפניות לממוזגת בכל עמודת FK אל clients.');

    -- ════ ההוכחות ════
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_md5_clients_a from public.clients t where t.id not in (c_keep, c_drop);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_md5_events_a from public.events t where not (t.entity_id = c_keep and t.event_type = 'client_merged');
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.contracts t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_a := v_other_a || jsonb_build_object('contracts', v_x);
    select md5(coalesce(string_agg((to_jsonb(t) - 'client_id')::text, '|' order by t.id), '')) into v_x from public.contracts t where t.client_id in (c_keep, c_drop);
    v_ours_a := v_ours_a || jsonb_build_object('contracts', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.documents t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_a := v_other_a || jsonb_build_object('documents', v_x);
    select md5(coalesce(string_agg((to_jsonb(t) - 'client_id')::text, '|' order by t.id), '')) into v_x from public.documents t where t.client_id in (c_keep, c_drop);
    v_ours_a := v_ours_a || jsonb_build_object('documents', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.invoices t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_a := v_other_a || jsonb_build_object('invoices', v_x);
    select md5(coalesce(string_agg((to_jsonb(t) - 'client_id')::text, '|' order by t.id), '')) into v_x from public.invoices t where t.client_id in (c_keep, c_drop);
    v_ours_a := v_ours_a || jsonb_build_object('invoices', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.jobs t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_a := v_other_a || jsonb_build_object('jobs', v_x);
    select md5(coalesce(string_agg((to_jsonb(t) - 'client_id' - 'due_date')::text, '|' order by t.id), '')) into v_x from public.jobs t where t.client_id in (c_keep, c_drop);
    v_ours_a := v_ours_a || jsonb_build_object('jobs', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.pending_documents t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_a := v_other_a || jsonb_build_object('pending_documents', v_x);
    select md5(coalesce(string_agg((to_jsonb(t) - 'client_id')::text, '|' order by t.id), '')) into v_x from public.pending_documents t where t.client_id in (c_keep, c_drop);
    v_ours_a := v_ours_a || jsonb_build_object('pending_documents', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.productions t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_a := v_other_a || jsonb_build_object('productions', v_x);
    select md5(coalesce(string_agg((to_jsonb(t) - 'client_id')::text, '|' order by t.id), '')) into v_x from public.productions t where t.client_id in (c_keep, c_drop);
    v_ours_a := v_ours_a || jsonb_build_object('productions', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.shows t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_a := v_other_a || jsonb_build_object('shows', v_x);
    select md5(coalesce(string_agg((to_jsonb(t) - 'client_id')::text, '|' order by t.id), '')) into v_x from public.shows t where t.client_id in (c_keep, c_drop);
    v_ours_a := v_ours_a || jsonb_build_object('shows', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.misc_productions t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_a := v_other_a || jsonb_build_object('misc_productions', v_x);
    select md5(coalesce(string_agg((to_jsonb(t) - 'client_id')::text, '|' order by t.id), '')) into v_x from public.misc_productions t where t.client_id in (c_keep, c_drop);
    v_ours_a := v_ours_a || jsonb_build_object('misc_productions', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t::text), '')) into v_x from public.client_morning_ids t where t.client_id is distinct from c_keep and t.client_id is distinct from c_drop;
    v_other_a := v_other_a || jsonb_build_object('client_morning_ids', v_x);
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_x from public.client_registrations t;
    v_other_a := v_other_a || jsonb_build_object('client_registrations', v_x);

    v_rep := v_rep || E'\n  moved=' || v_moved::text;
    v_rep := v_rep || E'\n  fk_refs_to_drop: ' || v_report;
    if v_md5_clients_a <> v_md5_clients_b then raise exception 'md5: לקוח אחר השתנה'; end if;
    v_rep := v_rep || E'\n  md5 שאר הלקוחות: ללא שינוי';
    if v_md5_events_a <> v_md5_events_b then raise exception 'md5: events השתנו מעבר לשורת client_merged'; end if;
    select count(*) into v_n from public.events;
    if v_n <> v_events_b + 1 then raise exception 'events: נוספו % שורות, צפויה 1', v_n - v_events_b; end if;
    v_rep := v_rep || E'\n  events: שורה אחת נוספה (client_merged), השאר ללא שינוי';
    if v_other_a <> v_other_b then raise exception 'md5: שורות של לקוחות אחרים זזו: before=% after=%', v_other_b, v_other_a; end if;
    v_rep := v_rep || E'\n  md5 עשר הטבלאות, שורות של לקוחות אחרים: ללא שינוי';
    if v_ours_a <> v_ours_b then raise exception 'md5: השורות שהועברו השתנו מעבר ל-client_id: before=% after=%', v_ours_b, v_ours_a; end if;
    v_rep := v_rep || E'\n  md5 השורות שהועברו (בלי client_id, ב-jobs גם בלי due_date): ללא שינוי';

    select count(*) into v_n from _dry_due x join public.jobs j on j.id = x.id where j.due_date is distinct from x.due_date;
    v_rep := v_rep || E'\n  jobs_due_date_changed=' || v_n;

    -- הספירות של הנשארת
    v_rep := v_rep || E'\n  keep_jobs=' || (select count(*) from public.jobs where client_id = c_keep)
                  || ' (before=' || v_jobs_keep_b || ')'
                  || ' keep_invoices=' || (select count(*) from public.invoices where client_id = c_keep)
                  || ' (before=' || v_inv_keep_b || ')'
                  || ' keep_documents=' || (select count(*) from public.documents where client_id = c_keep)
                  || ' (before=' || v_docs_keep_b || ')'
                  || ' keep_pending=' || (select count(*) from public.pending_documents where client_id = c_keep);

    -- 🔴 השורה הממוזגת לא מופיעה ברשימות
    select count(*) into v_n from public.clients where status = 'active' and id = c_drop;
    if v_n <> 0 then raise exception 'הממוזגת מופיעה ברשימת status=active'; end if;
    select count(*) into v_n from public.clients where merged_into is null and id = c_drop;
    if v_n <> 0 then raise exception 'הממוזגת מופיעה ברשימת merged_into is null'; end if;
    select count(*) into v_n from public.clients where status = 'active' and morning_client_id = c_morning;
    if v_n <> 1 then raise exception 'מורנינג 2b73787f נפתר ל-% לקוחות active, צפוי 1', v_n; end if;
    select count(*) into v_n from public.client_morning_ids where morning_client_id = c_morning;
    if v_n <> 1 then raise exception 'client_morning_ids של 2b73787f: % שורות, צפויה 1', v_n; end if;
    select count(*) into v_n from public.clients where normalized_name = c_norm and status = 'active';
    if v_n <> 1 then raise exception 'חיפוש לפי השם המנורמל: % שורות active', v_n; end if;
    select count(*) into v_n from public.clients where tax_id = c_tax and status = 'active' and id = c_keep;
    if v_n <> 1 then raise exception 'חיפוש לפי ח.פ אינו מחזיר את הנשארת'; end if;
    v_rep := v_rep || E'\n  drop_in_active_list=0 drop_in_unmerged_list=0 morning_resolves_to=1 cmi_rows=1 name_lookup=1 tax_lookup=keep';
    select name into v_x from public.clients where id = c_keep;
    v_rep := v_rep || E'\n  keep_name_applied=' || (v_x = c_name)::text;
    select name into v_x from public.clients where id = c_drop;
    v_rep := v_rep || E'\n  drop_name_released=' || (v_x <> c_name)::text;
    select count(*) - count(distinct normalized_name) into v_n from public.clients;
    v_rep := v_rep || E'\n  duplicate_normalized_names=' || v_n;
  exception when others then
    v_msg := E'❌ 0110 dryrun נכשלה.\n═══ מה נבדק עד לנקודת הכשל ═══'
          || v_rep
          || E'\n\n═══ השגיאה ═══\n  ' || sqlstate || ' ' || sqlerrm
          || E'\n\nהכול גולגל. אפס שינוי נשאר על המסד.';
    raise exception '%', v_msg;
  end;

  v_msg := E'✅ 0110 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n═══ הדוח ═══'
        || v_rep
        || E'\n\n═══ מה הוכח ═══\n  · כל הגארדים עברו: שתי השורות active ולא ממוזגות, מורנינג 2b73787f, ח.פ ריק ופנוי, payment_terms זהים, ספירות הממוזגת כפי שנמדדו, ה-pending_document במצב בטוח\n  · אפס הפניות ל-94b1949d בכל עמודת FK אל clients\n  · השורות שהועברו זהות מלבד client_id (וב-jobs due_date, שמחושב מחדש); שורות של לקוחות אחרים ולקוחות אחרים לא זזו\n  · הממוזגת לא מופיעה ברשימות status=active / merged_into is null / מורנינג / שם / ח.פ\n  · השם "גל אורן לרנר" הוחל על הנשארת, ואין שני normalized_name זהים\n\nעכשיו אפשר להריץ את supabase/migrations/0110_merge_gal_oren.sql';
  raise exception '%', v_msg;
end $dry$;
