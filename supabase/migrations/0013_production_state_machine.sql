-- 0013: v3 production state machine + on_hold detail (screens-spec §1, §0.ב).
--
-- The kanban has 9 columns and status is drag-driven, so status DECOUPLES
-- from stage-derivation: the 6 stages become granular per-step tracking
-- (the work tab), and the technician moves the card between phases.
--
-- The billing automation is untouched: approval into 'אושר_ע"י_לקוח' still
-- fires the job via trg_on_production_approved, and moving into it still
-- requires can_edit_money via trg_guard_client_approval. Every other move
-- requires can_edit_stages via trg_guard_production_stages (0010).

-- 1. rename the base state, then extend to the full 9-state machine.
--    (RENAME VALUE auto-updates the column default and all rows.)
alter type production_status rename value 'ממתין_להתחלה' to 'עתיד_להתחיל';
alter type production_status add value if not exists 'בהקלטה' after 'עתיד_להתחיל';
alter type production_status add value if not exists 'ממתין_לתגובת_לקוח' after 'נשלח_ללקוח';
alter type production_status add value if not exists 'הופץ' after 'אושר_ע"י_לקוח';

-- 2. on_hold is a flag, not a status (§0.ב): a production can be
--    "בעריכה + מוקפאת" and return exactly where it was. Keep who/why/when.
alter table public.productions
  add column if not exists on_hold_reason text,
  add column if not exists on_hold_since timestamptz,
  add column if not exists on_hold_by uuid references public.profiles(id),
  add column if not exists needs_attention boolean not null default false;

-- 3. decouple status from stage-derivation. Drop the trigger + function;
--    the kanban is now the source of status. Stages stay as-is (work tab).
drop trigger if exists trg_derive_production_status on public.stages;
drop function if exists public.derive_production_status();
