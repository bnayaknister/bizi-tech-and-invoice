-- 0046: commit the two new pending_documents lifecycle states — ON THEIR OWN.
--
-- PostgreSQL forbids USING a freshly-added enum value in the same transaction
-- that added it (ERROR 55P04: unsafe use of new value). 0047 references
-- 'accrued' in a partial index, so the ADD VALUE must land and commit first.
--
-- RUN ORDER: 0046 first, then 0047. Both are idempotent.
--
--   'accrued'      — a work order frozen by a client's billing_cadence
--                    (monthly / every_n): owed, but deliberately not issued
--                    until the bookkeeper redeems the client.
--   'consolidated' — a per-episode row folded into a bundle document at
--                    redemption (kept for audit, never re-issued).
alter type pending_doc_status add value if not exists 'accrued';
alter type pending_doc_status add value if not exists 'consolidated';
