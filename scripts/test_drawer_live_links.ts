/**
 * T36 — the drawer's live review links, with a ceiling.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_drawer_live_links.ts
 *
 * ═══ F19 ═══
 * No database, no network: a hand-rolled fake client whose queries can be told
 * to answer, fail, or HANG until their AbortSignal fires. `global.fetch` throws.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDrawerLiveLinks, DRAWER_LIVE_LINKS_TIMEOUT_MS } from "../src/lib/review/drawerLiveLinks";

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
    console.log(`  ❌ ${name}\n       got:  ${g}\n       want: ${w}`);
  }
}
const section = (t: string) => console.log(`\n── ${t}`);

type Mode = "ok" | "hang" | "error";
type Row = Record<string, unknown>;

/** A query builder that answers per table, and honours .abortSignal() the way postgrest-js does. */
function fakeClient(tables: Record<string, Row[]>, mode: Record<string, Mode> = {}) {
  const used: { table: string; aborted: boolean; hadSignal: boolean }[] = [];
  return {
    used,
    client: {
      from(table: string) {
        let signal: AbortSignal | null = null;
        let byIds = false;
        const rec = { table, aborted: false, hadSignal: false };
        used.push(rec);
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "is", "gt", "order"]) b[m] = () => b;
        // a lookup by ids answers from "<table>:in" (the 0078 carry lookup)
        b.in = () => ((byIds = true), b);
        b.abortSignal = (s: AbortSignal) => ((signal = s), (rec.hadSignal = true), b);
        b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          const m = mode[table] ?? "ok";
          if (m === "error") return Promise.resolve({ data: null, error: { message: "boom: connection reset" } }).then(res, rej);
          if (m === "hang") {
            return new Promise((resolve) => {
              // postgrest-js turns a rejected fetch into { error: { message: "<name>: <message>" } }
              signal?.addEventListener("abort", () => {
                rec.aborted = true;
                resolve({ data: null, error: { message: "TimeoutError: The operation was aborted due to timeout" } });
              });
            }).then(res, rej);
          }
          return Promise.resolve({ data: tables[byIds && tables[`${table}:in`] ? `${table}:in` : table] ?? [], error: null }).then(res, rej);
        };
        return b;
      },
    },
  };
}

const LINKS = [
  { id: "L1", token: "tok1", scope: "episode", created_at: "2026-10-13T10:00:00Z", audio_link: null, audio_carried_from: "L0" },
];
const TR = [{ link_id: "L1", source: "upload", char_count: 1200, carried_from_link_id: null }];
const SRC = [{ id: "L0", created_at: "2026-10-01T09:00:00Z" }];

async function main() {
  // AbortSignal.timeout's timer is unref'd: in a bare script with nothing else
  // pending, Node would exit before it fires. A server always has the request
  // socket open; here an interval stands in for it.
  const keepAlive = setInterval(() => {}, 1000);
  section("1. the ordinary drawer");
  {
    const user = fakeClient({ client_review_links: LINKS as Row[], "client_review_links:in": SRC as Row[] });
    const admin = fakeClient({ client_review_transcripts: TR });
    const r = await loadDrawerLiveLinks({ supabase: user.client as never, admin: admin.client as never, productionId: "p1", origin: "https://app.example" });
    check("not incomplete", r.incomplete, false);
    check("the link, its url and its transcript metadata", r.links?.map((l) => [l.id, l.url, l.transcript?.char_count]), [["L1", "https://app.example/r/tok1", 1200]]);
    check("the carry marker resolves to the source round's date (0078)", r.links?.[0]?.audio_carried_from_at, "2026-10-01T09:00:00Z");
    check("every read carried an abort signal", [...user.used, ...admin.used].every((u) => u.hadSignal), true);
    check("the default ceiling is 5 seconds", DRAWER_LIVE_LINKS_TIMEOUT_MS, 5000);
  }

  section("2. a read that hangs is cut at the ceiling — the drawer loads without the block");
  for (const which of ["client_review_links", "client_review_transcripts"]) {
    const logs: string[] = [];
    const user = fakeClient({ client_review_links: LINKS as Row[] }, which === "client_review_links" ? { client_review_links: "hang" } : {});
    const admin = fakeClient({ client_review_transcripts: TR }, which === "client_review_transcripts" ? { client_review_transcripts: "hang" } : {});
    const t0 = Date.now();
    const r = await loadDrawerLiveLinks({
      supabase: user.client as never,
      admin: admin.client as never,
      productionId: "6e38aba1-e4f3-46c9-be88-aa748b098271",
      origin: "https://app.example",
      timeoutMs: 60,
      log: (l) => logs.push(l),
    });
    const took = Date.now() - t0;
    check(`${which} hangs -> incomplete, links null`, [r.incomplete, r.links], [true, null]);
    check(`${which} hangs -> returned at the ceiling, not after it (${took}ms)`, took >= 50 && took < 1000, true);
    check(`${which} hangs -> the hanging read was aborted`, [...user.used, ...admin.used].some((u) => u.aborted), true);
    const line = JSON.parse(logs[0] ?? "{}");
    check(`${which} hangs -> one drawer_partial log line, reason timeout, production id only`, [logs.length, line.tag, line.part, line.reason, line.production_id], [1, "drawer_partial", "review_links", "timeout", "6e38aba1-e4f3-46c9-be88-aa748b098271"]);
  }

  section("3. an error is no longer silent");
  {
    const logs: string[] = [];
    const user = fakeClient({ client_review_links: LINKS as Row[] }, { client_review_links: "error" });
    const admin = fakeClient({});
    const r = await loadDrawerLiveLinks({ supabase: user.client as never, admin: admin.client as never, productionId: "p1", origin: "x", log: (l) => logs.push(l) });
    check("error -> incomplete (it used to render as 'no live link')", [r.incomplete, r.links], [true, null]);
    check("error -> reason error", JSON.parse(logs[0]).reason, "error");
    check("error on the first read -> the dependent reads are not attempted", admin.used.length, 0);
  }

  section("4. the route and the drawer use it");
  const root = join(__dirname, "..");
  const route = readFileSync(join(root, "src/app/api/entity/[type]/[id]/route.ts"), "utf8");
  check("the route calls loadDrawerLiveLinks", /await loadDrawerLiveLinks\(/.test(route), true);
  check("the route returns reviewLinksIncomplete", /\n\s+reviewLinksIncomplete,\n/.test(route), true);
  check("no un-timed client_review_links read is left in the route", /from\("client_review_links"\)/.test(route), false);
  const drawer = readFileSync(join(root, "src/components/EntityDrawer.tsx"), "utf8");
  check("the drawer shows a notice instead of the block", /data\.reviewLinksIncomplete && \(/.test(drawer) && /!data\.reviewLinksIncomplete && <LiveLinksBox/.test(drawer), true);

  clearInterval(keepAlive);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
