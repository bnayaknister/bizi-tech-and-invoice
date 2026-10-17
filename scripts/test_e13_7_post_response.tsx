/**
 * E13-7 — the answered link stays live for viewing (owner 17.10), plus the two
 * E13-6 follow-ups of the same day: no Referer on the download, and the red
 * dot for a missing Drive file that clears by itself.
 *
 *   src/lib/review/links.ts          resolveLink: post_response, computed "replaced"
 *   src/app/api/r/[token]/respond    a second response stays 410
 *   src/app/r/[token]/ReviewClient   view-only page (line on top, no response controls)
 *   src/lib/review/downloadAttention light / resolve / clear
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_e13_7_post_response.tsx
 *
 * ═══ F19 ═══ No database, no network: an in-memory fake of the few
 * supabase-js query methods these functions use.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveLink, overlappingScopes } from "../src/lib/review/links";
import {
  outstandingMissing,
  entriesResolvedBy,
  clientNotesUnacked,
  shouldClearFlag,
  resolveDownloadMissing,
  lightDownloadMissing,
  MISSING_EVENT,
  RESOLVED_EVENT,
  type AttentionEvent,
} from "../src/lib/review/downloadAttention";
import ReviewClient from "../src/app/r/[token]/ReviewClient";
import ReviewPlayer, { type ClientVersionView } from "../src/app/r/[token]/ReviewPlayer";

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
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond && detail) console.log(`       ${detail.slice(0, 500)}`);
  check(name, cond, true);
};
const section = (t: string) => console.log(`\n── ${t}`);

// ── a tiny in-memory supabase-js ─────────────────────────────────────────
type Row = Record<string, unknown>;
type Db = Record<string, Row[]>;
function fakeAdmin(db: Db, log: { op: string; table: string; values?: Row }[] = []) {
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "update" | "insert" = "select";
    let values: Row | undefined;
    let order: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;
    const rows = () => (db[table] ??= []);
    const run = () => {
      if (op === "insert") {
        rows().push({ created_at: new Date().toISOString(), ...values });
        log.push({ op, table, values });
        return { data: null, error: null };
      }
      let out = rows().filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        out.forEach((r) => Object.assign(r, values));
        log.push({ op, table, values });
        return { data: out, error: null };
      }
      if (order) {
        const { col, asc } = order;
        out = [...out].sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (asc ? 1 : -1));
      }
      if (limit !== null) out = out.slice(0, limit);
      return { data: out, error: null };
    };
    const q = {
      select: () => q,
      update: (v: Row) => ((op = "update"), (values = v), q),
      insert: (v: Row) => ((op = "insert"), (values = v), Promise.resolve(run())),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
      gt: (c: string, v: string) => (filters.push((r) => String(r[c]) > v), q),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
      is: (c: string, v: null) => (filters.push((r) => (r[c] ?? null) === v), q),
      not: (c: string, _o: string, v: null) => (filters.push((r) => (r[c] ?? null) !== v), q),
      order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), q),
      limit: (n: number) => ((limit = n), q),
      maybeSingle: () => {
        const r = run();
        return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: null });
      },
      single: () => q.maybeSingle(),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const PROD = "p0000000-0000-4000-8000-000000000001";
const past = "2026-09-01T10:00:00Z";
const later = "2026-09-20T10:00:00Z";
const link = (over: Row): Row => ({
  id: "L1",
  production_id: PROD,
  token: "tok1",
  expires_at: "2026-09-15T10:00:00Z", // long expired — must NOT matter once answered
  responded_at: "2026-09-05T10:00:00Z",
  created_at: past,
  superseded: false,
  reels_included: true,
  scope: "episode",
  episode_link: null,
  reels_link: null,
  audio_link: null,
  ...over,
});
const baseDb = (links: Row[]): Db => ({
  client_review_links: links,
  productions: [{ id: PROD, podcast_name: "בדיקה", record_date: "2026-08-30", split_index: null, split_count: null, review_episode_approved: true, review_reels_approved: false, review_reels_required: true, price_override: null, show_id: null }],
  production_addons: [],
  client_review_items: [],
  client_review_transcripts: [],
});

async function main() {
  // ══════════════════════════════════════════════════════════════════════
  section("overlapping scopes — the rule createReviewLink supersedes by (B1)");
  check("all overlaps everything", overlappingScopes("all"), ["episode", "reels", "all"]);
  check("episode overlaps episode + all, not reels", overlappingScopes("episode"), ["episode", "all"]);
  check("reels overlaps reels + all, not episode", overlappingScopes("reels"), ["reels", "all"]);

  // ══════════════════════════════════════════════════════════════════════
  section("resolveLink — the answered link (E13-7)");
  const s1 = await resolveLink(fakeAdmin(baseDb([link({})])), "tok1");
  check("answered, nothing newer → ok, post_response", s1.status === "ok" ? [s1.status, s1.mode] : s1.status, ["ok", "post_response"]);
  check("…even though expires_at passed long ago (no 14-day limit after an answer)", s1.status, "ok");
  const s2 = await resolveLink(fakeAdmin(baseDb([link({}), link({ id: "L2", token: "tok2", scope: "all", created_at: later, responded_at: null })])), "tok1");
  check("a NEWER 'all' link → superseded (shows 'יש קישור חדש יותר')", s2.status, "superseded");
  const s3 = await resolveLink(fakeAdmin(baseDb([link({}), link({ id: "L2", token: "tok2", scope: "episode", created_at: later })])), "tok1");
  check("a newer episode link that was itself answered → still replaces it", s3.status, "superseded");
  const s4 = await resolveLink(fakeAdmin(baseDb([link({}), link({ id: "L2", token: "tok2", scope: "reels", created_at: later, responded_at: null })])), "tok1");
  check("a newer REELS link next to an answered EPISODE link → not replaced (separate tracks)", s4.status === "ok" ? s4.mode : s4.status, "post_response");
  const s5 = await resolveLink(fakeAdmin(baseDb([link({ created_at: later }), link({ id: "L0", token: "tok0", scope: "all", created_at: past })])), "tok1");
  check("an OLDER overlapping link does not replace it", s5.status === "ok" ? s5.mode : s5.status, "post_response");
  const other = { ...baseDb([link({}), link({ id: "LX", token: "tokx", production_id: "other", scope: "all", created_at: later })]) };
  const s6 = await resolveLink(fakeAdmin(other), "tok1");
  check("a newer link of ANOTHER production does not replace it", s6.status === "ok" ? s6.mode : s6.status, "post_response");

  section("resolveLink — unanswered links unchanged");
  const future = new Date(Date.now() + 5 * 86400_000).toISOString();
  const u1 = await resolveLink(fakeAdmin(baseDb([link({ responded_at: null, expires_at: future })])), "tok1");
  check("unanswered, not expired → ok, live", u1.status === "ok" ? u1.mode : u1.status, "live");
  const u2 = await resolveLink(fakeAdmin(baseDb([link({ responded_at: null })])), "tok1");
  check("unanswered, expired → expired (14 days, as today)", u2.status, "expired");
  const u3 = await resolveLink(fakeAdmin(baseDb([link({ responded_at: null, expires_at: future, superseded: true })])), "tok1");
  check("superseded flag → superseded", u3.status, "superseded");
  check("unknown token → missing", (await resolveLink(fakeAdmin(baseDb([])), "nope")).status, "missing");

  // ══════════════════════════════════════════════════════════════════════
  section("static: respond, page, routes");
  const root = join(__dirname, "..");
  const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
  const rs = strip(readFileSync(join(root, "src/app/api/r/[token]/respond/route.ts"), "utf8"));
  const iMode = rs.indexOf('state.mode === "post_response"');
  const iApply = rs.indexOf("applyResponse(");
  ok("respond: post_response → 410 BEFORE any applyResponse (a second response stays closed)", iMode > 0 && iApply > iMode && /reason: "responded" \}, \{ status: 410 \}/.test(rs));
  const pg = strip(readFileSync(join(root, "src/app/r/[token]/page.tsx"), "utf8"));
  ok("page: respondedAt passed only in post_response", /respondedAt=\{state\.mode === "post_response" \? state\.link\.responded_at : null\}/.test(pg));
  ok("page: the replaced notice reads 'יש קישור חדש יותר'", pg.includes('title="יש קישור חדש יותר"'));
  ok("page: the old 'התקבל, תודה!' dead end is gone", !pg.includes("התקבל, תודה!"));
  const dl = strip(readFileSync(join(root, "src/app/api/r/[token]/download/[versionId]/route.ts"), "utf8"));
  ok("download: the 302 says Referrer-Policy: no-referrer", /"Referrer-Policy": "no-referrer"/.test(dl) && /status: 302, headers: \{ \.\.\.NO_STORE, \.\.\.NO_REFERRER \}/.test(dl));
  ok("download: a missing file lights the dot", /lightDownloadMissing\(admin, found\.item\.production_id\)/.test(dl));
  ok("download: the dot is resolved only when the check CONFIRMED the file (probe ok, not unknown)", /if \(probe\.state === "ok"\) await resolveDownloadMissing\(/.test(dl));
  ok("download: the missing event carries item_id (a new version of the item clears it)", /item_id: found\.item\.id/.test(dl));
  const sv = strip(readFileSync(join(root, "src/app/api/productions/[id]/review-versions/route.ts"), "utf8"));
  ok("send for review: a successful send resolves the item's missing entries", /resolveDownloadMissing\(admin, params\.id, \{ itemId: sent\.item_id \}, "new_version"\)/.test(sv));
  ok("send for review: that step has its own try (cannot turn a sent version into 'not sent')", /try \{\s*const admin = createTypedAdminClient\(\);/.test(sv));

  // ══════════════════════════════════════════════════════════════════════
  section("ReviewClient — the view-only page");
  const ITEM = "i0000000-0000-4000-8000-000000000001";
  const ver: ClientVersionView = { id: "v2", number: 2, kind: "bunny", isAudio: false, fileName: "reel01 v1.mp4", playbackUrl: "https://cdn.test/x.m3u8", expires: 1, downloadable: true };
  const base = {
    token: "tok",
    showName: "אסתטיטוקס",
    episodeLabel: "הפרק המלא",
    recordDate: "2026-07-20",
    episodeIncluded: true,
    reelsIncluded: true,
    episodeApproved: false,
    reelsApproved: false,
    episodeLink: null,
    reelsLink: null,
    addons: [{ id: "a1", title: "תוספת", quantity: 1, unit_price: 100, total: 100 }],
    items: [
      { id: "EP", kind: "episode" as const, reel_index: null, media_link: "https://drive.google.com/file/d/EP/view", approved: true },
      { id: ITEM, kind: "reel" as const, reel_index: 1, media_link: "https://drive.google.com/file/d/R/view", approved: false },
    ],
    versionsByItem: { [ITEM]: [ver] },
  };
  const render = (el: React.ReactElement) => {
    try {
      return renderToString(el);
    } catch (e) {
      return `THREW: ${e instanceof Error ? e.message : String(e)}`;
    }
  };
  const vo = render(<ReviewClient {...base} respondedAt="2026-09-05T10:00:00Z" />);
  ok("the line on top, with the Israeli date of the answer", vo.includes("התשובה שלכם התקבלה ב-") && vo.includes("05/09/2026"), vo);
  ok("no approve / revisions buttons", !vo.includes("✓ מאשר") && !vo.includes("✎ תיקונים"), vo);
  ok("no submit button", !vo.includes("שלח תשובה") && !vo.includes("מאשר את כל התוצרים"), vo);
  ok("no add-on choices", !vo.includes("תוספות"), vo);
  ok("the player and the download stay", vo.includes("<video") && vo.includes("/api/r/tok/download/v2"), vo);
  ok("an approved item still shows ✓ אושר", vo.includes("✓ אושר"), vo);
  const voNoDate = render(<ReviewClient {...base} respondedAt="not-a-date" />);
  ok("an unreadable timestamp → the line without a date, no crash", !voNoDate.startsWith("THREW") && voNoDate.includes("התשובה שלכם התקבלה"), voNoDate);
  const live = render(<ReviewClient {...base} />);
  ok("a live link (no respondedAt) is exactly as before: buttons, add-ons, submit", live.includes("✓ מאשר") && live.includes("תוספות") && live.includes("שלח תשובה") && !live.includes("התשובה שלכם התקבלה"), live);
  const track = render(<ReviewClient {...base} items={[]} episodeLink="https://drive.google.com/file/d/T/view" respondedAt="2026-09-05T10:00:00Z" />);
  ok("track-level layout, view-only → no buttons either", !track.includes("✓ מאשר") && track.includes("התשובה שלכם התקבלה"), track);

  section("ReviewPlayer — the download button sends no Referer");
  const pl = render(<ReviewPlayer token="tok" versions={[ver]} selectedId={null} onSelect={() => {}} renderDrive={() => null} />);
  ok('rel="noreferrer" on the download link', /<a href="\/api\/r\/tok\/download\/v2" rel="noreferrer"/.test(pl), pl);

  // ══════════════════════════════════════════════════════════════════════
  section("red dot — the pure rules");
  const ev = (event_type: string, created_at: string, payload: Record<string, unknown>): AttentionEvent => ({ event_type, created_at, payload });
  const evs = [
    ev(MISSING_EVENT, "2026-10-01T00:00:00Z", { version_id: "V1", item_id: "I1" }),
    ev(MISSING_EVENT, "2026-10-02T00:00:00Z", { version_id: "V2", item_id: "I2" }),
    ev(RESOLVED_EVENT, "2026-10-03T00:00:00Z", { version_ids: ["V1"] }),
  ];
  check("missing minus resolved = what is still open", outstandingMissing(evs).map((e) => e.versionId), ["V2"]);
  check("missing again AFTER a resolve → open again", outstandingMissing([...evs, ev(MISSING_EVENT, "2026-10-04T00:00:00Z", { version_id: "V1", item_id: "I1" })]).map((e) => e.versionId).sort(), ["V1", "V2"]);
  check("order is by time, not by array position", outstandingMissing([evs[2], evs[0]]).length, 0);
  const open = outstandingMissing([evs[0], evs[1]]);
  check("a download resolves its own version only", entriesResolvedBy(open, { versionId: "V1" }).map((e) => e.versionId), ["V1"]);
  check("a new version resolves every missing entry of its item", entriesResolvedBy(open, { itemId: "I2" }).map((e) => e.versionId), ["V2"]);
  check("no round → no client notes waiting", clientNotesUnacked(null, null), false);
  check("revisions round not acked → waiting", clientNotesUnacked({ id: "R1", episode_response: "revisions", reels_response: null }, null), true);
  check("revisions round acked → not waiting", clientNotesUnacked({ id: "R1", episode_response: null, reels_response: "revisions" }, "R1"), false);
  check("approved round → not waiting", clientNotesUnacked({ id: "R1", episode_response: "approved", reels_response: "approved" }, null), false);
  check("clear only with nothing missing and no notes waiting", [shouldClearFlag([], false), shouldClearFlag([], true), shouldClearFlag(open, false)], [true, false, false]);

  section("red dot — light and clear against the fake database");
  const mk = (over: { needs?: boolean; round?: Row | null; ack?: string | null; events?: Row[] } = {}) => {
    const db: Db = {
      productions: [{ id: PROD, needs_attention: over.needs ?? true, review_ack_link_id: over.ack ?? null }],
      client_review_links: over.round ? [{ production_id: PROD, ...over.round }] : [],
      events: over.events ?? [],
    };
    const log: { op: string; table: string; values?: Row }[] = [];
    return { db, log, admin: fakeAdmin(db, log) };
  };
  const missingRow = (v: string, i: string, at = "2026-10-01T00:00:00Z") => ({ entity_type: "production", entity_id: PROD, event_type: MISSING_EVENT, created_at: at, payload: { version_id: v, item_id: i } });

  const a = mk({ needs: false });
  await lightDownloadMissing(a.admin, PROD);
  check("light → needs_attention true", a.db.productions[0].needs_attention, true);

  const b = mk({ events: [missingRow("V1", "I1")] });
  check("download of the same version OK → resolved, dot out", await resolveDownloadMissing(b.admin, PROD, { versionId: "V1" }, "download_ok"), { resolved: 1, cleared: true });
  check("…needs_attention false", b.db.productions[0].needs_attention, false);
  check("…a resolved event with the version", (b.db.events.find((e) => e.event_type === RESOLVED_EVENT)?.payload as Row)?.version_ids, ["V1"]);

  const c = mk({ events: [missingRow("V1", "I1")], round: { id: "R1", responded_at: "2026-10-02T00:00:00Z", episode_response: "revisions", reels_response: null } });
  check("client notes still waiting for 'קיבלתי' → resolved, but the dot STAYS", await resolveDownloadMissing(c.admin, PROD, { versionId: "V1" }, "download_ok"), { resolved: 1, cleared: false });
  check("…needs_attention still true", c.db.productions[0].needs_attention, true);

  const c2 = mk({ events: [missingRow("V1", "I1")], ack: "R1", round: { id: "R1", responded_at: "2026-10-02T00:00:00Z", episode_response: "revisions", reels_response: null } });
  check("the notes round was already acked → dot out", (await resolveDownloadMissing(c2.admin, PROD, { versionId: "V1" }, "download_ok")).cleared, true);

  const d = mk({ events: [missingRow("V1", "I1"), missingRow("V2", "I2")] });
  check("another version is still missing → the dot stays", await resolveDownloadMissing(d.admin, PROD, { versionId: "V1" }, "download_ok"), { resolved: 1, cleared: false });

  const e = mk({ events: [missingRow("V1", "I1"), missingRow("V3", "I1")] });
  check("new version for the item → all of the item's entries resolved, dot out", await resolveDownloadMissing(e.admin, PROD, { itemId: "I1" }, "new_version"), { resolved: 2, cleared: true });

  const f = mk({ events: [] });
  check("nothing missing → nothing written, dot untouched (a client-note dot is never cleared here)", await resolveDownloadMissing(f.admin, PROD, { versionId: "V1" }, "download_ok"), { resolved: 0, cleared: false });
  check("…no writes at all", f.log.length, 0);
  check("…needs_attention still true", f.db.productions[0].needs_attention, true);

  const g = mk({ needs: false, events: [missingRow("V1", "I1")] });
  check("dot already out (someone cleared it) → resolved, no update", (await resolveDownloadMissing(g.admin, PROD, { versionId: "V1" }, "download_ok")).cleared, false);

  const broken = { from: () => { throw new Error("db down"); } } as unknown as SupabaseClient;
  check("a database failure → no throw (never fails the download or the send)", await resolveDownloadMissing(broken, PROD, { versionId: "V1" }, "download_ok"), { resolved: 0, cleared: false });
  await lightDownloadMissing(broken, PROD);
  ok("lightDownloadMissing on a broken database → no throw", true);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main();
