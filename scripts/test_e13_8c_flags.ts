/**
 * E13-8c follow-up (owner 18.10) — the two card signals derived from the
 * client's open comments, and the hourly cron's step that lights the red dot.
 *   src/lib/review/attentionFlags.ts      deriveReviewFlags / loadReviewFlags / sweepUnsentComments
 *   src/app/api/cron/review-versions      the step rides the existing hourly cron
 *   src/app/productions/page.tsx + ProductionsClient.tsx   the dots and the words
 *
 * Run:  npx tsx --tsconfig tsconfig.scripts.json scripts/test_e13_8c_flags.ts
 *
 * ═══ F19 ═══ No database, no network: an in-memory fake of the few
 * supabase-js calls these functions make.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deriveReviewFlags, loadReviewFlags, sweepUnsentComments, UNSENT_AFTER_MS, UNSENT_EVENT, type FlagComment } from "../src/lib/review/attentionFlags";
import type { HcApproval } from "../src/lib/review/commentHistory";

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
    console.log(`  ❌ ${name}\n       got:  ${g?.slice(0, 600)}\n       want: ${w?.slice(0, 600)}`);
  }
}
const ok = (name: string, cond: boolean) => check(name, cond, true);
const section = (t: string) => console.log(`\n── ${t}`);

const NOW = Date.parse("2026-10-18T12:00:00Z");
const H = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const c = (id: string, item: string, link: string | null, ageH: number, over: Partial<FlagComment> = {}): FlagComment => ({
  id, item_id: item, link_id: link, created_at: iso(NOW - ageH * H), after_response: false, acked_at: null, resolved_at: null, ...over,
});
const items = [{ id: "I1", production_id: "P1" }, { id: "I2", production_id: "P2" }, { id: "I3", production_id: "P3" }];

async function main() {
  // ══════════════════════════════════════════════════════════════════════
  section("minor — 🟠 'אושר עם הערות' (approved in the same round as a comment)");
  const approvedSameRound: HcApproval[] = [{ item_id: "I1", link_id: "L1", decision: "approved", decided_at: iso(NOW - 1 * H), revoked_at: null, revoked_reason: null }];
  const live = [{ id: "L1", production_id: "P1", responded_at: iso(NOW - 1 * H), superseded: false }];
  let f = deriveReviewFlags({ comments: [c("a", "I1", "L1", 2)], items, approvals: approvedSameRound, links: live, nowMs: NOW });
  check("comment, then 'מאשר' in the same round → minor", f.get("P1")?.minor, true);
  f = deriveReviewFlags({ comments: [c("a", "I1", "L1", 2, { acked_at: iso(NOW) })], items, approvals: approvedSameRound, links: live, nowMs: NOW });
  check("…acked ('קיבלתי') → off", f.get("P1")?.minor ?? false, false);
  const revisions: HcApproval[] = [{ ...approvedSameRound[0], decision: "revisions" }];
  f = deriveReviewFlags({ comments: [c("a", "I1", "L1", 2)], items, approvals: revisions, links: live, nowMs: NOW });
  check("comment, then 'תיקונים' → NOT minor (that is the red dot's job)", f.get("P1")?.minor ?? false, false);
  const earlier: HcApproval[] = [{ item_id: "I1", link_id: "OLD", decision: "approved", decided_at: iso(NOW - 10 * H), revoked_at: null, revoked_reason: null }];
  f = deriveReviewFlags({ comments: [c("a", "I1", "L1", 2)], items, approvals: earlier, links: [{ ...live[0], responded_at: null }], nowMs: NOW });
  check("an earlier round's approval never makes it minor (the 18.10 bug)", f.get("P1")?.minor ?? false, false);

  // ══════════════════════════════════════════════════════════════════════
  section("unsent — 🔴 'הלקוח השאיר הערות ולא שלח' (live link, newest comment > 24h)");
  const liveOpen = [{ id: "L2", production_id: "P2", responded_at: null, superseded: false }];
  f = deriveReviewFlags({ comments: [c("x", "I2", "L2", 30), c("y", "I2", "L2", 25)], items, approvals: [], links: liveOpen, nowMs: NOW });
  check("two comments, newest 25h old, nothing sent → unsent, with the link and the newest time", [f.get("P2")?.unsent, f.get("P2")?.unsentLinkId, f.get("P2")?.unsentLastAt, f.get("P2")?.unsentCount], [true, "L2", iso(NOW - 25 * H), 2]);
  f = deriveReviewFlags({ comments: [c("x", "I2", "L2", 30), c("y", "I2", "L2", 23)], items, approvals: [], links: liveOpen, nowMs: NOW });
  check("the newest is 23h old → not yet (24h from the LAST pin)", f.get("P2")?.unsent ?? false, false);
  check("exactly at 24h → on", deriveReviewFlags({ comments: [{ ...c("x", "I2", "L2", 0), created_at: iso(NOW - UNSENT_AFTER_MS) }], items, approvals: [], links: liveOpen, nowMs: NOW }).get("P2")?.unsent, true);
  f = deriveReviewFlags({ comments: [c("x", "I2", "L2", 30)], items, approvals: [], links: [{ ...liveOpen[0], responded_at: iso(NOW - 2 * H) }], nowMs: NOW });
  check("the client did send (link answered) → not unsent", f.get("P2")?.unsent ?? false, false);
  f = deriveReviewFlags({ comments: [c("x", "I2", "L2", 30)], items, approvals: [], links: [{ ...liveOpen[0], superseded: true }], nowMs: NOW });
  check("a replaced link → not unsent", f.get("P2")?.unsent ?? false, false);
  f = deriveReviewFlags({ comments: [c("x", "I2", "L2", 30, { acked_at: iso(NOW) })], items, approvals: [], links: liveOpen, nowMs: NOW });
  check("acked → off", f.get("P2")?.unsent ?? false, false);
  f = deriveReviewFlags({ comments: [c("x", "I3", null, 30)], items, approvals: [], links: [], nowMs: NOW });
  check("a comment with no link → never unsent", f.get("P3")?.unsent ?? false, false);

  // ══════════════════════════════════════════════════════════════════════
  section("sweepUnsentComments — once per (link, newest comment), against a fake DB");
  type Row = Record<string, unknown>;
  const db: Record<string, Row[]> = {
    client_review_comments: [
      { id: "x", item_id: "I2", link_id: "L2", created_at: iso(NOW - 30 * H), after_response: false, acked_at: null, resolved_at: null, author_kind: "client", is_backfill: false },
      { id: "m", item_id: "I1", link_id: "L1", created_at: iso(NOW - 2 * H), after_response: false, acked_at: null, resolved_at: null, author_kind: "client", is_backfill: false },
    ],
    client_review_items: items,
    client_review_approvals: approvedSameRound as unknown as Row[],
    client_review_links: [...live, ...liveOpen],
    productions: [{ id: "P1", needs_attention: false }, { id: "P2", needs_attention: false }],
    events: [],
  };
  const fake = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let op: "select" | "update" | "insert" = "select";
      let values: Row = {};
      const rows = () => (db[table] ??= []);
      const run = () => {
        if (op === "insert") {
          rows().push({ ...values });
          return { data: null, error: null };
        }
        const out = rows().filter((r) => filters.every((fn) => fn(r)));
        if (op === "update") out.forEach((r) => Object.assign(r, values));
        return { data: out, error: null };
      };
      const q = {
        select: () => q,
        update: (v: Row) => ((op = "update"), (values = v), q),
        insert: (v: Row) => ((op = "insert"), (values = v), Promise.resolve(run())),
        eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
        is: (k: string, v: null) => (filters.push((r) => (r[k] ?? null) === v), q),
        in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      };
      return q;
    },
  } as unknown as SupabaseClient;
  const flags = await loadReviewFlags(fake as never, NOW);
  check("loader: P1 minor, P2 unsent", [flags.get("P1")?.minor, flags.get("P2")?.unsent], [true, true]);
  const r1 = await sweepUnsentComments(fake as never, NOW);
  check("first run: lights P2 only (P1 is minor, not unsent)", r1, { lit: 1, skipped: 0 });
  check("…needs_attention on P2, untouched on P1", [db.productions[0].needs_attention, db.productions[1].needs_attention], [false, true]);
  check("…one event with the link and the newest comment", db.events.map((e) => [e.event_type, (e.payload as Row).link_id, (e.payload as Row).last_comment_at]), [[UNSENT_EVENT, "L2", iso(NOW - 30 * H)]]);
  db.productions[1].needs_attention = false; // the team acked the round's dot by hand, comments still open
  const r2 = await sweepUnsentComments(fake as never, NOW + H);
  check("second run, same newest comment → NOT re-lit (once per (link, newest comment))", [r2, db.productions[1].needs_attention], [{ lit: 0, skipped: 1 }, false]);
  db.client_review_comments.push({ id: "z", item_id: "I2", link_id: "L2", created_at: iso(NOW - 0 * H), after_response: false, acked_at: null, resolved_at: null, author_kind: "client", is_backfill: false });
  const r3 = await sweepUnsentComments(fake as never, NOW + 25 * H);
  check("a NEW comment, 24h later still nothing sent → lit again", [r3.lit, db.productions[1].needs_attention], [1, true]);
  db.client_review_comments.forEach((r) => (r.acked_at = iso(NOW)));
  const r4 = await sweepUnsentComments(fake as never, NOW + 50 * H);
  check("all acked → nothing to do", r4, { lit: 0, skipped: 0 });

  // ══════════════════════════════════════════════════════════════════════
  section("static: the cron, the board");
  const root = join(__dirname, "..");
  const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
  const cron = strip(readFileSync(join(root, "src/app/api/cron/review-versions/route.ts"), "utf8"));
  ok("the step rides the EXISTING hourly cron (no new cron)", /sweepUnsentComments\(admin, Date\.now\(\)\)/.test(cron));
  ok("…in its own try: a failure never fails the Bunny sync", /try \{\s*unsent = await sweepUnsentComments/.test(cron) && /catch \(e\) \{\s*unsent = \{ error:/.test(cron));
  const vj = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as { crons: { path: string }[] };
  check("vercel.json: 7 cron entries (E13-10 added purge-review-media), review-versions among them", [vj.crons.length, vj.crons.some((x) => x.path === "/api/cron/review-versions")], [7, true]);
  const page = strip(readFileSync(join(root, "src/app/productions/page.tsx"), "utf8"));
  ok("board page: flags loaded in try/catch (rule 38)", /try \{\s*reviewFlags = await loadReviewFlags\(/.test(page) && /board_review_flags_failed/.test(page));
  const pc = strip(readFileSync(join(root, "src/app/productions/ProductionsClient.tsx"), "utf8"));
  ok("card: an orange dot, distinct from the red one, titled 'אושר עם הערות'", /!p\.needs_attention && p\.review_minor && \(\s*<span className="w-2 h-2 rounded-full shrink-0" style=\{\{ background: "#fb923c" \}\} title="אושר עם הערות"/.test(pc));
  ok("card: the words 'הלקוח השאיר הערות ולא שלח' / 'אושר עם הערות'", pc.includes("הלקוח השאיר הערות ולא שלח") && /אושר עם הערות\s*<\/span>/.test(pc));
  ok("card: '💬 הערות הלקוח' also on the orange dot (that is where 'קיבלתי' lives)", /\(p\.needs_attention \|\| p\.review_minor\) && \(/.test(pc));
  const mig = readFileSync(join(root, "supabase/migrations/0118_review_item_comment_reapprove.sql"), "utf8");
  ok("pins on a live link still light nothing at once (0118: only after a response, or a revoke)", /elsif v_after then\s*update public\.productions set needs_attention = true/.test(mig));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main();
