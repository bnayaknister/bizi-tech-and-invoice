/**
 * ═══════════════════════════════════════════════════════════════════════════
 * /projects — "כל עבודה שמתבצעת במערכת" (owner 5.10). The pure rules.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Run:  npx tsx scripts/test_projects_unified.ts
 *
 * ⛔ NO DATABASE, NO SERVER, NO NETWORK — there is no Supabase client in this
 * file and no `fetch`. That is F19, and it is not a formality here: the live
 * database holds the first redemption in the system's life (ברק, work order
 * 10317), Ofer's 305 queued for Shiri, and 94 real jobs. Every case below is
 * hand-built arithmetic and set algebra.
 *
 * ═══ 🔴 THE PART THAT MATTERS MOST: THE CANARY ═══
 * The owner's rule is "כל עבודה — שורה אחת", and that is not a property of any
 * single return value — it is a property of the WHOLE result: every
 * non-dismissed job appears in exactly one row, or is named in `unrepresented`
 * with a reason. A test that checked row counts would prove nothing; two rows
 * and one dropped billing row look identical from outside. So `UnifiedRow`
 * carries `jobIds` and the canary sums them.
 *
 * ═══ AND THE SECOND ENFORCEMENT: READ-ONLY ═══
 * This change was specified as read-only — zero writes, and no touching the
 * document or job paths. That is a property of WHAT THE CHANGED FILES CONTAIN,
 * not of any value, so the last section reads their text and fails if one of
 * them imports a document/Morning module or writes to a money table. The same
 * shape test_contract_quota.ts uses, for the same reason: a mocked Supabase
 * would be testing the mock.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BILL_FILTER_KEYS,
  DATE_MEANING_TITLE,
  EMPTY_FILTER,
  NO_JOB_LABEL,
  ROW_SOURCES,
  SOURCE_LABEL,
  billFilterLabel,
  billStatusFor,
  buildUnifiedRows,
  clientOptions,
  compareUnified,
  countBySource,
  excludedJobIds,
  isFilterActive,
  jobOnlyCandidates,
  jobOnlySource,
  matchesFilter,
  productionStatusCell,
  miscStatusCell,
  type JobInput,
  type MilestoneInput,
  type MiscInput,
  type ProductionInput,
  type UnifiedInput,
  type UnifiedRow,
} from "../src/lib/projects/unified";
import { TAB_META } from "../src/lib/finance/state";
import { STATUS_LABEL } from "../src/lib/productions/status";
import { MISC_STATUS_TONE } from "../src/lib/misc/status";

let failures = 0;
let checks = 0;
const check = (label: string, ok: boolean, detail = "") => {
  checks++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};
const eq = (label: string, got: unknown, want: unknown) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const FLOOR = "2026-07";

// ---------------------------------------------------------------------------
// fixtures — the shapes the live data actually has
// ---------------------------------------------------------------------------

const noDocs: never[] = [];

const prod = (over: Partial<ProductionInput> = {}): ProductionInput => ({
  month: "2026-08",
  id: "p1",
  record_date: "2026-08-12",
  podcast_name: "בדיקה",
  show_name: "בדיקה",
  client_name: "לקוח א",
  guest: "אורח",
  status: "הופץ",
  episode_no: 3,
  internal: false,
  cancelled: false,
  price: 700,
  billing: "priced",
  contract_name: null,
  empty_reason_text: null,
  docs: noDocs,
  jobs: [],
  stuckSentences: [],
  ...over,
});

const job = (over: Partial<JobInput> = {}): JobInput => ({
  id: "j1",
  client_name: "לקוח א",
  campaign: "קמפיין",
  date: "2026-08-20",
  amount: 1500,
  paid: "לא",
  invoice_biz: null,
  invoice_tax: null,
  dismissed: false,
  external_id: null,
  legacy: false,
  docs: noDocs,
  ...over,
});

const ms = (over: Partial<MilestoneInput> = {}): MilestoneInput => ({
  month: "2026-09",
  id: "m1",
  name: "חלק א",
  contract_id: "c1",
  contract_name: "מכירת ביפו",
  client_name: "לקוח ב",
  stateLabel: "שולם",
  stateColor: "var(--green)",
  amount: 5900,
  anchor_date: "2026-09-10",
  job_id: null,
  jobFacts: null,
  docs: noDocs,
  ...over,
});

const misc = (over: Partial<MiscInput> = {}): MiscInput => ({
  id: "w1",
  name: "עריכת תוכנית רדיו",
  client_name: "לקוח ג",
  work_date: "2026-08-05",
  amount: 900,
  description: "מיקס",
  status: "הושלם",
  job_id: null,
  jobFacts: null,
  docs: noDocs,
  ...over,
});

const build = (over: Partial<UnifiedInput> = {}) =>
  buildUnifiedRows({
    rangeStartMonth: FLOOR,
    productions: [],
    milestones: [],
    misc: [],
    jobs: [],
    linkedJobIds: [],
    ...over,
  });

const bySource = (rows: UnifiedRow[], s: string) => rows.filter((r) => r.source === s);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 1. הפקה + ה-job שלה → שורה אחת, מקור \"הפקה\" ──────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const j = job({ id: "jp", date: "2026-08-12" });
  const r = build({
    productions: [prod({ jobs: [{ id: "jp", paid: "לא", invoice_biz: "40301", invoice_tax: null }] })],
    jobs: [j],
    linkedJobIds: ["jp"],
  });
  eq("שורה אחת בסך הכל", r.rows.length, 1);
  eq("המקור הוא הפקה", r.rows[0].source, "production");
  eq("השורה נושאת את ה-job", r.rows[0].jobIds, ["jp"]);
  eq("אפס שורות job-only", bySource(r.rows, "bundle").length + bySource(r.rows, "import").length, 0);
  // the job was linked and its production rendered — nothing unaccounted for
  eq("אפס jobs ללא ייצוג", r.unrepresented, []);
  // and the billing status came from deriveState, not from a second spelling
  eq("סטטוס חיוב = blue (יש עסקה, לא שולם)", r.rows[0].billStatus.state, "blue");
  eq("התווית היא של TAB_META", r.rows[0].billStatus.label, TAB_META.blue.label);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 2. misc + ה-job שלו → שורה אחת, מקור \"רדיו ושונות\" ────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = build({
    misc: [misc({ job_id: "jw", jobFacts: { paid: "כן", invoice_biz: "40310", invoice_tax: "60310" } })],
    jobs: [job({ id: "jw", date: "2026-08-05" })],
  });
  eq("שורה אחת בסך הכל", r.rows.length, 1);
  eq("המקור הוא misc", r.rows[0].source, "misc");
  eq("התג בעברית", SOURCE_LABEL[r.rows[0].source], "רדיו ושונות");
  eq("השורה נושאת את ה-job", r.rows[0].jobIds, ["jw"]);
  eq("ה-job לא הופיע גם כ-job-only", r.rows.length, 1);
  eq("תאריך העבודה, לא תאריך ההנפקה", r.rows[0].dateMeaning, "work");
  eq("סטטוס חיוב = closed", r.rows[0].billStatus.state, "closed");
  // the misc status column speaks its OWN four-value vocabulary
  eq("סטטוס הפקה = הסטטוס של misc", r.rows[0].prodStatus?.label, "הושלם");
  eq("והגוון מ-MISC_STATUS_TONE", r.rows[0].prodStatus?.color, MISC_STATUS_TONE["הושלם"]);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 3. job של אבן דרך → שורת אבן הדרך בלבד ─────────────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = build({
    milestones: [ms({ job_id: "jm", jobFacts: { paid: "כן", invoice_biz: null, invoice_tax: "60197" } })],
    jobs: [job({ id: "jm", date: "2026-09-10" })],
  });
  eq("שורה אחת בסך הכל", r.rows.length, 1);
  eq("המקור הוא אבן דרך", r.rows[0].source, "milestone");
  eq("אפס שורות מרוכזת/ייבוא", bySource(r.rows, "bundle").length + bySource(r.rows, "import").length, 0);
  eq("השורה נושאת את ה-job", r.rows[0].jobIds, ["jm"]);
  eq("תאריך המסמך", r.rows[0].dateMeaning, "document");
  // a milestone is already inside the month cards — it must never be summed here
  eq("מחוץ לסכומי הכסף", r.rows[0].excludedFromMoney, true);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 4. job של מרוכזת (בלי קישורים) → שורה אחת, מקור \"מרוכזת\" ──");
// ═══════════════════════════════════════════════════════════════════════════
{
  // bundle-from-show: no job_productions, no external_id, legacy false,
  // jobs.date = todayInIsrael() at creation (route.ts:107-115)
  const r = build({ jobs: [job({ id: "jb", external_id: null, legacy: false })] });
  eq("שורה אחת בסך הכל", r.rows.length, 1);
  eq("המקור הוא מרוכזת", r.rows[0].source, "bundle");
  eq("התג בעברית", SOURCE_LABEL[r.rows[0].source], "מרוכזת");
  eq("אין סטטוס הפקה — קו מפריד", r.rows[0].prodStatus, null);
  eq("אין תיאור", r.rows[0].description, null);
  // THE DATE WARNING IS ON THE ROW, and this is the assertion that keeps it there
  eq("משמעות התאריך = הנפקה", r.rows[0].dateMeaning, "issued");
  eq(
    "והכיתוב אומר שזה לא תאריך העבודה",
    DATE_MEANING_TITLE[r.rows[0].dateMeaning],
    "תאריך הנפקת ההזמנה, לא תאריך העבודה"
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 5. ייבוא — אותו job עם external_id → מקור \"ייבוא\" ─────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = build({ jobs: [job({ id: "ji", external_id: "C0042" })] });
  eq("שורה אחת", r.rows.length, 1);
  eq("המקור הוא ייבוא", r.rows[0].source, "import");
  // and legacy alone is enough, for the 0015/0016 backfill rows
  eq("legacy לבדו מספיק", jobOnlySource({ external_id: null, legacy: true }), "import");
  eq("ריק ו-legacy false → מרוכזת", jobOnlySource({ external_id: null, legacy: false }), "bundle");
  // 🔵 the inference's own blind spot, asserted so it cannot be forgotten:
  // a whitespace external_id is NOT an id
  eq("רווח אינו external_id", jobOnlySource({ external_id: "  ", legacy: false }), "bundle");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 6. 🔴 job שגם misc וגם milestone מצביעים עליו ──────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  // Nothing in the schema forbids it: both are plain nullable FKs. One row only,
  // and the collision is REPORTED rather than drawn twice.
  const r = build({
    misc: [misc({ id: "wX", job_id: "jdup" })],
    milestones: [ms({ id: "mX", job_id: "jdup" })],
    jobs: [job({ id: "jdup", date: "2026-09-10" })],
  });
  const carrying = r.rows.filter((x) => x.jobIds.includes("jdup"));
  eq("ה-job מופיע בשתי שורות עוגן — אחת לכל נושא", carrying.length, 2);
  eq("אבל אפס שורות job-only", bySource(r.rows, "bundle").length + bySource(r.rows, "import").length, 0);
  // THE REPORT — which anchor won, and that it happened at all
  eq("נרשמה התנגשות אחת", r.conflicts.length, 1);
  eq("על ה-job הנכון", r.conflicts[0].jobId, "jdup");
  eq("נתבע בידי שני נושאים", r.conflicts[0].claimedBy.slice().sort(), ["milestone", "misc"]);
  eq("🔴 הזוכה: אבן דרך (קדימות milestone > misc)", r.conflicts[0].wonBy, "milestone");
  eq("ו-jobOwner מצביע על שורת אבן הדרך", r.jobOwner.get("jdup")?.key, "milestone:mX");
  eq("אפס jobs ללא ייצוג", r.unrepresented, []);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 7. job dismissed → 0 שורות ─────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = build({ jobs: [job({ id: "jd", dismissed: true })] });
  eq("אפס שורות", r.rows.length, 0);
  // withdrawn, not missing — 0041. It must NOT be reported as a gap.
  eq("ואינו מדווח כחסר ייצוג", r.unrepresented, []);
  eq("וגם לא נבחר כמועמד", jobOnlyCandidates([job({ id: "jd", dismissed: true })], new Set()).length, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 8. job-only לפני 7.2026 → 0 שורות ──────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = build({ jobs: [job({ id: "jold", date: "2026-06-30" })] });
  eq("אפס שורות", r.rows.length, 0);
  eq("מדווח כמחוץ לטווח", r.unrepresented, [{ jobId: "jold", reason: "before_range" }]);

  // 1.7.2026 is INSIDE — the floor is inclusive
  const inRange = build({ jobs: [job({ id: "jin", date: "2026-07-01" })] });
  eq("1.7 בתוך הטווח", inRange.rows.length, 1);
  eq("ובחודש הנכון", inRange.rows[0].month, "2026-07");

  // a dateless job: the same rule the production rows follow
  const noDate = build({ jobs: [job({ id: "jnd", date: null })] });
  eq("job בלי תאריך — אפס שורות", noDate.rows.length, 0);
  eq("ומדווח, לא נזרק בשקט", noDate.unrepresented, [{ jobId: "jnd", reason: "no_date" }]);

  // and the floor applies to EVERY source — owner 5.10, one floor
  const oldMisc = build({ misc: [misc({ id: "wold", work_date: "2026-06-01" })] });
  eq("misc לפני יולי — אפס שורות", oldMisc.rows.length, 0);
  const oldMs = build({ milestones: [ms({ id: "mold", month: "2026-06" })] });
  eq("אבן דרך לפני יולי — אפס שורות", oldMs.rows.length, 0);
  const oldProd = build({ productions: [prod({ id: "pold", month: "2026-06" })] });
  eq("הפקה לפני יולי — אפס שורות", oldProd.rows.length, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 9. 🔴 הדבר שההצעה מסרבת להסתיר: unrepresented ──────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  // A milestone with no anchor document emits NO row (page.tsx:770-783), yet its
  // job is in `excluded` by the owner's literal rule. The job therefore reaches
  // no row at all — and that is REPORTED, not silently dropped.
  const r = build({
    milestones: [], // the milestone exists in the DB but produced no row
    jobs: [job({ id: "jorphan", date: "2026-09-01" })],
    linkedJobIds: [],
  });
  eq("בלי אף עוגן הוא כן הופך לשורה", r.rows.length, 1);

  // now the same job, claimed by a milestone that rendered nothing
  const claimed = buildUnifiedRows({
    rangeStartMonth: FLOOR,
    productions: [],
    // the milestone row is below the floor, so it claims but does not render
    milestones: [ms({ id: "mOld", month: "2026-06", job_id: "jorphan" })],
    misc: [],
    jobs: [job({ id: "jorphan", date: "2026-09-01" })],
    linkedJobIds: [],
  });
  eq("נתבע אך לא מרונדר → אפס שורות", claimed.rows.length, 0);
  eq(
    "🔴 ומדווח עם הסיבה",
    claimed.unrepresented,
    [{ jobId: "jorphan", reason: "milestone_without_anchor" }]
  );

  // a linked job whose production is out of range
  const linked = build({
    productions: [],
    jobs: [job({ id: "jlinked", date: "2026-08-01" })],
    linkedJobIds: ["jlinked"],
  });
  eq("job מקושר בלי שורת הפקה → אפס שורות", linked.rows.length, 0);
  eq(
    "ומדווח כ-production_out_of_range",
    linked.unrepresented,
    [{ jobId: "jlinked", reason: "production_out_of_range" }]
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 10. 🔴 הקנרי: כל job בדיוק פעם אחת ─────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  // One dataset with all five sources, a dismissed job, an out-of-range job and
  // a double-claimed job — the shape the live database is heading towards.
  const input: UnifiedInput = {
    rangeStartMonth: FLOOR,
    productions: [
      prod({ id: "pA", jobs: [{ id: "jA", paid: "לא", invoice_biz: null, invoice_tax: null }] }),
      // two productions on ONE job — record-past-productions does this
      prod({ id: "pB", month: "2026-08", jobs: [{ id: "jB", paid: "כן", invoice_biz: "1", invoice_tax: "2" }] }),
      prod({ id: "pC", month: "2026-08", jobs: [{ id: "jB", paid: "כן", invoice_biz: "1", invoice_tax: "2" }] }),
      // a production with no job at all — an episode not yet billed
      prod({ id: "pD", month: "2026-09", jobs: [] }),
    ],
    milestones: [ms({ id: "mA", job_id: "jM" })],
    misc: [misc({ id: "wA", job_id: "jW" })],
    jobs: [
      job({ id: "jA", date: "2026-08-12" }),
      job({ id: "jB", date: "2026-08-14" }),
      job({ id: "jM", date: "2026-09-10" }),
      job({ id: "jW", date: "2026-08-05" }),
      job({ id: "jBundle", date: "2026-08-22" }),
      job({ id: "jImport", date: "2026-08-23", external_id: "C0007" }),
      job({ id: "jGone", date: "2026-08-24", dismissed: true }),
      job({ id: "jOld", date: "2026-05-01" }),
    ],
    linkedJobIds: ["jA", "jB", "jB"],
  };
  const r = buildUnifiedRows(input);

  // ---- the canary itself -------------------------------------------------
  const seen = new Map<string, string[]>();
  for (const row of r.rows) {
    for (const id of row.jobIds) seen.set(id, [...(seen.get(id) ?? []), row.key]);
  }
  const live = input.jobs.filter((j) => !j.dismissed);
  const unrep = new Set(r.unrepresented.map((u) => u.jobId));

  const missing = live.filter((j) => !seen.has(j.id) && !unrep.has(j.id));
  eq("🔴 אף job לא נשמט בשקט", missing.map((j) => j.id), []);

  // "exactly once" is per ROW KEY, and pB/pC legitimately share jB — two
  // productions on one job is one job shown on two episodes, which is the truth.
  const duplicated = Array.from(seen.entries()).filter(([, keys]) => new Set(keys).size !== keys.length);
  eq("אף job לא מוכפל באותה שורה", duplicated, []);

  // a job may appear on several rows ONLY through genuinely distinct anchors
  const multi = Array.from(seen.entries()).filter(([, keys]) => keys.length > 1);
  eq("jB על שתי הפקות — ושום דבר אחר", multi.map(([id, k]) => [id, k.length]), [["jB", 2]]);

  // and no job is both represented and reported as unrepresented
  const both = live.filter((j) => seen.has(j.id) && unrep.has(j.id));
  eq("אין job שגם מיוצג וגם מדווח כחסר", both.map((j) => j.id), []);

  // the dismissed one is nowhere
  eq("ה-dismissed אינו בשום שורה", seen.has("jGone"), false);
  eq("וגם לא בדיווח", unrep.has("jGone"), false);

  // the out-of-range one is reported
  eq("ה-job הישן מדווח", r.unrepresented, [{ jobId: "jOld", reason: "before_range" }]);

  // ---- and the row census ------------------------------------------------
  eq(
    "ספירה לפי מקור",
    countBySource(r.rows),
    { production: 4, bundle: 1, misc: 1, milestone: 1, import: 1 }
  );
  eq("סך השורות", r.rows.length, 8);
  eq("אפס התנגשויות", r.conflicts, []);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 11. סטטוס חיוב: deriveState + TAB_META, והיעדר job ─────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const cases: [string, { paid: string | null; invoice_biz: string | null; invoice_tax: string | null }, string][] = [
    ["purple — לא חויב", { paid: "לא", invoice_biz: null, invoice_tax: null }, "purple"],
    ["blue — יש עסקה", { paid: "לא", invoice_biz: "40301", invoice_tax: null }, "blue"],
    ["red — שולם בלי מס", { paid: "כן", invoice_biz: "40301", invoice_tax: null }, "red"],
    ["closed — שולם + מס", { paid: "כן", invoice_biz: "40301", invoice_tax: "60301" }, "closed"],
    ["closed — ללא חיוב", { paid: "ללא חיוב", invoice_biz: null, invoice_tax: null }, "closed"],
  ];
  for (const [label, facts, want] of cases) {
    const b = billStatusFor([facts]);
    eq(label, b.state, want);
    eq(`  והתווית מ-TAB_META (${want})`, b.label, TAB_META[want as keyof typeof TAB_META].label);
    eq(`  והצבע מ-TAB_META (${want})`, b.color, TAB_META[want as keyof typeof TAB_META].color);
  }

  // 🔴 NO JOB. Not "purple", not a fifth FinanceState.
  const none = billStatusFor([]);
  eq("🔴 בלי job → state null", none.state, null);
  eq("🔴 בלי job → \"טרם חויבה\"", none.label, NO_JOB_LABEL);
  eq("ובפרט לא \"לא חויב\"", none.label === TAB_META.purple.label, false);

  // FinanceState was NOT extended — TAB_META still has exactly four keys, so
  // /finance's tab bar is untouched by this change.
  eq("TAB_META נשאר עם ארבעה ערכים", Object.keys(TAB_META).sort(), ["blue", "closed", "purple", "red"]);

  // the least finished of several jobs wins
  const mixed = billStatusFor([
    { paid: "כן", invoice_biz: "1", invoice_tax: "2" }, // closed
    { paid: "לא", invoice_biz: null, invoice_tax: null }, // purple
  ]);
  eq("שני jobs — המצב הפחות גמור מנצח", mixed.state, "purple");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 12. סטטוס הפקה: STATUS_LABEL מיובא, לא regex ───────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  eq("הופץ", productionStatusCell("הופץ")?.label, STATUS_LABEL["הופץ"]);
  eq("נשלח_ללקוח → רווח", productionStatusCell("נשלח_ללקוח")?.label, "נשלח ללקוח");
  // the value with punctuation in it — the one the hand-rolled regex got right
  // by luck rather than by rule
  eq('אושר_ע"י_לקוח', productionStatusCell('אושר_ע"י_לקוח')?.label, 'אושר ע"י לקוח');
  eq("ושזה בדיוק STATUS_LABEL", productionStatusCell('אושר_ע"י_לקוח')?.label, STATUS_LABEL['אושר_ע"י_לקוח']);
  eq("ריק → null (קו מפריד)", productionStatusCell(null), null);
  // a value this build does not know renders ITSELF — version-skew discipline
  eq("ערך לא מוכר מרונדר את עצמו", productionStatusCell("מצב_חדש")?.label, "מצב_חדש");

  // misc keeps its own vocabulary and its own tones, named never ranged
  for (const st of ["נפתח", "בעבודה", "הושלם", "בוטל"]) {
    eq(`misc ${st}`, miscStatusCell(st)?.color, MISC_STATUS_TONE[st]);
  }
  eq("misc לא מוכר → נייטרלי", miscStatusCell("משהו")?.color, "var(--dim)");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 13. פילטרים: מקור · לקוח · סטטוס חיוב ──────────────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = build({
    productions: [
      prod({ id: "pA", client_name: "לקוח א", jobs: [{ id: "jA", paid: "לא", invoice_biz: null, invoice_tax: null }] }),
      prod({ id: "pB", client_name: "לקוח ב", jobs: [] }),
    ],
    misc: [
      misc({
        id: "wA",
        client_name: "לקוח א",
        job_id: "jW",
        jobFacts: { paid: "לא", invoice_biz: null, invoice_tax: null },
      }),
    ],
    jobs: [
      job({ id: "jA", date: "2026-08-12" }),
      job({ id: "jW", date: "2026-08-05" }),
      job({ id: "jB", date: "2026-08-22", client_name: "לקוח ג" }),
    ],
    linkedJobIds: ["jA"],
  });
  eq("ארבע שורות בסך הכל", r.rows.length, 4);

  const n = (f: Parameters<typeof matchesFilter>[1]) => r.rows.filter((x) => matchesFilter(x, f)).length;

  // EMPTY = no filter, never "match nothing"
  eq("סינון ריק → הכול", n(EMPTY_FILTER), 4);
  eq("ואינו נחשב פעיל", isFilterActive(EMPTY_FILTER), false);

  eq("מקור=הפקה", n({ ...EMPTY_FILTER, sources: ["production"] }), 2);
  eq("מקור=רדיו ושונות", n({ ...EMPTY_FILTER, sources: ["misc"] }), 1);
  eq("מקור=מרוכזת", n({ ...EMPTY_FILTER, sources: ["bundle"] }), 1);
  eq("רבי-בחירה: הפקה+מרוכזת", n({ ...EMPTY_FILTER, sources: ["production", "bundle"] }), 3);
  eq("מקור=אבן דרך (אין)", n({ ...EMPTY_FILTER, sources: ["milestone"] }), 0);

  eq("לקוח א", n({ ...EMPTY_FILTER, client: "לקוח א" }), 2);
  eq("לקוח ג", n({ ...EMPTY_FILTER, client: "לקוח ג" }), 1);
  eq("לקוח שאינו קיים", n({ ...EMPTY_FILTER, client: "לקוח ד" }), 0);

  // bill status: pA, wA and jB are purple; pB has no job at all -> "none"
  eq("סטטוס=purple", n({ ...EMPTY_FILTER, bills: ["purple"] }), 3);
  eq("סטטוס=טרם חויבה", n({ ...EMPTY_FILTER, bills: ["none"] }), 1);
  eq("purple + none", n({ ...EMPTY_FILTER, bills: ["purple", "none"] }), 4);

  // 🔴 A CONSEQUENCE OF 0041, PINNED HERE BECAUSE IT READS LIKE A BUG.
  // page.tsx resolves `jobFacts` off the NON-dismissed job list, so a misc row
  // whose only job was dismissed arrives with job_id set and jobFacts null —
  // and shows "טרם חויבה". That is the house rule ("a dismissed job is out of
  // every money surface") applied consistently, not an oversight: the row has
  // no LIVE billing object, and claiming a status from a withdrawn job would be
  // reading money off a record /finance refuses to show. The job still counts
  // as claimed, so it never doubles as a job-only row.
  const dismissedJob = build({
    misc: [misc({ id: "wDis", job_id: "jDis", jobFacts: null })],
    jobs: [job({ id: "jDis", date: "2026-08-05", dismissed: true })],
  });
  eq("misc עם job מוסתר — שורה אחת", dismissedJob.rows.length, 1);
  eq("ומציגה טרם חויבה", dismissedJob.rows[0].billStatus.label, NO_JOB_LABEL);
  eq("וה-job לא הופיע כ-job-only", dismissedJob.rows[0].source, "misc");

  // two axes together
  eq("לקוח א + רדיו ושונות", n({ sources: ["misc"], client: "לקוח א", bills: [] }), 1);
  eq("לקוח ב + רדיו ושונות → 0", n({ sources: ["misc"], client: "לקוח ב", bills: [] }), 0);
  eq("סינון דו-צירי נחשב פעיל", isFilterActive({ sources: ["misc"], client: "לקוח א", bills: [] }), true);

  eq("ספירה לפי מקור", countBySource(r.rows), { production: 2, bundle: 1, misc: 1, milestone: 0, import: 0 });
  eq("רשימת הלקוחות ממוינת ומיוחדת", clientOptions(r.rows), ["לקוח א", "לקוח ב", "לקוח ג"]);

  // the filter keys and their labels
  eq("חמישה מפתחות סינון חיוב", BILL_FILTER_KEYS.length, 5);
  eq("ו-\"none\" הוא טרם חויבה", billFilterLabel("none"), NO_JOB_LABEL);
  eq("ו-purple הוא של TAB_META", billFilterLabel("purple"), TAB_META.purple.label);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 14. excludedJobIds ו-jobOnlyCandidates — הכלל עצמו ─────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const ex = excludedJobIds({
    linkedJobIds: ["a", "a", "b"],
    miscJobIds: ["c", null, undefined],
    milestoneJobIds: ["d", null],
  });
  eq("איחוד של שלוש העמודות", Array.from(ex).sort(), ["a", "b", "c", "d"]);
  eq("null/undefined אינם חברים", ex.has(""), false);

  const js = [
    { id: "a", dismissed: false },
    { id: "b", dismissed: false },
    { id: "e", dismissed: false },
    { id: "f", dismissed: true },
  ];
  eq("מועמדים = לא נתבעים ולא dismissed", jobOnlyCandidates(js, ex).map((j) => j.id), ["e"]);
  eq("קבוצה ריקה → הכול חוץ מ-dismissed", jobOnlyCandidates(js, new Set()).map((j) => j.id), ["a", "b", "e"]);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 15. מיון: סופי, ושורה בלי תאריך בסוף ───────────────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const mk = (key: string, date: string | null): UnifiedRow =>
    ({ key, date, month: "2026-08" } as UnifiedRow);
  const sorted = [mk("c", null), mk("b", "2026-08-20"), mk("a", "2026-08-05")]
    .slice()
    .sort(compareUnified)
    .map((r) => r.key);
  eq("כרונולוגי, חסר-תאריך בסוף", sorted, ["a", "b", "c"]);
  // a TOTAL order — two rows sharing a date resolve by key, so the order cannot
  // flip between renders
  const tie = [mk("z", "2026-08-05"), mk("a", "2026-08-05")].slice().sort(compareUnified).map((r) => r.key);
  eq("שובר שוויון לפי key", tie, ["a", "z"]);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 16. המודל: הפקה מבוטלת/פנימית ו-misc מבוטל ─────────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = build({
    productions: [
      prod({ id: "pCan", cancelled: true }),
      prod({ id: "pInt", internal: true, client_name: null }),
    ],
    misc: [misc({ id: "wCan", status: "בוטל" })],
  });
  eq("שלוש שורות — כולן נראות", r.rows.length, 3);
  const byId = (k: string) => r.rows.find((x) => x.key === k)!;
  eq("הפקה מבוטלת מחוץ לכסף", byId("production:pCan").excludedFromMoney, true);
  eq("ומסומנת מבוטלת", byId("production:pCan").cancelled, true);
  eq("הפקה פנימית מחוץ לכסף", byId("production:pInt").excludedFromMoney, true);
  eq("אך אינה מבוטלת", byId("production:pInt").cancelled, false);
  // 'בוטל' NAMED, never ranged — it is the LAST value of the misc enum
  eq("misc בוטל מחוץ לכסף", byId("misc:wCan").excludedFromMoney, true);
  eq("ומסומן מבוטל", byId("misc:wCan").cancelled, true);
  eq("misc הושלם — בתוך הכסף", build({ misc: [misc()] }).rows[0].excludedFromMoney, false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 17. empty_reason ו-billing עוברים רק על שורות הפקה ─────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = build({
    productions: [prod({ id: "pX", price: null, billing: "contract", contract_name: "ביפו", empty_reason_text: "חודשי · ייצא בסוף החודש" })],
    misc: [misc({ id: "wX" })],
    jobs: [job({ id: "jX", date: "2026-08-22" })],
  });
  const p = r.rows.find((x) => x.source === "production")!;
  eq("הפקה: billing עובר", p.billing, "contract");
  eq("הפקה: שם החוזה עובר", p.contractName, "ביפו");
  eq("הפקה: נוסח התא הריק עובר", p.emptyReasonText, "חודשי · ייצא בסוף החודש");
  for (const s of ["misc", "bundle"]) {
    const row = r.rows.find((x) => x.source === s)!;
    eq(`${s}: billing null`, row.billing, null);
    eq(`${s}: emptyReasonText null`, row.emptyReasonText, null);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 18. הנוסחים המאושרים (5.10) ────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  eq("חמישה מקורות", ROW_SOURCES.length, 5);
  eq(
    "התגיות, בסדר שהבעלים נקב",
    ROW_SOURCES.map((s) => SOURCE_LABEL[s]),
    ["הפקה", "מרוכזת", "רדיו ושונות", "אבן דרך", "ייבוא"]
  );
  eq("בלי job", NO_JOB_LABEL, "טרם חויבה");
  eq("תאריך הקלטה", DATE_MEANING_TITLE.record, "תאריך הקלטה");
  eq("תאריך העבודה", DATE_MEANING_TITLE.work, "תאריך העבודה");
  eq("תאריך הנפקה", DATE_MEANING_TITLE.issued, "תאריך הנפקת ההזמנה, לא תאריך העבודה");
  eq("תאריך המסמך", DATE_MEANING_TITLE.document, "תאריך המסמך");

  const client = readFileSync(join(__dirname, "../src/app/projects/ProjectsClient.tsx"), "utf8");
  const want = [
    "כל עבודה שמתבצעת במערכת לפי חודש",
    "הפקות, הזמנות מרוכזות, רדיו ושונות\n        ואבני דרך של חוזים",
    "אין עבודות בחודש הזה.",
    "אין עבודות מהמקורות שנבחרו בחודש הזה.",
    "עבודות)",
  ];
  for (const w of want) check(`הנוסח על המסך: ${w.slice(0, 34)}…`, client.includes(w));
  // the columns, in the approved order
  const headerOrder = ["תאריך</th>", "מקור</th>", "לקוח</th>", "תוכנית / עבודה</th>", "תיאור</th>", "סכום</th>", "סטטוס הפקה", "סטטוס חיוב"];
  let at = -1;
  let ordered = true;
  for (const h of headerOrder) {
    const i = client.indexOf(h, at + 1);
    if (i <= at) ordered = false;
    at = i;
  }
  check("שמונה הכותרות בסדר המאושר", ordered);
  // the old wording is gone
  check('"אין הפקות בחודש הזה" הוסר', !client.includes("אין הפקות בחודש הזה"));
  check('"תאריך הקלטה</th>" הוסר מהכותרת', !client.includes("תאריך הקלטה</th>"));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 19. 🔴 אכיפה: replace(/_/g — אפס מופעים במסך ───────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const client = readFileSync(join(__dirname, "../src/app/projects/ProjectsClient.tsx"), "utf8");
  const page = readFileSync(join(__dirname, "../src/app/projects/page.tsx"), "utf8");
  // The hand-rolled status label. STATUS_LABEL is the rule; a regex beside it is
  // a second implementation, and this is what keeps it from coming back.
  check('ProjectsClient: אפס "replace(/_/g"', !client.includes("replace(/_/g"));
  check('page.tsx: אפס "replace(/_/g"', !page.includes("replace(/_/g"));
  check("ואין פונקציית statusLabel מקומית", !client.includes("const statusLabel ="));
  // the rule is reached through the one module that owns it
  check("lib/projects/unified מייבא STATUS_LABEL", readFileSync(join(__dirname, "../src/lib/projects/unified.ts"), "utf8").includes('from "@/lib/productions/status"'));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 20. 🔴 אכיפה: קריאה בלבד — אפס כתיבה בקבצים ששונו ─────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  // The owner's constraint was READ-ONLY: zero writes, and no touching the
  // document or job paths. That is a property of the files' TEXT, not of any
  // return value, so it is checked the way test_contract_quota.ts checks its
  // own separation — by reading them.
  const CHANGED = [
    "src/lib/projects/unified.ts",
    "src/lib/projects/row.ts",
    "src/lib/misc/status.ts",
    "src/app/projects/page.tsx",
    "src/app/projects/ProjectsClient.tsx",
    "src/app/misc/MiscClient.tsx",
  ];

  // Writes, in PostgREST's spelling. `.update(` is excluded from the list on
  // purpose for MiscClient, which has always had its own board writes — so the
  // check is scoped per file below rather than applied flat.
  const WRITE_CALLS = [".insert(", ".upsert(", ".delete(", ".rpc(\"insert", "service_role"];
  const MONEY_TABLES = ['from("jobs")', 'from("job_productions")', 'from("pending_documents")', 'from("documents")', 'from("invoices")', 'from("productions")', 'from("misc_productions")', 'from("contract_milestones")'];

  for (const rel of CHANGED) {
    const text = readFileSync(join(__dirname, "..", rel), "utf8");
    for (const w of WRITE_CALLS) {
      check(`${rel}: אפס ${w}`, !text.includes(w));
    }
  }

  // The two LIB modules must be pure: no Supabase, no fetch, no document path.
  for (const rel of ["src/lib/projects/unified.ts", "src/lib/projects/row.ts", "src/lib/misc/status.ts"]) {
    const text = readFileSync(join(__dirname, "..", rel), "utf8");
    // `import` lines only — the prose above these modules names lib/documents
    // deliberately, and a flat substring test would fail on the comment that
    // promises the very thing being tested. (test_contract_quota hit exactly
    // this and fixed the TEST, not the code.)
    const imports = text.split("\n").filter((l) => /^\s*import\b/.test(l)).join("\n");
    check(`${rel}: אינו מייבא supabase`, !/supabase/i.test(imports));
    check(`${rel}: אינו מייבא lib/documents`, !imports.includes("@/lib/documents"));
    check(`${rel}: אינו מייבא lib/morning/client`, !imports.includes("@/lib/morning/client"));
    check(`${rel}: אפס fetch(`, !text.includes("fetch("));
    // ...and no clock: a pure function that reads `now` is a function whose
    // tests expire. 🔴 CHECKED AGAINST THE CODE, NOT THE PROSE — the header of
    // unified.ts names `todayInIsrael()` twice, once to promise it is never
    // called and once to explain that bundle-from-show calls it. A flat
    // substring test failed on the comment that documents the very rule it was
    // testing, which is the trap test_contract_quota.ts hit and fixed in the
    // TEST rather than in the code.
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    for (const clock of ["todayInIsrael", "Date.now", "new Date("]) {
      check(`${rel}: אינו קורא את השעון (${clock})`, !code.includes(clock));
    }
  }

  // page.tsx may READ every money table — that is its whole job — but must not
  // write to one. Asserted by the absence of the write verbs above, plus this:
  const page = readFileSync(join(__dirname, "../src/app/projects/page.tsx"), "utf8");
  check("page.tsx: אפס .update(", !page.includes(".update("));
  check("page.tsx: אינו מייבא enqueue/bundle/issue", !/@\/lib\/documents\/(enqueue|bundle|issue)/.test(page));
  check("page.tsx: אינו מייבא lib/morning/client", !page.includes("@/lib/morning/client"));
  // the one RPC it is allowed to call, and it is a pure function of two scalars
  check("page.tsx: ה-RPC היחיד הוא due_date_for", (page.match(/\.rpc\(/g) ?? []).length === 1 && page.includes('rpc("due_date_for"'));
  // and it still reads the misc table — the point of the change
  check("page.tsx: קורא misc_productions", page.includes('from("misc_productions")'));
  for (const t of MONEY_TABLES) {
    // every money table reference in page.tsx must be a `.select(` within the
    // next 400 characters — i.e. a read
    let i = page.indexOf(t);
    while (i !== -1) {
      const window = page.slice(i, i + 400);
      check(`page.tsx: ${t} נקרא ולא נכתב`, window.includes(".select("));
      i = page.indexOf(t, i + 1);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${failures === 0 ? "✅" : "❌"}  ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
