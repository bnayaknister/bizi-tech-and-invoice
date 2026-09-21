/**
 * Renders the payment approval list and its confirm dialog in each real state,
 * and against DELIBERATELY BROKEN payloads, and asserts they do not throw.
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_payment_approval_render.tsx
 * Reads nothing, writes nothing, needs no dev server, touches no database.
 *
 * ═══ WHY ═══
 * Same argument as test_record_billed_render.tsx and test_projects_render.tsx.
 * An HTTP suite that greps the /documents/gaps HTML proves the SERVER
 * rendered — it says nothing about whether this block can mount, and every
 * value in it arrives from /api/finance/payment-matches at runtime, after the
 * server component has already finished. A version skew between the route and
 * the bundle looks from inside the component exactly like a field that is
 * suddenly null, so each one is knocked out below.
 *
 * The bodies take props rather than owning their state precisely so this file
 * can reach them: renderToString never runs an effect, and the container
 * fetches its own rows, so the container alone could only ever be tested in
 * its loading state — and the confirm dialog, the one thing here that can move
 * money, would be unreachable behind `useState`.
 *
 * ⚠️ WHAT THIS DOES NOT PROVE. renderToString runs no effects and dispatches no
 * events: it cannot show that the button opens the dialog, that the dialog
 * posts, or that a refusal lands in the right row. Those are asserted server
 * side by test_payment_approval.py and otherwise need a human. Listed in the
 * report rather than implied to be covered.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import {
  PaymentApprovalBody,
  PaymentConfirmBody,
  refusalText,
  type PaymentMatch,
} from "../src/app/documents/gaps/PaymentApprovalSection";

let failures = 0;
const check = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    console.log(`  FAIL  ${label} — ${(e as Error).message}`);
    failures++;
  }
};
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const noop = () => {};
const row = (over: Partial<PaymentMatch> = {}): PaymentMatch => ({
  docId: "doc-1",
  jobId: "job-1",
  docNumber: "60160",
  docType: 320,
  docTypeLabel: "מס / קבלה",
  docAmount: 1416,
  docDate: "2026-06-23",
  clientName: "סבטלנה ניקסון",
  jobLabel: "סבטלנה ניקסון · אסתטיטוקס · פרק 4",
  jobAmount: 1200,
  jobDate: "2026-08-16",
  dateGapDays: 54,
  amountBasis: "vat",
  amountBasisLabel: "סכום מדויק כולל מע״מ",
  fingerprint: "e08267121a961f1f",
  ...over,
});

const list = (rows: PaymentMatch[], canEdit = true, refused: Record<string, string> = {}) =>
  renderToString(
    <PaymentApprovalBody
      rows={rows}
      canEdit={canEdit}
      refused={refused}
      busy={null}
      onApprove={noop}
      onOpenJob={noop}
    />
  );

console.log("\n1. the four real states");
check("empty list renders the owner's empty sentence", () => {
  const html = list([]);
  assert(html.includes("אין כרגע תשלומים שממתינים לאישור"), "empty sentence missing");
  assert(html.includes("ולא תקושר לפני אישור"), "empty sentence truncated");
  assert(!html.includes("<table"), "a table was drawn for an empty list");
});

check("one row renders every column", () => {
  const html = list([row()]);
  for (const col of [
    "מסמך",
    "לקוח",
    "סכום המסמך",
    "תאריך המסמך",
    "העבודה",
    "סכום העבודה",
    "תאריך העבודה",
    "פער בימים",
    "בסיס",
  ]) {
    assert(html.includes(col), `column header missing: ${col}`);
  }
  assert(html.includes("60160"), "document number missing");
  assert(html.includes("מס / קבלה"), "document type missing");
  assert(html.includes("סבטלנה ניקסון"), "client missing");
  assert(html.includes("54"), "date gap missing");
  assert(html.includes("סכום מדויק כולל מע״מ"), "amount basis missing");
});

check("the explanatory text is present, in full", () => {
  const html = list([row()]);
  for (const line of [
    "המערכת מצאה מסמכי תשלום",
    "שום דבר לא נכתב לפני אישור",
    "ואין לכך כפתור ביטול במסך",
    "ההתאמה לא בודקת תאריכים",
    "הפער בימים מוצג בעמודה, לשיקולכם",
  ]) {
    assert(html.includes(line), `intro line missing: ${line}`);
  }
});

check("several rows all render", () => {
  const html = list([row(), row({ docId: "doc-2", docNumber: "60161", jobId: "job-2" })]);
  assert(html.includes("60160") && html.includes("60161"), "a row went missing");
});

console.log("\n2. the permission boundary");
check("can_edit_money: the approve button is drawn", () => {
  const html = list([row()], true);
  assert(html.includes("אישור — קישור וסימון"), "approve button missing for an editor");
});
check("view only: the list is drawn and the button is NOT", () => {
  const html = list([row()], false);
  assert(html.includes("60160"), "the row itself must still be visible");
  assert(html.includes("סבטלנה ניקסון"), "the row itself must still be visible");
  assert(!html.includes("אישור — קישור וסימון"), "approve button leaked to a view-only user");
});
check("view only on an empty list still shows the empty sentence", () => {
  assert(list([], false).includes("אין כרגע תשלומים שממתינים לאישור"), "empty sentence missing");
});

console.log("\n3. the document number is isolated LTR");
check("the number carries dir=ltr", () => {
  const html = list([row()]);
  assert(/dir="ltr"[^>]*>#?60160|#60160/.test(html), "number not rendered");
  assert(html.includes('dir="ltr"'), "no LTR isolation on the document number");
});
check("a null document number degrades to an em dash", () => {
  const html = list([row({ docNumber: null })]);
  assert(html.includes("—"), "null number did not degrade");
});

console.log("\n4. refusals land in the row");
check("a refusal is rendered against its own row", () => {
  const html = list([row(), row({ docId: "doc-2", docNumber: "60161", jobId: "job-2" })], true, {
    "doc-2": "המצב השתנה מאז שהרשימה הוצגה, והזוג כבר אינו התאמה יחידה.",
  });
  assert(html.includes("המצב השתנה מאז שהרשימה הוצגה"), "refusal text missing");
});
check("refusalText maps 'stale' to the owner's moved sentence", () => {
  const t = refusalText({ docId: "d", jobId: "j", ok: false, reason: "stale", error: "server words" });
  assert(t.includes("המצב השתנה מאז שהרשימה הוצגה"), "stale not mapped");
  assert(t.includes("לא בוצע שום קישור ושום סימון"), "stale sentence truncated");
  assert(!t.includes("server words"), "server wording leaked for a stale refusal");
});
check("refusalText maps 'not_in_set' to the same sentence", () => {
  const a = refusalText({ docId: "d", jobId: "j", ok: false, reason: "not_in_set", error: "x" });
  const b = refusalText({ docId: "d", jobId: "j", ok: false, reason: "stale", error: "y" });
  assert(a === b, "the two moved-state refusals must read identically");
});
check("any other refusal shows the server's own words, verbatim", () => {
  const t = refusalText({
    docId: "d",
    jobId: "j",
    ok: false,
    reason: "link_refused",
    error: "מסמך 60160 הוא מסמך היסטורי מלפני המעבר למערכת",
  });
  assert(t === "מסמך 60160 הוא מסמך היסטורי מלפני המעבר למערכת", "server refusal was rewritten");
});
check("a refusal with no error at all still says something", () => {
  const t = refusalText({ docId: "d", jobId: "j", ok: false, reason: "link_refused" });
  assert(t.length > 0, "empty refusal text");
});

console.log("\n5. the confirm dialog");
check("renders the owner's wording with the values filled in", () => {
  const html = renderToString(<PaymentConfirmBody m={row()} busy={null} onCancel={noop} onConfirm={noop} />);
  assert(html.includes("לסמן את העבודה כשולמה?"), "title missing");
  assert(html.includes("60160"), "document number missing");
  assert(html.includes("מס / קבלה"), "document type missing");
  assert(html.includes("יקושר לעבודה"), "link sentence missing");
  assert(html.includes("אסתטיטוקס"), "job label missing");
  assert(html.includes("והחוב יירד ב-"), "debt sentence missing");
  assert(html.includes("אין ביטול מהמסך"), "irreversibility warning missing");
  assert(html.includes("ביטול לקישור") || html.includes("ביטול קישור דורש טיפול ידני במסד"), "manual-fix sentence missing");
  assert(html.includes("כן, לקשר ולסמן שולם"), "confirm button missing");
});
check("the debt figure is the JOB's amount, not the document's", () => {
  // ₪1,416 is the receipt; ₪1,200 is what the job owes and therefore what the
  // debt drops by. Getting this backwards would overstate the drop by the VAT.
  const html = renderToString(
    <PaymentConfirmBody m={row({ docAmount: 1416, jobAmount: 1200 })} busy={null} onCancel={noop} onConfirm={noop} />
  );
  const after = html.split("והחוב יירד ב-")[1] ?? "";
  assert(after.includes("1,200"), `debt sentence did not name the job amount: ${after.slice(0, 80)}`);
});
check("busy disables both buttons", () => {
  const html = renderToString(<PaymentConfirmBody m={row()} busy={"doc-1"} onCancel={noop} onConfirm={noop} />);
  assert((html.match(/disabled/g) ?? []).length >= 2, "buttons not disabled while a post is in flight");
});

console.log("\n6. deliberately broken payloads — a version skew must not blank the screen");
const BROKEN: [string, Partial<PaymentMatch>][] = [
  ["docNumber null", { docNumber: null }],
  ["docAmount null", { docAmount: null }],
  ["jobAmount null", { jobAmount: null }],
  ["docDate null", { docDate: null }],
  ["jobDate null", { jobDate: null }],
  ["dateGapDays null", { dateGapDays: null }],
  ["docDate a nonsense string", { docDate: "not-a-date" }],
  // the shapes tsc promises but a stale bundle can still receive
  ["docTypeLabel missing", { docTypeLabel: undefined as unknown as string }],
  ["clientName missing", { clientName: undefined as unknown as string }],
  ["jobLabel missing", { jobLabel: undefined as unknown as string }],
  ["amountBasisLabel missing", { amountBasisLabel: undefined as unknown as string }],
  ["everything at once", {
    docNumber: null,
    docAmount: null,
    jobAmount: null,
    docDate: null,
    jobDate: null,
    dateGapDays: null,
    docTypeLabel: undefined as unknown as string,
    clientName: undefined as unknown as string,
    jobLabel: undefined as unknown as string,
    amountBasisLabel: undefined as unknown as string,
  }],
];
for (const [label, over] of BROKEN) {
  check(`list survives: ${label}`, () => {
    const html = list([row(over)]);
    assert(html.length > 0, "rendered empty");
  });
  check(`dialog survives: ${label}`, () => {
    const html = renderToString(<PaymentConfirmBody m={row(over)} busy={null} onCancel={noop} onConfirm={noop} />);
    assert(html.includes("לסמן את העבודה כשולמה?"), "dialog lost its title");
  });
}

console.log("\n" + "=".repeat(70));
if (failures) {
  console.log(`FAILED — ${failures}`);
  process.exit(1);
}
console.log("ALL PASS — rendered in memory, no server, no database");
