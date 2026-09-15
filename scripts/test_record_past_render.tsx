/**
 * Renders RecordPastBody in each of its five real states, and against
 * DELIBERATELY BROKEN payloads, and asserts it does not throw.
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_record_past_render.tsx
 * Pure. Reads nothing, writes nothing, needs no database and no dev server.
 *
 * ═══ WHY ═══
 * Same argument as test_projects_render.tsx and test_record_billed_render.tsx.
 * An HTTP suite that greps the /shows HTML proves the SERVER rendered; it says
 * nothing about whether this modal can mount, and the modal is where every one
 * of these payloads lands.
 *
 * The class being guarded is the one 2026-09-15 paid for: `MILESTONE_META[state]`
 * returned undefined for a state the bundle did not know and `.color` took the
 * page down, while tsc was satisfied because the TYPE promised a MilestoneState.
 * Everything below arrives from the server too — a job list, a document list, a
 * mismatch object, a partial-link result — and a version skew looks from inside
 * the component exactly like a field that is suddenly undefined.
 *
 * NOTE ON ASSERTIONS: React separates adjacent text nodes with an empty HTML
 * comment, so `שויכו {n} מתוך {m}` reaches the markup as
 * `שויכו <!-- -->1<!-- --> מתוך`. `render` strips those, so these assertions are
 * about the sentence the bookkeeper reads and not about the renderer's
 * internals.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import RecordPastBody from "../src/app/shows/RecordPastBody";
import type { BilledCandidate } from "../src/app/contracts/RecordBilledBody";

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

// כפיר ארביב, the case this feature was built for: 10288 → 40289, two episodes
// on 12.7 at ₪250 each.
const doc40289: BilledCandidate = {
  id: "349532c7",
  number: "40289",
  type: 300,
  type_label: "חשבון עסקה",
  amount: 590,
  net: 500,
  date: "2026-07-15",
  chain_id: "10288",
  parents: ["10288"],
};
// the tax invoice that would join it once Shiri issues one — same chain
const doc60xxx: BilledCandidate = {
  id: "aaaa1111",
  number: "60210",
  type: 320,
  type_label: "חשבונית מס / קבלה",
  amount: 590,
  net: 500,
  date: "2026-07-20",
  chain_id: "10288",
  parents: ["40289"],
};

const jobPaid = {
  id: "bce346b8",
  campaign: "לשבת לקחת סאונד פרק צורית אור",
  amount: 250,
  date: "2026-06-28",
  paid: "כן",
  doc_number: "60169",
  linked_productions: 0,
};
const jobLinked = {
  id: "4388cb08",
  campaign: "לשבת לקחת פרק כפול לייב רז+חיים כהן +אייל שני",
  amount: 500,
  date: "2026-07-07",
  paid: "לא",
  doc_number: "40283",
  linked_productions: 2,
};

const base = {
  showName: "לשבת לקחת",
  defaultRate: 250,
  loading: false,
  episodes: [{ record_date: "2026-07-12", title: "נדב-שמונה" }],
  mode: "job" as const,
  jobs: [jobPaid, jobLinked],
  selectedJobId: null,
  documents: [doc40289],
  picked: new Set<string>(),
  busy: false,
  error: null,
  mismatch: null,
  ack: false,
  result: null,
  warning: null,
  onEpisodeChange: () => {},
  onAddEpisode: () => {},
  onRemoveEpisode: () => {},
  onMode: () => {},
  onSelectJob: () => {},
  onToggleDoc: () => {},
  onAck: () => {},
  onSubmit: () => {},
  onClose: () => {},
};

const render = (props: Record<string, unknown>) =>
  renderToString(React.createElement(RecordPastBody, { ...base, ...props } as never)).replace(/<!-- -->/g, "");

console.log("\n=== the five states the owner specified ===");

check("1. empty — no jobs and no documents", () => {
  const html = render({ jobs: [], documents: [], mode: "documents" });
  if (!html.includes("אין ללקוח מסמכים פנויים לשיוך")) throw new Error("empty documents sentence missing");
  if (!html.includes("ההפקה כבר בוצעה וחויבה מחוץ למערכת")) throw new Error("explanation missing");
  if (!html.includes("לא תיכנס לתור האישורים ולא תנפיק שום מסמך")) throw new Error("no-issuance promise missing");
});

check("2. existing job — and the one that already carries productions", () => {
  const html = render({ mode: "job", selectedJobId: "4388cb08" });
  if (!html.includes("חיוב קיים")) throw new Error("mode label missing");
  if (!html.includes("החיוב הזה כבר מקושר ל-2 הפקות. ההפקות החדשות יתווספו אליו."))
    throw new Error("already-linked sentence missing");
  if (!html.includes("40283")) throw new Error("job document number missing");
});

check("3. documents with a chain — both picked, and the sentence", () => {
  const html = render({
    mode: "documents",
    documents: [doc40289, doc60xxx],
    picked: new Set([doc40289.id, doc60xxx.id]),
  });
  if (!html.includes("נבחרה גם חשבונית המס 60210")) throw new Error("chain sentence missing");
  if (!html.includes("ולא מסתכמים")) throw new Error("no-sum clause missing");
});

check("4. amount warning — episodes × rate, and the checkbox", () => {
  const html = render({
    mode: "documents",
    picked: new Set([doc40289.id]),
    mismatch: { gross_max: 590, net: 500, expected_amount: 250 },
  });
  if (!html.includes("ולפי מספר הפרקים")) throw new Error("episode-count phrasing missing");
  if (html.includes("אבן הדרך")) throw new Error("milestone wording leaked onto the shows screen");
  if (!html.includes("אני מאשר/ת את הפער")) throw new Error("checkbox label missing");
});

check("5. partial link (207) — N of M, the reason, and 'press again'", () => {
  const html = render({
    mode: "documents",
    result: {
      linked: ["40289"],
      failed: [{ number: "60210", error: "המסמך 60210 שויך בינתיים לעבודה אחרת ולכן לא שויך כאן." }],
      total: 2,
    },
  });
  if (!html.includes("שויכו 1 מתוך 2 מסמכים")) throw new Error("count sentence missing");
  if (!html.includes("שויך בינתיים לעבודה אחרת")) throw new Error("taken sentence missing");
  if (!html.includes("מה ששויך כבר יידלג")) throw new Error("retry sentence missing");
});

console.log("\n=== the 'no billing' branch says what it costs ===");
check("mode none — the alert warning", () => {
  const html = render({ mode: "none" });
  if (!html.includes("הופק ולא חויב")) throw new Error("alert warning missing");
  if (!html.includes("עד שתקשר אותה")) throw new Error("warning tail missing");
});

console.log("\n=== the submit gate ===");
check("no job selected in job mode → disabled", () => {
  if (!render({ mode: "job", selectedJobId: null }).includes("disabled")) throw new Error("expected disabled");
});
check("no documents picked in documents mode → disabled", () => {
  if (!render({ mode: "documents", picked: new Set() }).includes("disabled")) throw new Error("expected disabled");
});
check("an episode with no date → disabled", () => {
  const html = render({ mode: "none", episodes: [{ record_date: "", title: "x" }] });
  if (!html.includes("disabled")) throw new Error("expected disabled");
});
check("mismatch unacknowledged → disabled", () => {
  const html = render({
    mode: "documents",
    picked: new Set([doc40289.id]),
    mismatch: { gross_max: 590, net: 500, expected_amount: 250 },
    ack: false,
  });
  if (!html.includes("disabled")) throw new Error("expected disabled");
});

console.log("\n=== version skew: every field the payload might not carry ===");
check("episodes undefined", () => render({ episodes: undefined }));
check("jobs undefined", () => render({ jobs: undefined, mode: "job" }));
check("documents undefined", () => render({ documents: undefined, mode: "documents" }));
check("picked undefined", () => render({ picked: undefined, mode: "documents" }));
check("an episode entry that is null", () => render({ episodes: [null] }));
check("job.campaign null", () => render({ mode: "job", jobs: [{ ...jobPaid, campaign: null }] }));
check("job.amount / date null", () => render({ mode: "job", jobs: [{ ...jobPaid, amount: null, date: null }] }));
check("job.linked_productions undefined", () =>
  render({ mode: "job", jobs: [{ ...jobPaid, linked_productions: undefined }] }));
check("document.type_label undefined (falls back to the code)", () => {
  const html = render({ mode: "documents", documents: [{ ...doc40289, type_label: undefined }] });
  if (!html.includes("סוג 300")) throw new Error("type fallback missing");
});
check("document.number / amount / date null", () =>
  render({ mode: "documents", documents: [{ ...doc40289, number: null, amount: null, date: null }] }));
check("defaultRate null (a show with no rate)", () => {
  const html = render({ defaultRate: null });
  if (html.includes("NaN")) throw new Error("NaN reached the screen");
});
check("showName undefined", () => render({ showName: undefined }));
check("result.failed undefined", () => render({ result: { linked: ["40289"], failed: undefined, total: 2 } }));
check("result.linked undefined", () => render({ result: { linked: undefined, failed: [], total: 2 } }));
check("result is an empty object", () => render({ result: {} }));
check("failed entry with no number", () => render({ result: { linked: [], failed: [{ error: "x" }], total: 1 } }));
check("mismatch is an empty object", () => render({ mismatch: {} }));
check("mode is a value the bundle does not know", () => render({ mode: "אחר" }));
check("loading with nothing yet", () => {
  const html = render({ loading: true, jobs: [], documents: [] });
  if (!html.includes("טוען…")) throw new Error("loading line missing");
  if (html.includes("אין ללקוח מסמכים פנויים")) throw new Error("empty state shown during load");
});

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
