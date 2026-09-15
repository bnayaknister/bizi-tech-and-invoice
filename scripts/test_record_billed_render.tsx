/**
 * Renders RecordBilledBody in each of its four real states, and against
 * DELIBERATELY BROKEN payloads, and asserts it does not throw.
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_record_billed_render.tsx
 * Reads nothing, writes nothing, needs no dev server, touches no database.
 *
 * ═══ WHY ═══
 * Same argument as test_projects_render.tsx, applied to a screen that did not
 * exist yet when that one was written. An HTTP suite that greps the /contracts
 * HTML proves the SERVER rendered; it says nothing about whether this modal can
 * mount, and the modal is where every one of these payloads lands.
 *
 * The specific class being guarded: `MILESTONE_META[state].color` took the page
 * down on 2026-09-15 for a `state` the bundle did not know, while tsc was
 * satisfied because the TYPE promised a MilestoneState. Every value here comes
 * from the server too — candidate arrays, a failure list, a mismatch object —
 * and a version skew looks from inside the component exactly like a field that
 * is suddenly undefined. So each one is knocked out below.
 *
 * The four states are the four the owner specified: empty, chain, amount
 * warning, partial link. They are props rather than internal state precisely so
 * this file can reach them — renderToString never runs an effect, so a modal
 * that fetched its own data could only ever be tested in its loading state.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import RecordBilledBody, {
  chainExtraNumbers,
  failureLine,
  type BilledCandidate,
} from "../src/app/contracts/RecordBilledBody";

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

// בר ביצוע, the case this feature was built for: a 300 and the 305 raised on
// it, same gross, same date, one chain.
const deal: BilledCandidate = {
  id: "8cc04e28",
  number: "40326",
  type: 300,
  type_label: "חשבון עסקה",
  amount: 49560,
  net: 42000,
  date: "2026-09-10",
  chain_id: "10333",
  parents: ["10333"],
};
const tax: BilledCandidate = {
  id: "a4ddad84",
  number: "50070",
  type: 305,
  type_label: "חשבונית מס",
  amount: 49560,
  net: 42000,
  date: "2026-09-10",
  chain_id: "10333",
  parents: ["40326"],
};

const base = {
  milestoneName: "תשלום מלא",
  milestoneAmount: 42000,
  clientName: "בר ביצוע עבודות בנייה בע״מ",
  loading: false,
  candidates: [deal, tax],
  picked: new Set<string>(),
  busy: false,
  error: null,
  mismatch: null,
  ack: false,
  result: null,
  onToggle: () => {},
  onAck: () => {},
  onSubmit: () => {},
  onClose: () => {},
};

/**
 * React separates adjacent text nodes with an empty HTML comment, so a sentence
 * written as `שויכו {n} מתוך {m} מסמכים` reaches the markup as
 * `שויכו <!-- -->1<!-- --> מתוך <!-- -->2<!-- --> מסמכים`. Asserting on the raw
 * string would be asserting on the renderer's internals rather than on the copy
 * the bookkeeper reads — and it would break the day an interpolation moves.
 * Stripping the separators is what makes these assertions about the sentence.
 */
const render = (props: Record<string, unknown>) =>
  renderToString(React.createElement(RecordBilledBody, { ...base, ...props } as never)).replace(/<!-- -->/g, "");

console.log("\n=== the four states the owner specified ===");

check("1. empty — no free documents", () => {
  const html = render({ candidates: [] });
  if (!html.includes("אין ללקוח מסמכים פנויים לשיוך")) throw new Error("empty sentence missing");
  if (!html.includes("ואינה מנפיקה מסמך חדש")) throw new Error("explanation missing");
  if (!html.includes("תיכנס לחוב לגבייה")) throw new Error("debt line missing");
});

check("2. chain — picking the 300 brings the 305 and says so", () => {
  const html = render({ picked: new Set([deal.id, tax.id]) });
  if (!html.includes("נבחרה גם חשבונית המס 50070")) throw new Error("chain sentence missing");
  if (!html.includes("ולא מסתכמים")) throw new Error("no-sum clause missing");
  if (!html.includes("40326")) throw new Error("deal invoice row missing");
});

check("3. amount warning — the server's numbers, and the checkbox", () => {
  const html = render({
    picked: new Set([deal.id]),
    mismatch: { gross_max: 49560, net: 42000, milestone_amount: 30000 },
  });
  if (!html.includes("ברוטו")) throw new Error("gross word missing");
  if (!html.includes("אני מאשר/ת את הפער")) throw new Error("checkbox label missing");
  if (!html.includes("הסכומים יישארו כפי שהם")) throw new Error("reassurance missing");
});

check("4. partial link — N of M, the reason, and 'press again'", () => {
  const html = render({
    result: {
      linked: ["40326"],
      failed: [{ number: "50070", error: "המסמך 50070 שויך בינתיים לעבודה אחרת ולכן לא שויך כאן." }],
      total: 2,
    },
  });
  if (!html.includes("שויכו 1 מתוך 2 מסמכים")) throw new Error("count sentence missing");
  if (!html.includes("שויך בינתיים לעבודה אחרת")) throw new Error("taken sentence missing");
  if (!html.includes("מה ששויך כבר יידלג")) throw new Error("retry sentence missing");
});

console.log("\n=== the sentence builders, directly ===");

check("chainExtraNumbers: one chain fully picked yields the tax number", () => {
  const got = chainExtraNumbers([deal, tax], new Set([deal.id, tax.id]));
  if (got.join(",") !== "50070") throw new Error(`got ${JSON.stringify(got)}`);
});
check("chainExtraNumbers: a lone pick yields nothing to announce", () => {
  const got = chainExtraNumbers([deal, tax], new Set([deal.id]));
  if (got.length !== 0) throw new Error(`got ${JSON.stringify(got)}`);
});
check("chainExtraNumbers: empty and undefined inputs", () => {
  if (chainExtraNumbers([], new Set()).length !== 0) throw new Error("empty");
  if (chainExtraNumbers(undefined as never, new Set()).length !== 0) throw new Error("undefined candidates");
  if (chainExtraNumbers([deal], undefined as never).length !== 0) throw new Error("undefined picked");
});
check("failureLine: a sentence naming its document is used verbatim", () => {
  const s = failureLine({ number: "50070", error: "המסמך 50070 שויך בינתיים לעבודה אחרת ולכן לא שויך כאן." });
  if (s !== "המסמך 50070 שויך בינתיים לעבודה אחרת ולכן לא שויך כאן.") throw new Error(s);
});
check("failureLine: a bare reason gets the wrapper", () => {
  const s = failureLine({ number: "40326", error: "בדיקת הכפילות נכשלה" });
  if (s !== "המסמך 40326 לא שויך: בדיקת הכפילות נכשלה") throw new Error(s);
});

console.log("\n=== version skew: every field the payload might not carry ===");

check("candidates undefined", () => render({ candidates: undefined }));
check("picked undefined", () => render({ picked: undefined }));
check("candidate.number null", () => render({ candidates: [{ ...deal, number: null }] }));
check("candidate.amount null", () => render({ candidates: [{ ...deal, amount: null, net: null }] }));
check("candidate.date null", () => render({ candidates: [{ ...deal, date: null }] }));
check("candidate.type_label undefined (falls back to the code)", () => {
  const html = render({ candidates: [{ ...deal, type_label: undefined }] });
  if (!html.includes("סוג 300")) throw new Error("type fallback missing");
});
check("result.failed undefined", () => render({ result: { linked: ["40326"], failed: undefined, total: 2 } }));
check("result.linked undefined", () => render({ result: { linked: undefined, failed: [], total: 2 } }));
check("result is an empty object", () => render({ result: {} }));
check("failed entry with no number", () => render({ result: { linked: [], failed: [{ error: "x" }], total: 1 } }));
check("failed entry with no error", () => render({ result: { linked: [], failed: [{ number: "9" }], total: 1 } }));
check("mismatch is an empty object", () => render({ mismatch: {} }));
check("milestoneName undefined", () => render({ milestoneName: undefined }));
check("milestoneAmount undefined", () => render({ milestoneAmount: undefined }));
check("clientName null", () => render({ clientName: null }));
check("loading with no candidates yet", () => {
  const html = render({ loading: true, candidates: [] });
  if (!html.includes("טוען מסמכים…")) throw new Error("loading line missing");
  // the empty sentence must NOT be showing while the list is still in flight
  if (html.includes("אין ללקוח מסמכים פנויים")) throw new Error("empty state shown during load");
});

console.log("\n=== the submit button's gate ===");
check("nothing picked → disabled", () => {
  const html = render({ picked: new Set() });
  if (!html.includes("disabled")) throw new Error("expected a disabled button");
});
check("mismatch unacknowledged → still disabled", () => {
  const html = render({ picked: new Set([deal.id]), mismatch: { gross_max: 1, net: 1, milestone_amount: 2 }, ack: false });
  if (!html.includes("disabled")) throw new Error("expected a disabled button");
});

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
