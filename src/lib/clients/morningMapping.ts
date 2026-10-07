/**
 * The Morning-mapping wording, in one place.
 *
 * 🔴 WHY THIS IS A FILE AND NOT STRINGS IN THE COMPONENT: changing which
 * Morning card a client is mapped to changes which card every FUTURE document
 * is issued on. That is the single most consequential thing the clients screen
 * can do, and the owner approved the exact sentences for it (7.10). A constant
 * can be asserted verbatim by the suite; a template literal buried in JSX gets
 * reworded by the next person who touches the layout.
 *
 * The strings live here rather than in the component for the same reason
 * TAX_ID_INVALID does: the test counts them, so a reword is a failing build
 * rather than a surprise in production.
 */

export const MAPPING_TITLE = "שינוי כרטיס הלקוח במורנינג";
export const MAPPING_CONFIRM = "שינוי הכרטיס";
export const MAPPING_CANCEL = "ביטול";
export const MAPPING_UNCHANGED = "מסמכים שכבר הונפקו לא משתנים.";

/**
 * The body of the confirmation window.
 *
 * TWO SHAPES, and the difference is the owner's (7.10 §3 vs §4):
 *  · REPLACING a mapping names both cards — "…ייצאו על X במקום Y" — and adds
 *    the line about documents already issued, because there ARE some and the
 *    operator is right to wonder whether they move. They do not.
 *  · A FIRST mapping has no "instead of": there is no previous card, and
 *    writing "במקום —" or leaving a blank would invite the operator to read a
 *    replacement that is not happening.
 */
export function mappingBody(toName: string, fromName: string | null): string {
  return fromName
    ? `מסמכים שיונפקו מכאן והלאה ייצאו על ${toName} במקום ${fromName}. ${MAPPING_UNCHANGED}`
    : `מסמכים שיונפקו מכאן והלאה ייצאו על ${toName}.`;
}

/**
 * What the operator is told when the mapping write fails.
 *
 * "לא בוצע שום שינוי" is a CLAIM, and it is true by construction: POST
 * /api/morning/clients does one `update` and writes its event only after it
 * succeeds, so a 400/409/network failure leaves `clients.morning_client_id`
 * exactly as it was. Nothing local is painted before the response either — the
 * card re-reads from the server rather than guessing.
 */
export function mappingFailure(error: string): string {
  return `השינוי נכשל — ${error}. לא בוצע שום שינוי.`;
}

/** the card's own labels — the approved "not mapped" string is shared with the list */
export const MAPPING_LABEL = "כרטיס במורנינג";
export const MAPPING_REPLACE = "החלפת כרטיס";
export const MAPPING_ASSIGN = "שיוך";
export const MAPPING_CREATE = "יצירת לקוח חדש במורנינג";
export const MAPPING_SEARCH = "חיפוש בכרטיסי מורנינג";
export const MAPPING_NO_RESULTS = "אין כרטיס מתאים.";
