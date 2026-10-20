/**
 * T34 — the drawer's GET in parallel waves: the JSON must be IDENTICAL to the
 * pre-T34 body (scripts/_entity_get_legacy.ts, frozen at 192908a) on the same
 * data, for every kind of viewer and production.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_entity_get_waves.ts
 *
 * ═══ F19 ═══
 * No database, no network: scripts/_fake_db.ts (with T34's `hang` for a stuck
 * read). `global.fetch` throws.
 */
import { fakeDb, type Row } from "./_fake_db";
import { legacyEntityGet } from "./_entity_get_legacy";
import { entityGet } from "../src/lib/drawer/entityGet";
import { perfTimer } from "../src/lib/perf/timing";
import type { Profile } from "../src/lib/profile";
import type { EntityType } from "../src/lib/entities";

global.fetch = (async () => {
  throw new Error("F19: this suite must not perform any fetch");
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
    console.log(`  ❌ ${name}\n       got:  ${g.slice(0, 600)}\n       want: ${w.slice(0, 600)}`);
  }
}
const section = (t: string) => console.log(`\n── ${t}`);

const base = { approved: true, can_import: false, can_manage_users: false, email: null };
const OWNER: Profile = { ...base, id: "u-owner", name: "owner", role: "owner", can_view_money: true, can_edit_money: true, can_view_stages: true, can_edit_stages: true, can_manage_users: true, studio_admin: false } as Profile;
const STUDIO_ADMIN: Profile = { ...OWNER, id: "u-sa", studio_admin: true } as Profile;
const TECH: Profile = { ...base, id: "u-tech", name: "tech", role: "tech", can_view_money: false, can_edit_money: false, can_view_stages: true, can_edit_stages: true, studio_admin: false } as Profile;
const BOOKKEEPER: Profile = { ...base, id: "u-bk", name: "bk", role: "bookkeeper", can_view_money: true, can_edit_money: true, can_view_stages: false, can_edit_stages: false, studio_admin: false } as Profile;

const FUTURE = "2099-01-01T00:00:00Z";
function world(opts: { hang?: string[] } = {}) {
  const prod = (id: string, over: Row = {}) => ({
    id, podcast_name: "ואם נחיה לנצח", show_id: "s1", client_id: "c1", kind: "client", status: "הופץ", record_date: "2026-10-01",
    guest: "אורחת", studio: "גבעון", storage_disk: "T7", storage_disk_id: "d-t7", studio_hours: null, contract_id: null, cancelled_at: null, merged_into: null,
    created_at: "2026-10-01T08:00:00Z", review_episode_approved: true, review_reels_approved: false, review_reels_required: true,
    review_episode_note: "תיקון קטן", review_reels_note: null, reels_count: 2, ...over,
  });
  return fakeDb(
    {
      productions: [
        prod("p-plain"),
        prod("p-hourly", { show_id: "s-hour", studio_hours: 2.5 }),
        prod("p-links"),
        // contract with 2 included; p-c3 is the third episode -> over quota
        prod("p-c1", { contract_id: "k1", record_date: "2026-09-01", created_at: "2026-09-01T08:00:00Z" }),
        prod("p-c2", { contract_id: "k1", record_date: "2026-09-08", created_at: "2026-09-08T08:00:00Z" }),
        prod("p-c3", { contract_id: "k1", record_date: "2026-09-15", created_at: "2026-09-15T08:00:00Z" }),
      ],
      storage_disks: [
        { id: "d-t7", name: "T7", hidden: false },
        { id: "d-kong", name: "kong", hidden: false },
        { id: "d-old", name: "old", hidden: true },
      ],
      shows: [
        { id: "s1", name: "ואם נחיה לנצח", pricing_model: "per_episode" },
        { id: "s-hour", name: "שעתי", pricing_model: "per_hour" },
      ],
      clients: [{ id: "c1", name: "מלי", status: "active" }],
      stages: [
        { id: "st1", production_id: "p-plain", track: "episode", step: "record", status: "done", assignee_id: null, done_at: null },
        { id: "st2", production_id: "p-plain", track: "episode", step: "edit", status: "in_progress", assignee_id: "u-tech", done_at: null },
        { id: "st3", production_id: "p-c3", track: "episode", step: "record", status: "done", assignee_id: null, done_at: null },
      ],
      production_log: [
        { id: "l1", production_id: "p-plain", kind: "note", track: null, step: null, stage_status: null, note: "שלום", author_id: "u-tech", created_at: "2026-10-02T08:00:00Z", edited_at: null },
        { id: "l2", production_id: "p-plain", kind: "client", track: null, step: null, stage_status: null, note: "לקוח", author_id: null, created_at: "2026-10-03T08:00:00Z", edited_at: null },
      ],
      profiles: [
        { id: "u-tech", name: "טכנאי" },
        { id: "u-owner", name: "בעלים" },
      ],
      job_productions: [
        { job_id: "j1", production_id: "p-plain" },
        { job_id: "j1", production_id: "p-links" },
      ],
      jobs: [
        { id: "j1", date: "2026-10-01", campaign: "ואם נחיה לנצח", amount: 800, paid: "לא", invoice_biz: "40300", invoice_tax: null },
        { id: "j2", date: "2026-09-01", campaign: "חוזה", amount: 5000, paid: "כן", invoice_biz: "40100", invoice_tax: "50100" },
      ],
      contracts: [{ id: "k1", name: "חוזה EY", included_episodes: 2 }],
      contract_milestones: [
        { id: "m1", contract_id: "k1", name: "חלק א", amount: 5000, expected_date: "2026-09-01", is_estimated: false, status: "invoiced", job_id: "j2" },
        { id: "m2", contract_id: "k1", name: "חלק ב", amount: 5000, expected_date: "2026-12-01", is_estimated: true, status: "pending", job_id: null },
      ],
      client_review_items: [
        { id: "i1", production_id: "p-links", kind: "episode", reel_index: null, media_link: "https://drive/x", approved: false, last_note: null },
      ],
      client_review_links: [
        { id: "L0", production_id: "p-links", token: "old", scope: "episode", created_at: "2026-10-01T09:00:00Z", expires_at: FUTURE, superseded: true, responded_at: null, audio_link: null, audio_carried_from: null },
        { id: "L1", production_id: "p-links", token: "tok1", scope: "episode", created_at: "2026-10-05T09:00:00Z", expires_at: FUTURE, superseded: false, responded_at: null, audio_link: "https://a", audio_carried_from: "L0" },
      ],
      client_review_transcripts: [{ link_id: "L1", source: "upload", char_count: 1200, carried_from_link_id: "L0" }],
      events: [
        { id: "e1", entity_type: "production", entity_id: "p-plain", event_type: "stage_updated", actor_id: "u-tech", payload: { a: 1 }, created_at: "2026-10-02T08:00:00Z" },
        { id: "e2", entity_type: "production", entity_id: "p-plain", event_type: "calendar_created", actor_id: null, payload: {}, created_at: "2026-10-01T08:00:00Z" },
      ],
    },
    { hang: opts.hang }
  );
}

async function both(type: EntityType, id: string, profile: Profile, opts: { hang?: string[] } = {}) {
  const w1 = world(opts);
  const w2 = world(opts);
  const common = { type, id, user: { id: profile.id }, profile, origin: "https://app.example", liveLinksTimeoutMs: 60 };
  const quiet = console.warn;
  console.warn = () => {}; // the drawer_partial line, asserted in test_drawer_live_links
  const legacy = await legacyEntityGet({ ...common, supabase: w1.client as never, admin: w1.client as never });
  const waves = await entityGet({ ...common, supabase: w2.client as never, admin: w2.client as never });
  console.warn = quiet;
  // E13-8c added commentHistory after the legacy snapshot was frozen: compared
  // separately (section 5), so the old-vs-new equality still covers the rest
  const json = (waves as { json?: Record<string, unknown> }).json;
  const commentHistory = json ? json.commentHistory : undefined;
  if (json) delete json.commentHistory;
  // …and E13-4 added reviewItems[].versions after it, too (this suite had
  // failed on those four cases since E13-4; found 17.10)
  if (json && Array.isArray(json.reviewItems)) json.reviewItems = (json.reviewItems as Record<string, unknown>[]).map(({ versions: _v, ...rest }) => rest);
  return { legacy, waves, commentHistory };
}

async function main() {
  const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout is unref'd

  section("1. identical JSON, old vs new — per viewer and per production");
  const cases: [string, EntityType, string, Profile, { hang?: string[] }?][] = [
    ["owner · plain production (stages, log, jobs, history)", "production", "p-plain", OWNER],
    ["studio_admin · plain production", "production", "p-plain", STUDIO_ADMIN],
    ["technician · plain production (no money, no history)", "production", "p-plain", TECH],
    ["bookkeeper · plain production (money, no stages)", "production", "p-plain", BOOKKEEPER],
    ["owner · hourly show (the hourly pair)", "production", "p-hourly", OWNER],
    ["owner · production with live links + transcript + carry marker", "production", "p-links", OWNER],
    ["technician · production with live links", "production", "p-links", TECH],
    ["owner · contract production over its quota", "production", "p-c3", OWNER],
    ["owner · contract production within its quota", "production", "p-c1", OWNER],
    ["technician · contract production (no quota without money)", "production", "p-c3", TECH],
    ["owner · live links TIMEOUT (a stuck read)", "production", "p-links", OWNER, { hang: ["client_review_links"] }],
    ["technician · transcripts read stuck", "production", "p-links", TECH, { hang: ["client_review_transcripts"] }],
    ["owner · production that does not exist (404)", "production", "p-nope", OWNER],
    ["owner · job drawer", "job", "j1", OWNER],
    ["owner · contract drawer (milestones)", "contract", "k1", OWNER],
  ];
  for (const [name, type, id, profile, opts] of cases) {
    const { legacy, waves } = await both(type, id, profile, opts ?? {});
    check(name, waves, legacy);
  }

  section("2. the cases above actually exercised what they claim");
  {
    const r = (await both("production", "p-c3", OWNER)).waves.json;
    check("over-quota production carries quotaOver", r.quotaOver, { included: 2, contract_name: "חוזה EY" });
    const l = (await both("production", "p-links", OWNER)).waves.json;
    check("live links + transcript + carry date resolved", (l.reviewLinks as { transcript: { carried_from_at: string } }[])[0].transcript.carried_from_at, "2026-10-01T09:00:00Z");
    const t = (await both("production", "p-links", OWNER, { hang: ["client_review_links"] })).waves.json;
    check("timeout: the drawer still answers, without the links block", [t.reviewLinks, t.reviewLinksIncomplete, Array.isArray(t.stages)], [null, true, true]);
    const tech = (await both("production", "p-plain", TECH)).waves.json;
    check("technician: no money and no history were read", [tech.linked, tech.quotaOver, tech.history], [null, null, null]);
    const bk = (await both("production", "p-plain", BOOKKEEPER)).waves.json;
    check("bookkeeper: no stage blocks were read", [bk.stages, bk.review, bk.hourly, bk.reviewItems, bk.reviewLinks], [null, null, null, null, null]);
  }

  section("3. permissions: a block that must not run for a viewer touches nothing");
  {
    const w = world();
    await entityGet({ type: "production", id: "p-plain", user: { id: "u-tech" }, profile: TECH, supabase: w.client as never, admin: w.client as never, origin: "x" });
    const tables = new Set(w.calls.map((c) => c.table));
    check("technician: jobs / job_productions / contracts / events never queried", ["jobs", "job_productions", "contracts", "events"].filter((t) => tables.has(t)), []);
    const w2 = world();
    await entityGet({ type: "production", id: "p-plain", user: { id: "u-bk" }, profile: BOOKKEEPER, supabase: w2.client as never, admin: w2.client as never, origin: "x" });
    const t2 = new Set(w2.calls.map((c) => c.table));
    check("bookkeeper: stages / review items / review links never queried", ["stages", "client_review_items", "client_review_links"].filter((t) => t2.has(t)), []);
  }

  section("4a. E13-8c: the comment history rides along for a production, never for a non-stage viewer");
  {
    const o = await both("production", "p-plain", OWNER);
    check("owner: commentHistory is an array (the items, with their comments)", Array.isArray(o.commentHistory), true);
    const bk = await both("production", "p-plain", BOOKKEEPER);
    check("bookkeeper (no stages): commentHistory is null", bk.commentHistory, null);
  }

  section("4. T35 timing: the step names are kept, plus wave_1 / wave_2");
  {
    const w = world();
    const lines: string[] = [];
    const perf = perfTimer("/api/entity/production/[id]", { force: true, log: (l) => lines.push(l) });
    await entityGet({ type: "production", id: "p-plain", user: { id: "u-owner" }, profile: OWNER, supabase: w.client as never, admin: w.client as never, origin: "x", perf });
    perf.done();
    const names = (JSON.parse(lines[0]).steps as { name: string }[]).map((s) => s.name);
    const want = ["entity", "options_clients_shows", "wave_1", "stages_reels", "hours", "review_items", "review_comments", "review_links_transcripts", "log_disk_authors", "linked_jobs", "contract_quota", "other_types", "history", "wave_2"];
    check("every step name is present", want.filter((n) => !names.includes(n)), []);
    check("wave_1 comes before every wave_2 block, and wave_2 closes it", [names.indexOf("wave_1") < names.indexOf("history"), names[names.length - 1]], [true, "wave_2"]);
  }

  clearInterval(keepAlive);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
