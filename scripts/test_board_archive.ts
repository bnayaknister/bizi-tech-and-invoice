/**
 * Q10 — archiving productions off the "הופץ" column of the kanban.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_board_archive.ts
 *
 * ═══ F19 ═══
 * No database, no network. The database is scripts/_fake_db.ts; `global.fetch`
 * throws. The TRIGGER half of 0112 (status change unarchives, session writes
 * refused) is SQL and is proven by supabase/verify/0112_dryrun.sql and by
 * supabase/verify/_0112_local_trigger_tests.sql on a local Postgres stub — this
 * suite proves the app half and the boundaries.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fakeDb, type Row } from "./_fake_db";
import {
  archiveEligibility,
  ARCHIVE_REASON,
  type ArchiveFacts,
  type ArchiveJob,
} from "../src/lib/productions/archiveEligibility";
import { loadArchiveFacts } from "../src/lib/productions/archiveFacts";
import { handleBoardArchive, handleBoardEligibility, boardEligibility, BOARD_ARCHIVE_FORBIDDEN } from "../src/lib/productions/boardArchive";
import { perfTimer } from "../src/lib/perf/timing";

global.fetch = (async (url: string) => {
  throw new Error("F19: this suite must not perform any fetch: " + url);
}) as unknown as typeof fetch;

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}\n       got:  ${g}\n       want: ${w}`);
  }
}
const section = (t: string) => console.log(`\n── ${t}`);

const HOFATZ = "הופץ";
const CLOSED: Omit<ArchiveJob, "id"> = { paid: "כן", invoice_biz: "40001", invoice_tax: "50001" };
const job = (id: string, over: Partial<ArchiveJob> = {}): ArchiveJob => ({ id, ...CLOSED, ...over });
const clientShow = { client_id: "c1", billing_mode: "per_episode" };
const facts = (over: Partial<ArchiveFacts> = {}): ArchiveFacts => ({
  status: HOFATZ,
  kind: "client",
  show: clientShow,
  jobs: [job("j1")],
  targets: {},
  ...over,
});
const elig = (f: ArchiveFacts) => archiveEligibility(f);
const ok = { eligible: true, reason: null };

async function main() {
  section("1. eligibility — the owner's cases (13.10 #2)");
  check("client, one closed job (paid + tax invoice) -> eligible", elig(facts()), ok);
  check("client, ללא חיוב -> eligible (deriveState: closed)", elig(facts({ jobs: [job("j1", { paid: "ללא חיוב", invoice_tax: null })] })), ok);
  check("not in הופץ -> refused", elig(facts({ status: 'אושר_ע"י_לקוח' })), { eligible: false, reason: ARCHIVE_REASON.notHofatz });
  check("contract production -> refused", elig(facts({ kind: "contract" })), { eligible: false, reason: ARCHIVE_REASON.contract });
  check("contract show -> refused", elig(facts({ show: { client_id: "c1", billing_mode: "contract" } })), { eligible: false, reason: ARCHIVE_REASON.contract });
  check("client without a job -> refused", elig(facts({ jobs: [] })), { eligible: false, reason: ARCHIVE_REASON.noJob });
  check("client whose only job is dismissed -> counts as no job", elig(facts({ jobs: [job("j1", { dismissed: true })] })), { eligible: false, reason: ARCHIVE_REASON.noJob });
  check("paid='לא ידוע' -> refused, with its own sentence", elig(facts({ jobs: [job("j1", { paid: "לא ידוע" })] })), { eligible: false, reason: ARCHIVE_REASON.unknown });
  check("open, no deal invoice (purple)", elig(facts({ jobs: [job("j1", { paid: "לא", invoice_biz: null, invoice_tax: null })] })).reason, "הכסף טרם נסגר: עוד לא הופק חשבון עסקה.");
  check("open, deal invoice out (blue)", elig(facts({ jobs: [job("j1", { paid: "לא", invoice_tax: null })] })).reason, "הכסף טרם נסגר: חשבון עסקה הופק והתשלום טרם התקבל.");
  check("paid but no tax invoice (red) is NOT closed", elig(facts({ jobs: [job("j1", { invoice_tax: null })] })).eligible, false);
  check("a whitespace tax number is not a tax number (deriveState's `present`)", elig(facts({ jobs: [job("j1", { invoice_tax: "  " })] })).eligible, false);

  section("2. several jobs");
  check("two jobs, both closed -> eligible", elig(facts({ jobs: [job("j1"), job("j2")] })), ok);
  check("two jobs, one open -> refused", elig(facts({ jobs: [job("j1"), job("j2", { paid: "לא" })] })).eligible, false);
  check("two jobs, one 'לא ידוע' -> the unknown sentence", elig(facts({ jobs: [job("j1"), job("j2", { paid: "לא ידוע" })] })).reason, ARCHIVE_REASON.unknown);
  check("an open job that is dismissed does not block", elig(facts({ jobs: [job("j1"), job("j2", { paid: "לא", dismissed: true })] })), ok);

  section("3. folded jobs are judged by their target (bundle / consolidated)");
  {
    const sib = job("j9", { paid: "לא", invoice_tax: null });
    const f = facts({ targets: { j1: [{ kind: "bundle", label: "חשבון עסקה 40291", jobs: [job("j1"), sib] }] } });
    const r = elig(f);
    check("own job closed, bundle sibling open -> refused", r.eligible, false);
    check("…and the reason names the target and counts", r.reason, "הכסף טרם נסגר: חשבון עסקה הופק והתשלום טרם התקבל. (חשבון עסקה 40291, שההפקה אוחדה אליו: 1 מתוך 2 עבודות סגורות)");
    check("bundle fully closed -> eligible", elig(facts({ targets: { j1: [{ kind: "bundle", label: "x", jobs: [job("j1"), job("j9")] }] } })), ok);
  }
  {
    const f = facts({
      targets: { j1: [{ kind: "consolidated", label: "הזמנת עבודה מאוחדת 10317", jobs: [job("j1"), job("j2"), job("j3", { paid: "לא ידוע" })] }] },
    });
    check("consolidated work order with a 'לא ידוע' sibling -> unknown, via the target", elig(f).reason, `${ARCHIVE_REASON.unknown} (הזמנת עבודה מאוחדת 10317, שההפקה אוחדה אליו: 2 מתוך 3 עבודות סגורות)`);
  }
  check(
    "a target row that does not list the job still includes it",
    elig(facts({ jobs: [job("j1", { paid: "לא" })], targets: { j1: [{ kind: "bundle", label: "x", jobs: [job("j8")] }] } })).eligible,
    false
  );

  section("4. internal productions");
  check("show without a client, no job -> eligible", elig(facts({ kind: "client", show: { client_id: null, billing_mode: "per_episode" }, jobs: [] })), ok);
  check("billing_mode=none, no job -> eligible", elig(facts({ show: { client_id: "c1", billing_mode: "none" }, jobs: [] })), ok);
  check("kind=internal, no job -> eligible", elig(facts({ kind: "internal", jobs: [] })), ok);
  check("no show at all, no job -> internal -> eligible", elig(facts({ show: null, jobs: [] })), ok);
  check("internal with an unpaid job -> refused", elig(facts({ kind: "internal", jobs: [job("j1", { paid: "לא", invoice_tax: null })] })).reason, `${ARCHIVE_REASON.internalOpen} — הכסף טרם נסגר: חשבון עסקה הופק והתשלום טרם התקבל.`);
  check("internal with a ללא חיוב job -> eligible", elig(facts({ kind: "internal", jobs: [job("j1", { paid: "ללא חיוב" })] })), ok);

  section("5. the loader, on a fake database");
  const world = () => {
    const prod = (id: string, over: Row = {}) => ({ id, status: HOFATZ, kind: "client", show_id: "s1", board_archived_at: null, board_archived_by: null, ...over });
    const jobRow = (id: string, over: Row = {}) => ({ id, paid: "כן", invoice_biz: "40001", invoice_tax: "50001", dismissed: false, ...over });
    return fakeDb({
      productions: [
        prod("p-closed"),
        prod("p-open"),
        prod("p-bundle"),
        prod("p-bundle-sib"),
        prod("p-cons"),
        prod("p-cons-sib"),
        prod("p-internal", { kind: "internal", show_id: "s-int" }),
        prod("p-nojob"),
        prod("p-contract", { kind: "contract" }),
        prod("p-edit", { status: "בעריכה" }),
      ],
      shows: [
        { id: "s1", client_id: "c1", billing_mode: "per_episode" },
        { id: "s-int", client_id: null, billing_mode: "none" },
      ],
      job_productions: [
        { production_id: "p-closed", job_id: "j-closed" },
        { production_id: "p-open", job_id: "j-open" },
        { production_id: "p-bundle", job_id: "j-b1" },
        { production_id: "p-bundle-sib", job_id: "j-b2" },
        { production_id: "p-cons", job_id: "j-c1" },
        { production_id: "p-cons-sib", job_id: "j-c2" },
        { production_id: "p-edit", job_id: "j-edit" },
      ],
      jobs: [
        jobRow("j-closed"),
        jobRow("j-open", { paid: "לא", invoice_tax: null }),
        jobRow("j-b1"),
        jobRow("j-b2", { paid: "לא", invoice_tax: null }),
        jobRow("j-c1"),
        jobRow("j-c2", { paid: "לא ידוע" }),
        jobRow("j-edit"),
      ],
      documents: [
        { id: "d1", type: 300, morning_doc_number: "40291", bundle_job_ids: ["j-b1", "j-b2"], cancelled_at: null },
        { id: "d-dead", type: 300, morning_doc_number: "40999", bundle_job_ids: ["j-closed", "j-open"], cancelled_at: "2026-09-01" },
      ],
      pending_documents: [
        { id: "q-wo", production_id: null, job_id: null, consolidated_into: null, status: "issued", doc_type: "work_order", morning_doc_number: "10317", bundle_job_ids: null },
        { id: "q-c1", production_id: "p-cons", job_id: null, consolidated_into: "q-wo", status: "consolidated", doc_type: "work_order", morning_doc_number: null, bundle_job_ids: null },
        { id: "q-c2", production_id: "p-cons-sib", job_id: null, consolidated_into: "q-wo", status: "consolidated", doc_type: "work_order", morning_doc_number: null, bundle_job_ids: null },
      ],
      events: [],
    });
  };
  {
    const { client } = world();
    const ids = ["p-closed", "p-open", "p-bundle", "p-cons", "p-internal", "p-nojob", "p-contract", "p-edit"];
    const f = await loadArchiveFacts(client as never, ids);
    const r = Object.fromEntries(ids.map((id) => [id, archiveEligibility(f.get(id)!).eligible]));
    check("closed / open / bundle / consolidated / internal / no job / contract / not הופץ", r, {
      "p-closed": true,
      "p-open": false,
      "p-bundle": false,
      "p-cons": false,
      "p-internal": true,
      "p-nojob": false,
      "p-contract": false,
      "p-edit": false,
    });
    check("a cancelled bundle document is not a target", Object.keys(f.get("p-closed")!.targets), []);
    check("the bundle target is named by its document", f.get("p-bundle")!.targets["j-b1"]?.[0]?.label, "חשבון עסקה 40291");
    check("the consolidated target carries the sibling's job", f.get("p-cons")!.targets["j-c1"]?.[0]?.jobs.map((j) => j.id).sort(), ["j-c1", "j-c2"]);
    check("…and the reason is the sibling's 'לא ידוע'", archiveEligibility(f.get("p-cons")!).reason?.startsWith(ARCHIVE_REASON.unknown), true);
  }

  section("6. the route: permission, archive, restore, events");
  const ADMIN = { approved: true, studio_admin: true };
  const now = new Date("2026-10-13T12:00:00Z");
  {
    const { client, calls } = world();
    const r = await handleBoardArchive({ userId: null, profile: null, body: { action: "archive", ids: ["p-closed"] } }, { admin: client as never, now });
    check("no session -> 401", r.status, 401);
    const r2 = await handleBoardArchive({ userId: "u-tech", profile: { approved: true, studio_admin: false }, body: { action: "archive", ids: ["p-closed"] } }, { admin: client as never, now });
    check("approved but not studio_admin -> 403 with the sentence", [r2.status, r2.json.error], [403, BOARD_ARCHIVE_FORBIDDEN]);
    const r3 = await handleBoardArchive({ userId: "u-x", profile: { approved: false, studio_admin: true }, body: { action: "restore", ids: ["p-closed"] } }, { admin: client as never, now });
    check("studio_admin flag on an unapproved account -> 403", r3.status, 403);
    check("…and nothing was read or written for any of them", calls.length, 0);
  }
  {
    const { client, store } = world();
    const r = await handleBoardArchive({ userId: "u-bnaya", profile: ADMIN, body: { action: "archive", ids: ["p-closed"] } }, { admin: client as never, now });
    const row = store.productions.find((p) => p.id === "p-closed")!;
    check("studio_admin archives an eligible production", [r.status, r.json.archived], [200, ["p-closed"]]);
    check("…writes who and when, and NOTHING else on the row", [row.board_archived_at, row.board_archived_by, row.status], [now.toISOString(), "u-bnaya", HOFATZ]);
    const ev = store.events.filter((e) => e.event_type === "production_board_archived");
    check("…one event, with actor and bulk=false", ev.map((e) => [e.entity_id, e.actor_id, (e.payload as Row).bulk]), [["p-closed", "u-bnaya", false]]);
    check("…and jobs / documents were not touched", store.jobs.find((j) => j.id === "j-closed"), { id: "j-closed", paid: "כן", invoice_biz: "40001", invoice_tax: "50001", dismissed: false });

    const again = await handleBoardArchive({ userId: "u-bnaya", profile: ADMIN, body: { action: "archive", ids: ["p-closed"] } }, { admin: client as never, now });
    check("archiving twice is a skip, not a second write", [again.json.archived, (again.json.skipped as Row[]).length], [[], 1]);

    const tech = await handleBoardArchive({ userId: "u-tech", profile: { approved: true, studio_admin: false }, body: { action: "restore", ids: ["p-closed"] } }, { admin: client as never, now });
    check("a non-admin cannot restore", [tech.status, row.board_archived_at], [403, now.toISOString()]);

    const back = await handleBoardArchive({ userId: "u-eli", profile: ADMIN, body: { action: "restore", ids: ["p-closed"] } }, { admin: client as never, now });
    check("studio_admin restores -> back on the column", [back.json.restored, row.board_archived_at, row.board_archived_by], [["p-closed"], null, null]);
    const rev = store.events.filter((e) => e.event_type === "production_board_restored");
    check("…an event with who, and what the archive was", rev.map((e) => [e.actor_id, (e.payload as Row).archived_by]), [["u-eli", "u-bnaya"]]);
  }
  {
    const { client, store } = world();
    const r = await handleBoardArchive({ userId: "u-bnaya", profile: ADMIN, body: { action: "archive", ids: ["p-open"] } }, { admin: client as never, now });
    check("an ineligible production is refused with its reason", [r.json.archived, (r.json.skipped as { reason: string }[])[0]?.reason], [[], "הכסף טרם נסגר: חשבון עסקה הופק והתשלום טרם התקבל."]);
    check("…and stays on the board", store.productions.find((p) => p.id === "p-open")!.board_archived_at, null);
  }

  section("7. bulk: re-checked at execution, skips what changed in between");
  {
    const { client, store } = world();
    // what the board showed as eligible: p-closed, p-internal, and p-late
    store.productions.push({ id: "p-late", status: HOFATZ, kind: "client", show_id: "s1", board_archived_at: null, board_archived_by: null });
    store.job_productions.push({ production_id: "p-late", job_id: "j-late" });
    store.jobs.push({ id: "j-late", paid: "כן", invoice_biz: "40002", invoice_tax: "50002", dismissed: false });
    // …and between the view and the click: a receipt was cancelled on p-late,
    // and p-internal was dragged back to בעריכה
    store.jobs.find((j) => j.id === "j-late")!.paid = "לא";
    store.productions.find((p) => p.id === "p-internal")!.status = "בעריכה";
    const r = await handleBoardArchive(
      { userId: "u-bnaya", profile: ADMIN, body: { action: "archive_bulk", ids: ["p-closed", "p-late", "p-internal"] } },
      { admin: client as never, now }
    );
    check("only the still-eligible one is archived", r.json.archived, ["p-closed"]);
    check("the two that changed are skipped, each with its reason", (r.json.skipped as { id: string; reason: string }[]).map((s) => [s.id, s.reason]), [
      ["p-late", "הכסף טרם נסגר: חשבון עסקה הופק והתשלום טרם התקבל."],
      ["p-internal", ARCHIVE_REASON.notHofatz],
    ]);
    const ev = store.events.filter((e) => e.event_type === "production_board_archived");
    check("bulk events: bulk=true, one batch_id, size and skips recorded", ev.map((e) => {
      const p = e.payload as Row;
      return [p.bulk, typeof p.batch_id, p.batch_size, p.skipped_in_batch];
    }), [[true, "string", 1, 2]]);
  }

  section("7b. T37 — eligibility off the critical path: the same answers, through the new route");
  {
    const { client, store } = world();
    // a merged-away הופץ row: the page never showed it, and neither does this
    store.productions.push({ id: "p-merged", status: HOFATZ, kind: "client", show_id: "s1", merged_into: "p-closed", board_archived_at: null, board_archived_by: null });
    const hofatz = store.productions.filter((p) => p.status === HOFATZ && !p.merged_into).map((p) => p.id as string);
    const direct = await loadArchiveFacts(client as never, hofatz);
    const want = Object.fromEntries(hofatz.map((id) => [id, archiveEligibility(direct.get(id)!)]));
    const got = await boardEligibility(client as never);
    check("every הופץ production: identical eligibility + reason to the direct Q10 computation", got, want);
    check("…covering all the Q10 cases in the world (closed, open, bundle, consolidated, internal, no job, contract)", Object.keys(got).sort(), [
      "p-bundle", "p-bundle-sib", "p-closed", "p-cons", "p-cons-sib", "p-contract", "p-internal", "p-nojob", "p-open",
    ]);
    check("the merged-away row is not in it", "p-merged" in got, false);
    check("a production not in הופץ is not in it", "p-edit" in got, false);

    const r0 = await handleBoardEligibility({ userId: null, profile: null }, { admin: client as never });
    const r1 = await handleBoardEligibility({ userId: "u-tech", profile: { approved: true, studio_admin: false } }, { admin: client as never });
    const r2 = await handleBoardEligibility({ userId: "u-bnaya", profile: ADMIN }, { admin: client as never });
    check("route: 401 / 403 / 200", [r0.status, r1.status, r2.status], [401, 403, 200]);
    check("route: the 403 carries the same sentence as the archive route", r1.json.error, BOARD_ARCHIVE_FORBIDDEN);
    check("route: studio_admin gets exactly boardEligibility", r2.json.eligibility, want);

    // T37 ג — the waves inside loadArchiveFacts are timed
    const lines: string[] = [];
    const perf = perfTimer("t", { force: true, log: (l) => lines.push(l) });
    await boardEligibility(client as never, perf);
    perf.done();
    check("timing: one lap per wave inside loadArchiveFacts", JSON.parse(lines[0]).steps.map((s: { name: string }) => s.name), [
      "hofatz_ids", "af_1_productions", "af_2_shows_links_queue", "af_3_targets_bundles", "af_4_sibling_links", "af_5_jobs", "eligibility",
    ]);
  }
  const page = readFileSync(join(__dirname, "../src/app/productions/page.tsx"), "utf8");
  check("the kanban page no longer computes eligibility (no loadArchiveFacts on the critical path)", /loadArchiveFacts|archiveEligibility\(/.test(page), false);

  section("8. boundaries — nothing outside the board filters an archived production");
  const root = join(__dirname, "..");
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
  const mentions = walk(join(root, "src"))
    .filter((f) => !f.endsWith("database.types.ts"))
    // the COLUMN, not the event name production_board_archived (the drawer's
    // Hebrew label map, E13-8c, names that event and touches no column)
    .filter((f) => /(?<!production_)board_archived/.test(readFileSync(f, "utf8")))
    .map((f) => relative(root, f))
    .sort();
  check("board_archived_* is read/written ONLY by the board, its page, and the archive route + lib", mentions, [
    "src/app/api/productions/board-archive/route.ts",
    "src/app/productions/ProductionsClient.tsx",
    "src/app/productions/page.tsx",
    "src/lib/productions/boardArchive.ts",
  ]);
  for (const f of [
    "src/app/api/calendar/sync/route.ts",
    "src/lib/calendar/createProductionFromEvent.ts",
    "src/app/api/search/route.ts",
    "src/app/api/productions/search/route.ts",
    "src/modules/radar/alerts.ts",
    "src/lib/productions/status.ts",
    "src/app/api/documents/redeem/route.ts",
    "src/lib/documents/enqueue.ts",
    "src/lib/contracts/quota.ts",
    "src/lib/productions/hours.ts",
    "src/lib/documents/accruedCards.ts",
  ]) {
    check(`${f} has no archive filter`, readFileSync(join(root, f), "utf8").includes("board_archived"), false);
  }
  // the sync looks up today's rows by calendar_uid with no archive filter, so
  // an archived production is FOUND and updated, never re-created (a real
  // Postgres run of that shape: _0112_local_trigger_tests.sql, T5)
  const sync = readFileSync(join(root, "src/app/api/calendar/sync/route.ts"), "utf8");
  check("the sync's existing-row query is still calendar_uid + merged_into only", /\.not\("calendar_uid", "is", null\)\s*\.is\("merged_into", null\)\s*\.eq\("record_date", todayIsraelDate\)/.test(sync), true);
  // applyResponse writes status on approval AND on a correction request — 0112's
  // trigger unarchives on any status change, so both are covered by the DB
  const links = readFileSync(join(root, "src/lib/review/links.ts"), "utf8");
  check("applyResponse writes status on approval (trigger unarchives)", links.includes(`patch.status = 'אושר_ע"י_לקוח';`), true);
  check("applyResponse writes status on a correction request (trigger unarchives)", links.includes(`patch.status = "בעריכה";`), true);
  const mig = readFileSync(join(root, "supabase/migrations/0112_board_archive.sql"), "utf8");
  check("0112: any status change clears both columns", /if new\.status is distinct from old\.status then[\s\S]*?new\.board_archived_at := null;\s*new\.board_archived_by := null;/.test(mig), true);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
