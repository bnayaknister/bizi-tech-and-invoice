import { ALLOWED_CHILDREN } from "@/lib/documents/taxFromParent";
import { parentOpenness } from "@/lib/documents/registrySelection";
import { MORNING_DOC_CODE, registryTabForType, type PendingDocType } from "@/lib/morning/types";
import type { Cadence } from "@/lib/projects/stuck";
import type { RowSource } from "@/lib/projects/unified";

// ═══════════════════════════════════════════════════════════════════════════
// "Is this empty document cell a shortcut, and to where?" — E10, one pure
// function, no I/O. Every decision of 7.10 lives here and nowhere else.
// ═══════════════════════════════════════════════════════════════════════════
//
// 🔴 THE CELL IS A SHORTCUT TO THE SAME DOOR, NOT A SECOND DOOR — and the
// shape of this module is what enforces that. It returns an `href`, never an
// action: a click NAVIGATES to the registry row whose own button already
// exists, with every server-side guard it has always run (`buildable`,
// `build_block`, `has_live_deal_child`, the cadence brake, the duplicate
// guard). Nothing here issues, queues or decides anything about a document.
//
// ⚠️ AND THAT IS WHY THE CADENCE BRAKE CANNOT BE BYPASSED FROM HERE, no
// matter what this function returns: /projects never calls a creation route.
// The accrual rule below is therefore about not INVITING a click that the
// door would refuse — honesty, not safety. (links.ts:728-775 keeps owning
// safety, exactly as it did before this feature existed.)
//
// ═══ WHAT IS REUSED RATHER THAN RESTATED ═══
//   · `ALLOWED_CHILDREN` (taxFromParent.ts) — which document may father
//     which. NOT re-listed here: the rungs are declared in one place, and a
//     second copy is a second opinion waiting to drift.
//   · `parentOpenness` (registrySelection.ts:70) — only an OPEN parent may
//     bear a child, including its own treatment of `null`.
//   · `registryTabForType` (morning/types.ts) — which registry tab a
//     document lives in.
//
// ⚠️ `parentOpenness(null)` RETURNS `open: true` ("טרם נמשך ממורנינג"), and
// this function follows it rather than the "only status === 0" paraphrase in
// E10's own text. The difference is not academic: a document this app just
// issued carries no status until the next pull, so the stricter reading would
// darken exactly the freshest cells — and would disagree with the registry
// button sitting on the same document. One anchor, one answer.

/** One document already on the row, as this decision needs it. */
export type CellDoc = {
  type: number;
  /** Morning's own number — what the registry's search box matches on. */
  number: string | null;
  /**
   * Morning's document status. `null` = never pulled, which `parentOpenness`
   * treats as open-but-unknown; see the header note.
   */
  status: number | null;
  cancelled: boolean;
};

export type EmptyCellInput = {
  source: RowSource;
  /** the column this cell sits in — one of DOC_TYPES (100/300/305/320/400) */
  docType: number;
  /** every document on the row, cancelled ones included */
  docs: CellDoc[];
  /** the client's billing cadence. Null on every source that has no rhythm. */
  cadence: Cadence;
};

export type EmptyCellDecision = {
  /** cursor + hover ring, and a click that goes somewhere useful */
  active: boolean;
  /** the cell's `title`. Null only when there is genuinely nothing to say. */
  reason: string | null;
  /** where a click goes. Null = not clickable at all. */
  href: string | null;
};

const INERT: EmptyCellDecision = { active: false, reason: null, href: null };

/** The redemption screen — where an accruing client's bundle is actually released. */
const REDEMPTION_HREF = "/documents/accrued";
const CONTRACTS_HREF = "/contracts";

/**
 * Which document type fathers which cell, per E10's declared scope.
 *
 * ⚠️ NARROWER THAN `ALLOWED_CHILDREN` ON PURPOSE, and the gap is reported
 * rather than closed here: the allow-list also lets a work order father a
 * 305/320 DIRECTLY (taxFromParent.ts:83-86), and the registry does offer
 * that button. E10's scope names only 300←100, 305/320←300 and 400←305, so
 * that is what this table says. Widening it is a scope decision, not a code
 * detail, so it is left alone.
 */
const PARENT_OF: Record<number, number> = {
  [MORNING_DOC_CODE.deal_invoice]: MORNING_DOC_CODE.order, // 300 ← 100
  [MORNING_DOC_CODE.tax_invoice]: MORNING_DOC_CODE.deal_invoice, // 305 ← 300
  [MORNING_DOC_CODE.tax_receipt]: MORNING_DOC_CODE.deal_invoice, // 320 ← 300
  [MORNING_DOC_CODE.receipt]: MORNING_DOC_CODE.tax_invoice, // 400 ← 305, never ← 320
};

/** Morning's numeric type -> the `PendingDocType` key `ALLOWED_CHILDREN` is indexed by. */
const PENDING_TYPE_OF: Record<number, PendingDocType> = {
  [MORNING_DOC_CODE.order]: "work_order",
  [MORNING_DOC_CODE.deal_invoice]: "deal_invoice",
  [MORNING_DOC_CODE.tax_invoice]: "tax_invoice",
  [MORNING_DOC_CODE.tax_receipt]: "tax_receipt",
};

/** The registry row this parent sits on — the door itself. */
function registryHref(parent: CellDoc): string {
  const tab = registryTabForType(parent.type);
  return `/documents/registry?tab=${encodeURIComponent(tab)}&q=${encodeURIComponent(parent.number ?? "")}`;
}

/** Is this child an allowed AND implemented child of that parent, per the one allow-list? */
function rungAllows(parentType: number, childType: number): boolean {
  const parentKey = PENDING_TYPE_OF[parentType];
  if (!parentKey) return false;
  return (ALLOWED_CHILDREN[parentKey] ?? []).some((r) => r.code === childType && r.implemented);
}

/**
 * The whole decision, in the order the decisions were made. ORDER IS THE
 * RULE: an accruing 300 is inactive even when its work order is wide open,
 * and a 100 is inactive even on a row where everything else lines up.
 */
export function emptyCellAction(input: EmptyCellInput): EmptyCellDecision {
  const { source, docType, docs, cadence } = input;

  // The cell is only empty if nothing live of this type sits in it. A
  // cancelled document is information, not occupancy (the row renders it
  // struck through), so it does not make the cell non-empty — but it also
  // cannot be anybody's parent, which the parent search below enforces.
  if (docs.some((d) => d.type === docType && !d.cancelled)) return INERT;

  // ── decision 3 — a row with no work order is an exception, never an offer ──
  // 100 is the head of the chain and has no parent to be raised from. Every
  // row in this table is supposed to already hold one, so an empty 100 is a
  // fact to surface, not an action to invite.
  if (docType === MORNING_DOC_CODE.order) {
    return { active: false, reason: "חסרה הזמנת עבודה — חריג", href: null };
  }

  // ── milestone rows — the door is elsewhere, and targeting it would be new ──
  // A contract milestone is billed through the contract routes, and the button
  // that does it lives per-milestone on /contracts. The unified row carries no
  // milestone id to aim at, so a cell here cannot point at the milestone
  // itself without new plumbing — and building a new path is exactly what
  // this feature may not do. Inactive, and the reason names where to go.
  if (source === "milestone") {
    return {
      active: false,
      reason: "אבן דרך מחויבת ממסך החוזים, לפי אבן הדרך עצמה",
      href: CONTRACTS_HREF,
    };
  }

  // ── decision 1 — an accruing client is not missing a document ─────────────
  // A 300 for a monthly / every_n client is not absent, it is WAITING for the
  // redemption that releases the whole bundle. Offering "create it now" here
  // would be inviting a click the door refuses, and pointing at the wrong
  // screen while doing it.
  if (docType === MORNING_DOC_CODE.deal_invoice && (cadence === "monthly" || cadence === "every_n")) {
    return {
      active: false,
      reason:
        cadence === "monthly"
          ? "לקוח בחיוב חודשי — חשבון העסקה ייצא בפדיון בסוף החודש, ממסך הפדיון"
          : "לקוח בחיוב מצטבר — חשבון העסקה ייצא כשהאגד יתמלא, ממסך הפדיון",
      href: REDEMPTION_HREF,
    };
  }

  const parentType = PARENT_OF[docType];
  if (!parentType) return INERT;

  // A cancelled parent is not a parent. Nothing can be raised on it, and the
  // registry would refuse — so the cell says why instead of inviting a 409.
  const candidates = docs.filter((d) => d.type === parentType && !d.cancelled);
  if (candidates.length === 0) {
    return { active: false, reason: "אין מסמך אב ברשימה שאפשר להנפיק על סמכו", href: null };
  }

  const open = candidates.filter((d) => parentOpenness(d.status).open);

  // ── every candidate parent is closed ─────────────────────────────────────
  // `parentOpenness`'s own sentence, verbatim — the registry shows the same
  // one on the same document, and paraphrasing it here would make two screens
  // disagree about one fact.
  if (open.length === 0) {
    const label = parentOpenness(candidates[0].status).label;
    return { active: false, reason: `המסמך האב ${label} במורנינג — לא ניתן להנפיק על סמכו`, href: null };
  }

  // ── decision 2 — more than one open parent: no picker, no bundling here ───
  // Two open work orders on one job is a real state, and choosing between
  // them (or bundling them) is the registry's job: it already has the
  // selection bar and the bundled button. A cell that picked one silently
  // would bill one order and lock the correct path behind a rejection — which
  // is the measured failure of 17.9, in the registry's own notes.
  if (open.length > 1) {
    return {
      active: false,
      reason: `יש ${open.length} מסמכי אב פתוחים — להנפיק מאוגד ממסך הרג'יסטרי`,
      href: `/documents/registry?tab=${encodeURIComponent(registryTabForType(parentType))}`,
    };
  }

  const parent = open[0];

  // The rung itself, from the one allow-list. Belt to the braces of PARENT_OF:
  // if the two ever disagree, the allow-list wins and the cell goes dark.
  if (!rungAllows(parent.type, docType)) return INERT;

  // The registry finds a row by its NUMBER. An app-issued document carries one
  // from the moment Morning answers, so this is rare — but a link that lands
  // on an unfiltered tab is not a shortcut, and saying so beats pretending.
  if (!parent.number) {
    return {
      active: false,
      reason: "למסמך האב עוד אין מספר ממורנינג — לא ניתן לאתר אותו ברג'יסטרי",
      href: null,
    };
  }

  return {
    active: true,
    reason: `להנפקה על סמך ${parent.number} — נפתח ברג'יסטרי`,
    href: registryHref(parent),
  };
}
