-- 0062: cancelling an episode that was already RECORDED is an admin decision.
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$,
-- גופי הפונקציות $fn$. להרצה ידנית ב-SQL Editor בלבד — אין supabase db push.
--
-- THE POLICY (owner 2026-08-25). Two cancellations look identical and are not:
--   • before the recording — the session did not happen, the client moved the
--     date, nothing was produced and (since 0061) no job exists. A scheduling
--     change. can_edit_stages: the technician is the person who knows.
--   • after the recording — the work was done, a job exists, a document may
--     already be issued. Cancelling is a decision to write off a debt, so it
--     is a MONEY decision. can_manage_users.
--
-- WHY A TRIGGER AND NOT JUST THE ROUTE. productions_update allows any column
-- to a can_edit_stages holder, and guard_production_stage_columns explicitly
-- admits every status move except client approval:
--     (new.status is distinct from old.status and new.status <> 'אושר_ע"י_לקוח')
--        -> requires only can_edit_stages
-- 'בוטל' falls in that branch. A check in cancel/route.ts alone would be
-- enforced only on that one path, and every other writer to productions —
-- /api/entity/[type]/[id] among them — would walk straight past it. The rule
-- has to live where the column does.
--
-- SHAPE IS THE TWIN of guard_client_approval_transition (the existing
-- permission-per-transition guard on this same table), deliberately: same
-- BEFORE UPDATE trigger, same `auth.uid() is not null` escape so a service
-- role write passes and the API route stays the authorized path, same style of
-- message. Nothing about the approval guard changes.
--
-- KEYED ON old.status — what the episode WAS before the cancellation, which is
-- the only thing that says whether work had been done. new.status is always
-- 'בוטל' here and carries no information.
--
-- NAMED LITERALLY, NEVER BY ORDER: 'בוטל' is the LAST value of
-- production_status, so a range test would treat an already-cancelled row as
-- "not yet recorded" and wave the transition through. The exempt statuses are
-- the same two the application constant NOT_YET_PERFORMED lists (0061,
-- lib/productions/status.ts) — one rule, stated in both places, never derived
-- differently.
--
-- Not retroactive: the 15 productions already cancelled are untouched. This
-- governs the next cancellation, not the previous ones.

do $mig$
begin

create or replace function public.guard_production_cancellation()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if new.status = 'בוטל'
     and old.status is distinct from 'בוטל'
     and old.status not in ('עתיד_להתחיל', 'בהקלטה') then
    if auth.uid() is not null and not public.can_manage_users() then
      raise exception 'ביטול פרק שהוקלט הוא החלטה כספית — נדרשת הרשאת אדמין';
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_guard_production_cancellation on public.productions;
create trigger trg_guard_production_cancellation
  before update of status on public.productions
  for each row execute function public.guard_production_cancellation();

insert into public.schema_ledger (version, applied_at, applied_by, note)
values ('0062', now(), 'bnaya',
        'ביטול פרק שהוקלט דורש can_manage_users; ביטול פרק שטרם הוקלט (עתיד_להתחיל / בהקלטה) נשאר can_edit_stages. הטריגר נדרש ולא רק בדיקה ב-route: productions_update מתירה כל עמודה ל-can_edit_stages, ו-guard_production_stage_columns מתירה במפורש כל מעבר סטטוס חוץ מאישור לקוח — כך שבוטל עבר עם הרשאת שלבים בלבד, וכל כותב אחר ל-productions (למשל entity/[type]/[id]) היה עוקף בדיקה שיושבת ב-route. הדפוס תאום ל-guard_client_approval_transition על אותה טבלה: BEFORE UPDATE, auth.uid() is not null כדי ש-service role יעבור וה-route יישאר המסלול המורשה. נבדק על old.status — מה שהפרק היה לפני הביטול, כי new.status תמיד בוטל ואינו נושא מידע. שני הסטטוסים הפטורים נקובים בשמן ולא בטווח, כי בוטל הוא הערך האחרון ב-production_status; אותם שניים שמופיעים ב-NOT_YET_PERFORMED (0061). לא רטרואקטיבי — 15 ההפקות שכבר בוטלו לא נגעו. אפס שינוי סכימה, אפס DELETE.');

  raise notice '0062 הוחלה ונרשמה. ביטול פרק שהוקלט דורש אדמין.';

end $mig$;
