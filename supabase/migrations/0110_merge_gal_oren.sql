-- ============================================================================
-- 0110 — P26: מיזוג "גל אורן לרנר" (94b1949d) אל "גל אורן" (3f010d05).
--
-- ═══ ההכרעות (הבעלים, 11.10) ═══
--   · שתי השורות הן אותו עסק (P26). השורה שנשארת: 3f010d05.
--   · באותה מיגרציה שמה משתנה ל"גל אורן לרנר" — השם שמורנינג שולח במסמכים
--     (morning_client_name של 39 המסמכים שלה).
--   · ח.פ במורנינג 540279502 נכתב עליה אחרי המיזוג.
--
-- ═══ המדידה (שאילתת הספירה של הבעלים, 11.10) ═══
--   נשארת 3f010d05: documents 39 · jobs 1 · invoices 3 · client_morning_ids 1
--   ממוזגת 94b1949d: jobs 6 · invoices 9 · pending_documents 1 · client_morning_ids 1
--   לשתיהן morning_client_id = 2b73787f-…; tax_id ריק; client_registrations 0.
-- הספירות של השורה הממוזגת הן **גארד**: היא רדומה, ולכן כל שינוי בהן מאז
-- המדידה הוא סיבה לעצור ולמדוד שוב.
--
-- ═══ הסדר — וכל שלב מנומק ═══
--   1. morning_client_id של הממוזגת → null. הטריגר של 0094
--      (sync_primary_morning_id) מוריד את שורת ה-client_morning_ids שלה
--      מראשי. CHECK clients_merged_row_unmapped (0051) דורש את זה לפני
--      merged_into.
--   2. מחיקת שורת ה-client_morning_ids של הממוזגת. היא אינה עוברת: לנשארת
--      כבר יש שורה עם אותו מזהה, והמפתח הוא (client_id, morning_client_id).
--      הטריגר trg_client_morning_ids_not_merged היה דוחה אותה ממילא אחרי
--      שלב 4.
--   3. העברת client_id בתשע הטבלאות האחרות (client_registrations בשתי
--      עמודות). booking_contacts נעים עם shows. events נשאר על המזהה הישן —
--      היסטוריה, אין FK.
--      ⚠️ jobs: trg_compute_due_date יורה על client_id ומחשב due_date לפי
--      payment_terms של הנשארת. לכן הגארד דורש payment_terms זהים, ו-
--      billing_cadence/billing_every_n זהים (שורת התור עוברת לנשארת).
--      הגארדים guard_*_money_columns שואלים can_edit_money(), שמחזיר NULL
--      בלי סשן — ולכן אינם חוסמים ב-SQL Editor, כמו ב-0050.
--   4. שחרור השם: הממוזגת מקבלת name='[מוזג] …' (המוסכמה של 0050) ו-
--      normalized_name='merged:<id>' — ייחודי בהגדרה — ובאותו UPDATE
--      merged_into=3f010d05 ו-status='merged' (0109).
--   5. רק אחרי שהשם שוחרר: הנשארת → name='גל אורן לרנר',
--      normalized_name='גלאורןלרנר' (normalizeClientName: בלי ניקוד, בלי
--      רווחים, lowercase), tax_id='540279502'.
--   6. canary: אפס שורות מצביעות על 94b1949d — לא ברשימה ידנית בלבד אלא בכל
--      עמודת FK אל clients(id) שקיימת בקטלוג, כך שטבלה שתתווסף ותישכח תעצור
--      את ההחלה.
--
-- ═══ גארד ה-pending_document (שלב 0 בדוח) ═══
-- הנפקה קוראת את שורת התור, פונה למורנינג ואז כותבת documents עם
-- row.client_id שנקרא **לפני** הקריאה. אם 0110 רצה בתוך החלון הזה, שורת
-- documents חדשה תיכתב עם המזהה הישן אחרי שה-canary כבר עבר. לכן עוצרים אם:
--   · status='approved' — או הנפקה בעיצומה, או הנפקה שקרסה באמצע ושלא ידוע
--     אם הגיעה למורנינג;
--   · יש morning_call_started ב-30 הדקות האחרונות.
-- מצבים בטוחים: pending · accrued · failed (בלי קריאה טרייה) · rejected ·
-- cancelled · issued · consolidated.
--
-- תלות: 0109 (הערך 'merged'). אין עמודה חדשה — אין צורך ב-gen types.
-- סדר: supabase/verify/0110_dryrun.sql → הקובץ הזה → supabase/verify/0110_verify.sql
-- ============================================================================

do $mig$
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
begin
  -- >>> BODY
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
  -- <<< BODY

  raise notice '✅ 0110: המיזוג הוחל. %', v_moved::text;
end $mig$;
