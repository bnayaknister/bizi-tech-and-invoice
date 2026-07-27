-- 0043: reflect a CANCELLED deal invoice in the registry (owner spec — 52 of
-- 292 deal invoices are cancelled, e.g. #40285 ליעד הרמן/אוכלי סרטים, a price
-- mistake).
--
-- The system never cancels in Morning — the bookkeeper does that by hand there,
-- and the app only REFLECTS it. Marking a document cancelled hides it from the
-- normal registry views, reverts a linked job to its pre-invoice state (open
-- again), and is kept for the "cancelled" tab + history. cancelled_at is the
-- single source of truth for "cancelled" in our UI and is NEVER touched by the
-- daily pull (which only writes Morning's numeric `status`), so a local
-- cancellation survives every future sync regardless of timing.
alter table public.documents
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references public.profiles(id),
  add column if not exists cancel_reason text;
