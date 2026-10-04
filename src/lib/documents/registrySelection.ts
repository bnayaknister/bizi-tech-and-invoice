// The registry's bundling DECISIONS — which rows may be ticked, which door a
// ticked set goes out through, and what the request body is.
//
// ═══ WHY A MODULE, AND WHY NOW ═══
// All of this lived as closures inside RegistryClient, a 1,700-line "use
// client" component behind a provider, a fetch and a click — nothing about it
// is reachable from renderToString, so none of it was ever asserted. That was
// survivable while the rules were "has a queue row" and "two or more ticked".
// It stopped being survivable on 2026-10-04, when a pulled deal invoice became
// selectable: the selection is now keyed on a different column, the door is a
// property of the row rather than of the tab, and a mixed set has to be refused
// before it is sent. Three new rules on the path that mints tax documents.
//
// So the rules move here, where a test can hand them rows, and the component
// keeps exactly one job: drawing what they return. Same split as
// lib/productions/hours.ts — plain data, no Supabase, client-safe.
//
// ⚠️ EVERY FUNCTION HERE IS PURE. Nothing reads the DOM, the network or a
// module-level variable. If a rule needs the viewer's permission it takes it as
// an argument, so the only way to change an answer is to change an input.

/**
 * The fields the rules read, and nothing more.
 *
 * Structural on purpose: `DocRow` in RegistryClient has thirty-odd fields and
 * importing it here would make a client component this module's dependency —
 * backwards, and a circular import. Any object with these keys satisfies it, so
 * DocRow does, and so does a hand-built test row.
 */
export type SelectableRow = {
  id: string;
  /** Morning's own state, refreshed on every pull. null = never pulled. */
  status: number | null;
  /** 'pending' = a queue row exists · 'raw' = a pulled parent · null = neither */
  buildable: "pending" | "raw" | null;
  /** the queue row's id — null on a raw row */
  pending_id: string | null;
  /** the queue row's NET. Set on a pending row, null on a raw one. */
  pending_amount: number | null;
  /** the mapper's PROVEN net. Set on a raw row, null on a pending one. */
  net_amount: number | null;
  /** set only on a raw row the mapper judged above PULL_NET_CEILING */
  over_ceiling: { net: number; ceiling: number } | null;
  /** which children our allow-list permits on this parent */
  child_actions: ("deal_invoice" | "tax" | "receipt")[];
  /** a BUNDLED document's jobs — a consolidated 300 carries job_id null and these */
  has_live_deal_child?: boolean;
};

export type Openness = { open: boolean; label: string; tone: "open" | "closed" | "unknown" };

/**
 * Can this document still father a child?
 *
 * documents.status is Morning's own state, refreshed on every pull, and it is a
 * perfect predictor of the builder's openness gate — verified across 609
 * documents (owner 2026-08-09): status=0 always carries a ref containing BOTH
 * 305 and 320; status=1 and status=2 always carry an empty ref. So the screen
 * reads `status` and never `raw->'ref'`, which would mean hauling heavy jsonb
 * across a 5,000-row query to learn the same thing.
 *
 * The proportion is the point: only 23 of those 609 are open. Before this gate
 * the button lit on all of them, so it was mostly an invitation to a 409.
 *
 * null / anything unexpected = we have no state for it (an app-issued document
 * carries no status until the next pull — issue.ts never writes one). The
 * builder ALLOWS that case and flags it, so the button stays lit and the chip
 * says so rather than pretending to know.
 */
export function parentOpenness(status: number | null): Openness {
  // null = never pulled, so we genuinely do not know. Everything else Morning
  // gave us a state for.
  if (status === null || status === undefined) {
    return { open: true, label: "טרם נמשך ממורנינג", tone: "unknown" };
  }
  if (status === 0) return { open: true, label: "פתוח", tone: "open" };
  if (status === 1) return { open: false, label: "נסגר אוטומטית", tone: "closed" };
  if (status === 2) return { open: false, label: "נסגר ידנית", tone: "closed" };
  // Any OTHER code counts as closed, and that is deliberate. We met status=4 on
  // five 305s (2026-08-11) having only ever seen 0/1/2 — and its ref was empty,
  // exactly like 1 and 2. Treating an unrecognised code as "unknown" would light
  // the button on a document the builder is about to refuse; treating it as
  // closed matches every observation and fails safe. Only 0 has ever carried a
  // non-empty ref.
  return { open: false, label: "סגור", tone: "closed" };
}

export const OPENNESS_TITLE: Record<Openness["tone"], string> = {
  open: "פתוח במורנינג — אפשר להנפיק על סמכו מסמך מס",
  closed: "סגור במורנינג — כבר לא ניתן להנפיק על סמכו",
  unknown: "המסמך טרם נמשך ממורנינג, ולכן מצבו אינו ידוע. אפשר לנסות — הבדיקה תיעשה בשרת.",
};

/**
 * The NET this row contributes to a bundled child — whichever door it came by.
 *
 * TWO COLUMNS, ONE QUESTION, and they are mutually exclusive by construction
 * (registry/page.tsx's buildState): a `pending` row carries `pending_amount`
 * (the queue row's net) with `net_amount` null, and a `raw` row carries
 * `net_amount` (the mapper's PROVEN net) with `pending_amount` null. Reading
 * only the first was correct while raw rows could not be selected; now that
 * they can, it would print "—" over a bundle whose amount the server knows
 * perfectly well.
 *
 * ⚠️ NEVER `amount`. That is the printed GROSS, and substituting it here would
 * be a bigger number wearing the net's label.
 */
export const bundleNet = (r: SelectableRow): number | null => r.pending_amount ?? r.net_amount;

/**
 * Σ of the source rows' net amounts — the figure the bundled child will carry.
 *
 * ALL-OR-NOTHING: one missing net returns null, and the screen renders that as
 * "—". Skipping the row instead would print a total short by exactly the line
 * nobody can see, on a screen whose whole job is to say what is about to be
 * issued.
 *
 * Close to unreachable: a selectable row has a queue row or a mapped raw by
 * definition, and createTaxFromParents refuses a source with no amount before
 * it builds anything. So "—" previews a refusal rather than hiding one.
 */
export const sumSourceNet = (rows: SelectableRow[]): number | null =>
  rows.some((r) => bundleNet(r) === null)
    ? null
    : rows.reduce((s, r) => s + (bundleNet(r) ?? 0), 0);

/**
 * May this row join a bundled TAX document?
 *
 * The conditions are the single-row "צור חשבונית מס" button's own — `buildable`,
 * openness, a tax child in the allow-list — PLUS the ceiling, and nothing else.
 *
 * ═══ WHY RAW ROWS ARE IN, AS OF 2026-10-04 ═══
 * They used to be excluded, and the reason was true at the time: a raw row
 * travels as `documentIds`, which /api/documents/tax capped at ONE, so a
 * checkbox on it could only ever produce a 400 — and a control that cannot work
 * is worse than a control that is not there.
 *
 * The owner lifted that cap (כפיר ארביב אחזקות: 40283 + 40289, both pulled,
 * ₪590 each, one client, one debt, and no way to send the client ONE tax
 * invoice). The builder never needed changing: fetchPullSources has taken an
 * array since it was written, and taxFromParent.ts:246-253 says the merged
 * gates "were written for exactly this merge". The cap went; this predicate
 * followed it.
 *
 * ═══ THE CEILING IS THE ONE CONDITION THAT IS NOT THE BUTTON'S ═══
 * `over_ceiling` is set exclusively on a raw row and it stays OUT of bundles —
 * owner decision, not a limitation. The admin handshake that clears it is built
 * around ONE document: it mints and verifies a ticket bound to `documentIds[0]`,
 * and in a bundle that index names an arbitrary member rather than the one over
 * the ceiling. Widening the handshake to N was deferred; excluding the row is
 * what keeps the two paths honest, and the route refuses the same combination
 * server-side so this is the first of two gates, never the only one.
 */
export const taxSelectable = (r: SelectableRow, canPull: boolean): boolean =>
  canPull &&
  !!r.buildable &&
  (r.buildable === "pending" ? !!r.pending_id : true) &&
  r.over_ceiling == null &&
  r.child_actions.includes("tax") &&
  parentOpenness(r.status).open;

/**
 * May this work order join a bundled DEAL invoice?
 *
 * The single-row button's own condition, and nothing more — one predicate, two
 * readers.
 *
 * `buildable` is deliberately ABSENT, unlike taxSelectable: it is the tax
 * path's verdict (mapper state, net ceiling) and says nothing about this
 * builder, which is keyed on a queue row instead. A checkbox that asked for it
 * would hide exactly the orders this feature exists to fold: 10303/10304/10305
 * are `buildable: null` (no tax child is offered on a work order with no job
 * stamped yet) while their deal-invoice button is live.
 *
 * `has_live_deal_child` is the idempotency half, added 2026-09-08 after the
 * owner bundled three orders and — seeing nothing change, because nothing on
 * these rows CAN change until the child is issued and pulled — clicked twice
 * more into two 409s. A tick offered on work already billed is the screen
 * promising what the server will refuse. The server gate stays where it is;
 * this is the first of two, not a replacement for it.
 */
export const dealSelectable = (r: SelectableRow, canPull: boolean): boolean =>
  canPull &&
  !!r.pending_id &&
  r.child_actions.includes("deal_invoice") &&
  !r.has_live_deal_child &&
  parentOpenness(r.status).open;

/**
 * Which door a selected row will be SENT through.
 *
 * `pending` → the queue row, as `sourceIds`. `raw` → the pulled document, as
 * `documentIds`. The two cannot be mixed in one request — the route refuses it
 * outright, because one child cannot inherit from a payload we SENT and a
 * payload we RECONSTRUCTED from a pull at the same time.
 *
 * Derived from `buildable` and nothing else, so it is the SAME question
 * `bundleRequestBody` asks when it picks a branch. Two spellings of "which
 * door" is how a tick ends up being sent through the other one.
 */
export type BundleDoor = "pending" | "raw";
export const doorOf = (r: SelectableRow): BundleDoor => (r.buildable === "raw" ? "raw" : "pending");

/**
 * Does this selection span both doors?
 *
 * Blocked in the SCREEN rather than discovered as a 400: the ticks are each
 * legal on their own and only the combination is not, so the sentence has to
 * appear where the combination was made. The route refuses it too — this is the
 * first of two gates.
 *
 * Fewer than two rows is never mixed, which also means the single-row path can
 * never be blocked by this rule.
 */
export const isMixedSelection = (rows: SelectableRow[]): boolean =>
  new Set(rows.map(doorOf)).size > 1;

/**
 * The request body for ONE child document built from N source rows.
 *
 * ONE function so that "which door" is asked once. `rows[0]` decides for the
 * whole set, which is safe because the set is HOMOGENEOUS by construction
 * (`isMixedSelection` disables the button, and the route refuses the mixture
 * anyway). If a mixed set ever did reach here it would be refused at the door
 * rather than half-sent — the right failure.
 *
 * Both branches map over ALL rows. The raw branch used to be a single id
 * because a bundle could never hold more than one pulled parent; since
 * 2026-10-04 it can. With one row either branch produces the same
 * single-element array it always did, byte for byte.
 *
 * A `pending` row whose `pending_id` is somehow null would send a null inside
 * `sourceIds` and be refused by the builder's partial-set gate ("נמצאו N מסמכי
 * מקור מתוך M"). Unreachable — taxSelectable and dealSelectable both require
 * it — and a refusal rather than a silent short set if it ever is.
 */
export function bundleRequestBody(
  rows: SelectableRow[]
): { sourceIds: (string | null)[] } | { documentIds: string[] } {
  if (!rows.length) return { sourceIds: [] };
  return doorOf(rows[0]) === "raw"
    ? { documentIds: rows.map((r) => r.id) }
    : { sourceIds: rows.map((r) => r.pending_id) };
}
