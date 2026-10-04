/**
 * "יצירת עבודה לחיוב" — the gate, the amount rule, and the suggestion, as pure
 * functions. Plus a STATIC READ of the route, for the two guarantees that are
 * about the code and not about a return value.
 *
 * Run:  npx tsx scripts/test_create_job_for_production.ts
 *
 * NO DATABASE, NO SERVER, NO NETWORK. There is no Supabase client in this
 * file, and F19 is why that matters: the two live cases this feature was built
 * for (SFI 10311/10312 and מכון דוידסון 12.7) are owner actions on real money,
 * and nothing here may touch them. Everything below is arithmetic and text.
 *
 * ═══ WHY A SOURCE READ IS A TEST HERE ═══
 * The owner's gate G2 was "creating a job must not queue a document or call
 * Morning". That is not a property of any return value — it is a property of
 * which modules the route imports and which tables it writes. A unit test that
 * mocked Supabase would assert that the MOCK was not called, which is a test of
 * the mock. So the last two checks read the route's own text and fail if an
 * insert into pending_documents, or any Morning import, ever appears in it.
 * Crude on purpose: it cannot be satisfied by accident.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CREATE_JOB_COPY,
  MAX_JOB_AMOUNT,
  createJobGate,
  jobAmountError,
} from "../src/lib/productions/createJob";
import {
  suggestJobAmount,
  type ProductionForBilling,
  type ShowForBilling,
} from "../src/lib/documents/enqueue";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── the two live productions, as data ──────────────────────────────────────
// SFI, 17.8.2026, per_episode at ₪1,000 net (the work orders are ₪1,180 gross)
const sfiProd = (over: Partial<ProductionForBilling> = {}): ProductionForBilling => ({
  id: "sfi-1",
  kind: "client",
  legacy: false,
  client_id: "sfi",
  show_id: "sfi-show",
  podcast_name: "SFI",
  record_date: "2026-08-17",
  guest: null,
  price_override: null,
  status: 'ממתין_לתגובת_לקוח',
  studio_hours: null,
  ...over,
});
const sfiShow: ShowForBilling = {
  id: "sfi-show",
  client_id: "sfi",
  billing_mode: "per_episode",
  default_rate: 1000,
  pricing_model: "per_episode",
  hourly_rate: null,
};
// מכון דוידסון: per_hour, default_rate NULL BY CONSTRAINT (0067:166-170), and
// the owner's hypothesis of ₪250/hour × 4 hours = the ₪1,000 net of 40299.
const davidsonShow: ShowForBilling = {
  id: "dav-show",
  client_id: "dav",
  billing_mode: "per_episode",
  default_rate: null,
  pricing_model: "per_hour",
  hourly_rate: 250,
};
const davidsonProd = (over: Partial<ProductionForBilling> = {}): ProductionForBilling => ({
  id: "dav-1",
  kind: "client",
  legacy: true,
  client_id: "dav",
  show_id: "dav-show",
  podcast_name: "מכון דודיסון",
  record_date: "2026-07-12",
  guest: null,
  price_override: null,
  status: "הופץ",
  studio_hours: null,
  ...over,
});

console.log("\n── the gate ──");

check(
  "a production that already has a job is refused, 409",
  (() => {
    const g = createJobGate({ hasJob: true, cancelled: false, clientId: "sfi" });
    return !g.ok && g.status === 409 && g.error === "להפקה כבר יש עבודה.";
  })()
);

check(
  "a cancelled production is refused, 400",
  (() => {
    const g = createJobGate({ hasJob: false, cancelled: true, clientId: "sfi" });
    return !g.ok && g.status === 400 && g.error.includes("מבוטלת");
  })()
);

check(
  "a production with no client is refused, 400",
  (() => {
    const g = createJobGate({ hasJob: false, cancelled: false, clientId: null });
    return !g.ok && g.status === 400 && g.error.includes("לקוח");
  })()
);

check(
  "hasJob wins over cancelled — the 409 is the more actionable diagnosis",
  (() => {
    const g = createJobGate({ hasJob: true, cancelled: true, clientId: null });
    return !g.ok && g.status === 409;
  })()
);

check(
  "SFI's two rows pass the gate as they stand today",
  createJobGate({ hasJob: false, cancelled: false, clientId: "sfi" }).ok
);

check(
  "the Davidson row passes it too (legacy and 'הופץ' are not gates)",
  createJobGate({ hasJob: false, cancelled: false, clientId: "dav" }).ok
);

console.log("\n── the amount ──");

check("a missing amount is refused", jobAmountError(undefined) === "יש להזין סכום");
check("null is refused as missing, not as 'not a number'", jobAmountError(null) === "יש להזין סכום");
check("an empty string is refused", jobAmountError("") === "יש להזין סכום");
check("whitespace only is refused", jobAmountError("   ") === "יש להזין סכום");
check("letters are refused", jobAmountError("אלף") === "הסכום אינו מספר תקין");
check("zero is refused", jobAmountError(0) === "הסכום חייב להיות גדול מאפס");
check("zero as a string is refused", jobAmountError("0") === "הסכום חייב להיות גדול מאפס");
check("a negative amount is refused", jobAmountError(-1000) === "הסכום חייב להיות גדול מאפס");
check(
  "a third decimal is refused while the author can still see the field",
  jobAmountError(1000.555) === "הסכום מוגבל לשתי ספרות אחרי הנקודה"
);
check("above the ceiling is refused", jobAmountError(MAX_JOB_AMOUNT + 1) !== null);
check("the ceiling itself is accepted", jobAmountError(MAX_JOB_AMOUNT) === null);
check("1000 — the Davidson amount — is accepted", jobAmountError(1000) === null);
check("1000 as a string is accepted", jobAmountError("1000") === null);
check("two decimals are accepted", jobAmountError(1000.25) === null);
// Infinity / NaN arrive from a form as text; from a forged POST they arrive as
// numbers. Both reach the same refusal, which is the point of one spelling.
check("Infinity is refused", jobAmountError(Infinity) === "הסכום אינו מספר תקין");
check("NaN is refused", jobAmountError(NaN) === "הסכום אינו מספר תקין");

console.log("\n── the suggestion ──");

check(
  "per_hour with hours and a rate → hours × rate (4 × 250 = 1000)",
  suggestJobAmount(davidsonProd({ studio_hours: 4 }), davidsonShow) === 1000,
  String(suggestJobAmount(davidsonProd({ studio_hours: 4 }), davidsonShow))
);

check(
  "per_hour with a rate but NO hours → no suggestion (the Davidson row as it will be born)",
  suggestJobAmount(davidsonProd(), davidsonShow) === null
);

check(
  "per_hour with hours but NO rate → no suggestion, and it does not fall back to default_rate",
  suggestJobAmount(davidsonProd({ studio_hours: 4 }), { ...davidsonShow, hourly_rate: null }) === null
);

check(
  "per_episode → default_rate (SFI: 1000)",
  suggestJobAmount(sfiProd(), sfiShow) === 1000
);

check(
  "per_episode with no default_rate → no suggestion",
  suggestJobAmount(sfiProd(), { ...sfiShow, default_rate: null }) === null
);

check(
  "price_override wins in both models",
  suggestJobAmount(sfiProd({ price_override: 777 }), sfiShow) === 777 &&
    suggestJobAmount(davidsonProd({ price_override: 777, studio_hours: 4 }), davidsonShow) === 777
);

check(
  "no show at all → no suggestion rather than a throw",
  suggestJobAmount(sfiProd(), null) === null
);

check(
  "the suggestion is the BASE only — it is effectivePrice and nothing else",
  suggestJobAmount(davidsonProd({ studio_hours: 1.5 }), { ...davidsonShow, hourly_rate: 333.33 }) === 500,
  "rounding at the point of derivation: 1.5 × 333.33 = 499.995 → 500.00"
);

console.log("\n── the route, read as text (G2) ──");

const ROUTE = join(process.cwd(), "src/app/api/productions/[id]/create-job/route.ts");
const src = readFileSync(ROUTE, "utf8");
// Comments stripped for every assertion about what the CODE does. The route's
// header names enqueueDocument and Morning in order to say it does not reach
// them, and a check that read the prose would fail on the sentence promising
// the thing it is checking. (No URLs or regexes in this file, so the naive
// strip is safe here and is not offered as a general tool.)
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

check(
  "the job is dated by record_date",
  /date:\s*prod\.record_date/.test(code)
);

check(
  "and its only fallback is the Israel-day helper, never a raw `new Date()`",
  /todayInIsrael\(\)/.test(code) && !/new Date\(\)/.test(code)
);

check("paid is written explicitly as 'לא'", /paid:\s*"לא"/.test(code));

check(
  "campaign is the production's podcast_name — the same value the DB writes",
  /campaign:\s*prod\.podcast_name/.test(code)
);

check("due_date is NOT computed here (trg_compute_due_date owns it)", !/due_date/.test(code));

check(
  "the route writes NOTHING to pending_documents",
  !/from\(\s*["']pending_documents["']\s*\)/.test(code)
);

check(
  "the route references nothing that can reach Morning",
  !/enqueueDocument|issuePendingDocument|lib\/morning|morningRequest/.test(code)
);

check(
  "the only tables the route touches are productions, shows, jobs, job_productions and events",
  (() => {
    const tables = Array.from(code.matchAll(/\.from\(\s*["']([a-z_]+)["']\s*\)/g)).map((m) => m[1]);
    const allowed = new Set(["productions", "shows", "job_productions", "jobs", "events"]);
    return tables.length > 0 && tables.every((t) => allowed.has(t));
  })(),
  Array.from(new Set(Array.from(code.matchAll(/\.from\(\s*["']([a-z_]+)["']\s*\)/g)).map((m) => m[1]))).join(", ")
);

console.log("\n── the bundle message (the dead end that sent us here) ──");

const bundleSrc = readFileSync(join(process.cwd(), "src/lib/documents/bundle.ts"), "utf8");
check(
  "the old sentence about client approval is gone",
  !bundleSrc.includes("לא נמצאו עבודות מאושרות")
);
check(
  "the new one names the missing thing and the action",
  bundleSrc.includes("לפרקים האלה אין עבודה במערכת") && bundleSrc.includes(CREATE_JOB_COPY.button)
);

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
