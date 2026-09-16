-- 0087 — שאילתת אימות. קריאה בלבד, אפס כתיבה. להריץ אחרי החלת 0087.
--
-- כל שורה כאן היא אחד הקנרי שהמיגרציה כבר בדקה בתוך הבלוק. הקובץ הזה קיים
-- כדי שהבעלים יוכל לראות את אותם מספרים בעיניו, בלי להאמין להודעת NOTICE
-- שאולי לא הודפסה.
--
-- מה צריך להתקבל:
--   ledger_0087        = 1
--   paid_no_tax        = 0        (היה 7)
--   amount_missing     = 0
--   doc_60171 n=6  Σ=4200
--   doc_60178 n=3  Σ=1500
--   doc_60183 n=3  Σ=1800
--   new_jobs           = 3 שורות, כל אחת עם paid='כן' ו-invoice_tax מלא
--   invoices_0087      = 3 שורות, job_id ריק, סכומים 4200/1500/1800
--   invoices_mismatch  = 0
--   debt_to_collect    = 91050   (היה 91450 — רק 5260f872 יצאה מהחוב)

select
  (select count(*) from public.schema_ledger where version = '0087') as ledger_0087,

  (select count(*) from public.jobs
    where dismissed = false and paid = 'כן'
      and (invoice_tax is null or btrim(invoice_tax) = '')) as paid_no_tax,

  (select count(*) from public.jobs
    where dismissed = false and amount is null) as amount_missing,

  (select json_agg(x order by x->>'doc')
     from (
       select json_build_object(
                'doc', d.morning_doc_number,
                'net', (d.raw->>'amountExcludeVat')::numeric,
                'n_jobs', count(j.id),
                'sum_jobs', coalesce(sum(j.amount), 0),
                'all_tagged', bool_and(j.invoice_tax = d.morning_doc_number)) as x
         from public.documents d
         cross join lateral unnest(d.bundle_job_ids) as b(jid)
         join public.jobs j on j.id = b.jid
        where d.morning_doc_number in ('60171','60178','60183')
        group by d.morning_doc_number, d.raw
     ) s) as bundles,

  (select json_agg(json_build_object(
            'job', left(j.id::text, 8), 'client', c.name, 'date', j.date,
            'campaign', j.campaign, 'amount', j.amount, 'paid', j.paid,
            'invoice_tax', j.invoice_tax, 'legacy', j.legacy, 'due_date', j.due_date)
          order by j.date)
     from public.jobs j left join public.clients c on c.id = j.client_id
    where j.notes like 'נוצר 16.9 — כיסוי%') as new_jobs,

  (select json_agg(json_build_object(
            'doc_number', i.doc_number, 'type', i.type::text, 'amount', i.amount,
            'job_id', i.job_id, 'source', i.source::text, 'issued_at', i.issued_at)
          order by i.doc_number)
     from public.invoices i
    where i.doc_number in ('60171','60178','60183')) as invoices_0087,

  (select count(*)
     from public.invoices i
     join public.documents d on d.morning_doc_id = i.morning_doc_id
    where i.job_id is distinct from d.job_id) as invoices_mismatch,

  (select coalesce(sum(amount), 0) from public.jobs
    where dismissed = false and paid = 'לא') as debt_to_collect,

  (select json_build_object(
            'neta_paid', (select paid::text from public.jobs
                           where id = 'e9eb2d91-47be-427b-8097-0fd1080e7a6f'),
            'liad_dup_dismissed', (select dismissed from public.jobs
                           where id = '2e651251-a826-4b20-9d86-bdd351a3e97c'),
            'restored', (select count(*) from public.jobs
                          where id in ('4ccf3682-9f1c-46e1-b809-7601c7151669',
                                       'e1cb88cc-1882-4db4-be8e-375ac7b73802',
                                       '8394b49f-27ac-462f-847b-e0a6e4bb19ae')
                            and dismissed = false and paid = 'כן')) as spot_checks,

  (select json_agg(json_build_object('event', t, 'n', n) order by t)
     from (select event_type t, count(*) n from public.events
            where payload->>'via' in ('0087', '0087_backfill')
            group by event_type) e) as events_0087;
