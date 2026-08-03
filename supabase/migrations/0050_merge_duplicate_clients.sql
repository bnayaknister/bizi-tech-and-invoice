-- הורצה ידנית ב-SQL Editor, 3.8.2026. אין להריץ שוב.
-- מוגנת ע"י בדיקת schema_ledger בראש הבלוק.

do $$
declare n int;
begin
  if exists (select 1 from schema_ledger where version = '0050') then
    raise exception '0050 כבר הוחלה — הורצה ידנית ב-3.8.2026';
  end if;

  create temp table merge_map(drop_id uuid, keep_id uuid);
  insert into merge_map values
    ('cce45794-a213-4b68-b03d-2c4b81584dde','b827024d-cce3-4f59-a064-5531de9303b3'),
    ('538e32dd-58e7-4ac6-a254-16ac4aedac32','e9571ef4-ae03-45db-861d-6f3137c0f8d4'),
    ('11752549-223d-4c29-b212-691238da7358','261c0445-c013-4f87-9dc6-e82f8c7e9c30'),
    ('1cf9bf48-1b53-4fb3-8479-f69b41a804da','261c0445-c013-4f87-9dc6-e82f8c7e9c30'),
    ('09fc34e1-f0f2-4a17-83cc-7a3f89fbf30f','7e5d4b69-ff2e-413d-bfe3-fa3c37114212'),
    ('eb14ffb4-fb71-4dac-b8d2-8e2e30a2a848','9060e10f-06be-4079-b22c-53c63b6c1f53'),
    ('f235b0eb-2120-43d5-988b-cd55f24b321c','4f16e25e-152b-475e-981b-7372117b17f5'),
    ('daf6022e-54f7-498e-8a79-78ff84ed03bd','b42808ad-4e91-4951-bcff-23111644a88b');

  select count(*) into n from clients c join merge_map m on c.id = m.drop_id;
  if n <> 8 then raise exception 'שורות מיותמות: נמצאו %, צפויות 8', n; end if;

  select count(*) into n from clients c join merge_map m on c.id = m.keep_id;
  if n <> 8 then raise exception 'שורות זוכות: נמצאו %, צפויות 8', n; end if;

  update contracts         t set client_id = m.keep_id from merge_map m where t.client_id = m.drop_id;
  update documents         t set client_id = m.keep_id from merge_map m where t.client_id = m.drop_id;
  update invoices          t set client_id = m.keep_id from merge_map m where t.client_id = m.drop_id;
  update jobs              t set client_id = m.keep_id from merge_map m where t.client_id = m.drop_id;
  update pending_documents t set client_id = m.keep_id from merge_map m where t.client_id = m.drop_id;
  update productions       t set client_id = m.keep_id from merge_map m where t.client_id = m.drop_id;
  update shows             t set client_id = m.keep_id from merge_map m where t.client_id = m.drop_id;

  update clients c
     set name = '[מוזג] ' || c.name,
         morning_client_id = null
    from merge_map m
   where c.id = m.drop_id and c.name not like '[מוזג]%';

  insert into schema_ledger (version, applied_at, applied_by, note)
  values ('0050', now(), 'bnaya',
          'מיזוג 8 שורות clients כפולות ל-7 ישויות. כל שבע הטבלאות המצביעות. אפס מחיקות.');

  drop table merge_map;
end $$;
