/**
 * What the operator is told when a client edit reaches Morning and Morning
 * says no.
 *
 * ═══ 🔴 TWO FAILURES THAT MUST NOT READ THE SAME ═══
 * Policy, owner 2026-08-23: local is the source of truth and Morning is a sync
 * target, so a Morning failure is REPORTED and the local write is kept. That
 * makes the honest sentence depend on whether there WAS a local write:
 *
 *  · a `name` edit writes `clients.name` and then pushes. Morning fails →
 *    half the job is done, and the retry is only the Morning half.
 *  · a MORNING-ONLY edit (emails / phone / contactPerson / taxId) has no
 *    column to write — the route performs no local write at all. Morning fails
 *    → NOTHING changed anywhere, and the retry is the whole job.
 *
 * The route used to send the first sentence for both, telling an operator who
 * had just failed to set a ח.פ that "השינוי נשמר אצלנו". That invites them to
 * stop, believing something was saved, when the field is still at its old
 * value in the only system that holds it. The owner's approved wording for the
 * ח.פ case says the opposite in so many words, which is what surfaced it.
 *
 * `localWriteHappened` is NOT a judgement this function makes — the route
 * passes `localKeys.length > 0`, the same list it used to decide whether to run
 * the UPDATE. So the sentence and the write are driven by one fact.
 */
export function morningFailureMessage(morningError: string, localWriteHappened: boolean): string {
  return localWriteHappened
    ? `השינוי נשמר אצלנו, אך עדכון מורנינג נכשל: ${morningError}. הלקוח אינו מסונכרן — נסי לעדכן שוב.`
    : `העדכון במורנינג נכשל — ${morningError}. לא בוצע שום שינוי.`;
}
