-- 0063: a CANCELLED document no longer holds the one-live-row-per-production
-- slot, so a corrective document can be issued after the first was closed.
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$.
-- להרצה ידנית ב-SQL Editor בלבד — אין supabase db push.
--
-- HISTORY, because this is a restoration and not a new rule. 0025 wrote the
-- index as an ALLOW-list — status in ('pending','approved','issued') — and
-- 'cancelled' was simply not on it, so a cancelled document freed the slot.
-- 0047 inverted it to a DENY-list to close a real hole (an 'accrued' row was
-- invisible to the index, so a repeated 06:00 sync could double-queue), and
-- its comment names exactly what it meant to add: "this now covers accrued and
-- consolidated too. rejected/failed still allow a fresh attempt." 'cancelled'
-- is never mentioned. It became blocking as a side effect of the inversion.
--
-- The predicate 0047 chose for itself was "anything that isn't a dead end" —
-- and a cancelled document is a dead end by definition. This migration makes
-- the index say what that comment already said.
--
-- WHY IT CANNOT FAIL: the new predicate is STRICTLY NARROWER than the old one,
-- so it can only remove rows from the index, never add. Verified against live
-- data 2026-08-25: indexed rows 30 -> 26, duplicate keys 0 in both. The four
-- rows that leave are cancelled ones, and none of them shares a
-- (doc_type, production_id) with any surviving row.
--
-- DROP + CREATE inside one DO block = one transaction: there is no window in
-- which the uniqueness rule is absent. The table holds 40 rows, so the rebuild
-- is instant and CONCURRENTLY (which cannot run in a transaction) is not
-- wanted here.
--
-- NOT SUFFICIENT ON ITS OWN, and that is deliberate: an issued work order had
-- no path to 'cancelled' until the documents/[id]/cancel extension that ships
-- with it. Verified by simulation before this was written — with the row left
-- at 'issued' a corrective document is refused with 23505 regardless of this
-- index, and after the extension moves it to 'cancelled' the slot frees.

do $mig$
begin

drop index if exists pending_documents_one_live_per_production;
create unique index pending_documents_one_live_per_production
  on public.pending_documents (doc_type, production_id)
  where production_id is not null
    and status not in ('rejected', 'failed', 'cancelled');

insert into public.schema_ledger (version, applied_at, applied_by, note)
values ('0063', now(), 'bnaya',
        'cancelled הוחרג מ-pending_documents_one_live_per_production, כך שמסמך שבוטל משחרר את המקום ואפשר להנפיק מסמך מתקן. שחזור ולא כלל חדש: 0025 כתבה רשימת היתר (pending/approved/issued) שבה cancelled לא הופיע ולכן שחרר את המקום; 0047 הפכה לרשימת איסור כדי לסגור חור ב-accrued, וההערה שלה מונה במפורש רק accrued ו-consolidated — cancelled נכנס פנימה כנזק צדדי של ההיפוך. הפרדיקט צר יותר בהכרח ולכן לא ייתכן כשל ייחודיות: אומת על נתונים חיים 25.8, 30 שורות מאונדקסות -> 26, אפס מפתחות כפולים לפני ואחרי. DROP+CREATE בבלוק DO אחד = טרנזקציה אחת, בלי חלון ללא ייחודיות. לא מספיקה לבדה — הזמנה שהונפקה מגיעה ל-cancelled רק עם הרחבת documents/[id]/cancel ל-100 שנשלחת יחד איתה. אפס שינוי סכימה, אפס DELETE.');

  raise notice '0063 הוחלה ונרשמה. מסמך מבוטל משחרר את המקום להנפקה מתקנת.';

end $mig$;
