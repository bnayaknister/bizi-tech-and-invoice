/**
 * E17-3 — a client that is not `active` is not listed, picked, matched, synced
 * or billed. Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_client_status_filter.ts
 *
 * ═══ F19 ═══
 * No database, no network, no Morning. The "database" is an in-memory fake
 * that FILTERS like PostgREST does (eq / neq / in / is / not / ilike), so a
 * query that forgot `.eq("status", ACTIVE_CLIENT)` really does get the pending
 * row back and the assertion fails. MORNING_DRY_RUN is forced on and
 * `global.fetch` throws, so nothing here can reach Morning even by accident.
 *
 * ═══ FOUR PARTS ═══
 *   1. the scan — every `.from("clients")` in src/ either filters on status in
 *      its own chain, or carries a `clients-status:` comment saying why not
 *   2. the pure rules — isActiveClient, the message, the list scopes, who sees
 *      which statuses, the calendar sync's show filter
 *   3. the common lists, run against the fake — pending/rejected never return
 *   4. the issuance gate — checkEligibility and issuePendingDocument refuse a
 *      pending client, write the event, and never reach Morning
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ACTIVE_CLIENT,
  excludeShowsOfInactiveClients,
  findInactiveClients,
  inactiveClientMessage,
  isActiveClient,
} from "../src/lib/clients/status";
import { clientStatusesVisibleTo } from "../src/lib/clients/access";
import { buildClientList, filterClients, type ClientRow } from "../src/lib/clients/overview";
import { loadMorningIdMap, loadMorningIdsByClient } from "../src/lib/clients/morningIds";
import { checkEligibility } from "../src/lib/documents/enqueue";
import { issuePendingDocument, type PendingRow } from "../src/lib/documents/issue";
import type { Profile } from "../src/lib/profile";

process.env.MORNING_DRY_RUN = "true";
global.fetch = (() => {
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

// ─────────────────────────────────────────────────────────────────────────────
// the fake: a table store with a PostgREST-shaped builder that really filters
// ─────────────────────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
type Call = { table: string; op: string; payload?: unknown };

function fakeDb(tables: Record<string, Row[]>, opts: { failOn?: string } = {}) {
  const calls: Call[] = [];
  function from(table: string) {
    let rows = [...(tables[table] ?? [])];
    let op = "select";
    let payload: unknown;
    let one = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: () => b,
      insert: (v: unknown) => ((op = "insert"), (payload = v), b),
      update: (v: unknown) => ((op = "update"), (payload = v), b),
      delete: () => ((op = "delete"), b),
      eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), b),
      neq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] !== v)), b),
      in: (c: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[c]))), b),
      is: (c: string, v: unknown) => ((rows = rows.filter((r) => (r[c] ?? null) === v)), b),
      not: (c: string, o: string, v: unknown) => {
        if (o === "is" && v === null) rows = rows.filter((r) => r[c] != null);
        return b;
      },
      ilike: (c: string, p: string) => {
        const n = p.replace(/%/g, "").toLowerCase();
        rows = rows.filter((r) => String(r[c] ?? "").toLowerCase().includes(n));
        return b;
      },
      order: () => b,
      limit: () => b,
      range: () => b,
      maybeSingle: () => ((one = true), b),
      single: () => ((one = true), b),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        calls.push({ table, op, payload });
        if (opts.failOn === table) {
          return Promise.resolve({ data: null, error: { message: "boom" } }).then(res, rej);
        }
        const data = op === "select" ? (one ? rows[0] ?? null : rows) : null;
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return b;
  }
  return { admin: { from } as never, calls };
}

const CLIENTS: Row[] = [
  { id: "cA", name: "אקטיב בע״מ", normalized_name: "אקטיב בע״מ", morning_client_id: "mA", merged_into: null, status: "active" },
  // a pending registration can never hold a Morning id in life (0107: it enters
  // Morning only on approval). It holds one HERE on purpose: it is the
  // strongest version of the test — even a pending row that looks billable
  // must not come back from a list.
  { id: "cP", name: "ממתין בע״מ", normalized_name: "ממתין בע״מ", morning_client_id: "mP", merged_into: null, status: "pending" },
  { id: "cR", name: "נדחה בע״מ", normalized_name: "נדחה בע״מ", morning_client_id: "mR", merged_into: null, status: "rejected" },
];

async function main() {
  // ═══ 1. the scan ═══════════════════════════════════════════════════════════
  console.log("\n── 1. every .from(\"clients\") in src/ is classified");
  {
    const root = join(__dirname, "..", "src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f) && !f.endsWith("database.types.ts")) files.push(p);
      }
    };
    walk(root);

    const filtered: string[] = [];
    const annotated: string[] = [];
    const unclassified: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const re = /\.from\(\s*["']clients["']\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const line = src.slice(0, m.index).split("\n").length;
        // prose in a comment is not a query
        const lineText = src.split("\n")[line - 1].trim();
        if (lineText.startsWith("*") || lineText.startsWith("//")) continue;
        const where = `${relative(join(root, ".."), f)}:${line}`;
        // the chain: forward from .from(...) to the first `;` or `,` at depth 0,
        // or the bracket that closes the enclosing expression
        let depth = 0;
        let end = m.index;
        for (; end < src.length; end++) {
          const ch = src[end];
          if (ch === "(" || ch === "[" || ch === "{") depth++;
          else if (ch === ")" || ch === "]" || ch === "}") {
            depth--;
            if (depth < 0) break;
          } else if (depth === 0 && (ch === ";" || ch === ",")) break;
        }
        const chain = src.slice(m.index, end);
        const lines = src.split("\n");
        const context = lines.slice(Math.max(0, line - 3), line).join("\n");
        if (chain.includes("ACTIVE_CLIENT") || chain.includes('.in("status"')) filtered.push(where);
        else if (context.includes("clients-status:")) annotated.push(where);
        else unclassified.push(where);
      }
    }
    console.log(`     ${filtered.length} filtered on status · ${annotated.length} annotated (by id / write)`);
    check("zero unclassified client queries", unclassified, []);
    check("the scan found the lists (sanity: more than 25 filtered)", filtered.length > 25, true);
    check("the scan found the by-id reads (sanity: more than 15 annotated)", annotated.length > 15, true);
  }

  // ═══ 2. the pure rules ═════════════════════════════════════════════════════
  console.log("\n── 2. the pure rules");
  check("active is active", isActiveClient("active"), true);
  check("pending / rejected / null / undefined are NOT", [isActiveClient("pending"), isActiveClient("rejected"), isActiveClient(null), isActiveClient(undefined)], [false, false, false, false]);
  check("pending message names the client and the reason", inactiveClientMessage("ממתין בע״מ", "pending"), "הלקוח 'ממתין בע״מ' ממתין לאישור הרשמה — לא ניתן להנפיק לו מסמכים");
  check("rejected message", inactiveClientMessage(null, "rejected"), "הלקוח אינו לקוח פעיל — לא ניתן להנפיק לו מסמכים");

  const base: Profile = {
    id: "u", name: "x", email: "x@x", role: "owner", approved: true,
    can_view_money: true, can_edit_money: true, can_view_stages: true, can_edit_stages: true,
    can_manage_users: true, can_import: true, studio_admin: false,
  };
  check("an owner with every money flag sees active only", clientStatusesVisibleTo(base), ["active"]);
  check("a studio_admin sees active + pending", clientStatusesVisibleTo({ ...base, studio_admin: true }), ["active", "pending"]);
  check("an UNAPPROVED studio_admin sees active only", clientStatusesVisibleTo({ ...base, studio_admin: true, approved: false }), ["active"]);
  check("rejected is in nobody's list", clientStatusesVisibleTo({ ...base, studio_admin: true }).includes("rejected"), false);

  const rowsIn: ClientRow[] = [
    { id: "cA", name: "אקטיב", normalized_name: "אקטיב", morning_client_id: "mA", merged_into: null, status: "active" },
    { id: "cP", name: "ממתין", normalized_name: "ממתין", morning_client_id: null, merged_into: null, status: "pending" },
  ];
  const list = buildClientList(rowsIn, [{ id: "s1", name: "פוד", client_id: "cP", active: true }, { id: "s2", name: "פוד2", client_id: "cA", active: true }], [], "2026-10-11");
  check("buildClientList marks pending", list.map((r) => [r.id, r.pending]), [["cA", false], ["cP", true]]);
  check("pending is NOT in 'פעילים'", filterClients(list, "active", "").map((r) => r.id), ["cA"]);
  check("pending is NOT in 'הכול'", filterClients(list, "all", "").map((r) => r.id), ["cA"]);
  check("pending is NOT in 'מוזגו'", filterClients(list, "merged", "").map((r) => r.id), []);
  check("pending IS in its own tab, alone", filterClients(list, "pending", "").map((r) => r.id), ["cP"]);
  check("search inside the pending tab", filterClients(list, "pending", "ממת").map((r) => r.id), ["cP"]);

  const shows = [
    { id: "s1", client_id: "cA" },
    { id: "s2", client_id: "cP" },
    { id: "s3", client_id: null },
    { id: "s4", client_id: "cR" },
  ];
  check(
    "calendar sync: shows of pending/rejected clients are not matched; internal shows are",
    excludeShowsOfInactiveClients(shows, new Set(["cP", "cR"])).map((s) => s.id),
    ["s1", "s3"]
  );

  // ═══ 3. the common lists, against the fake ═════════════════════════════════
  console.log("\n── 3. the lists return active clients only");
  {
    const { admin } = fakeDb({ clients: CLIENTS, client_morning_ids: [] });
    const map = await loadMorningIdMap(admin);
    check("loadMorningIdMap: only the active client's Morning id", Array.from(map.entries()), [["mA", "cA"]]);
    const byClient = await loadMorningIdsByClient(admin);
    check("loadMorningIdsByClient: only the active client", Array.from(byClient.keys()), ["cA"]);
  }
  {
    // the /clients loader's own query shape (fetchVisibleClients) — `.in("status", …)`
    const { admin } = fakeDb({ clients: CLIENTS });
    const q = (statuses: string[]) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (admin as any).from("clients").select("id").in("status", statuses).range(0, 999) as Promise<{ data: Row[] }>;
    check("/clients for everyone: active only", (await q(clientStatusesVisibleTo(base))).data.map((r) => r.id), ["cA"]);
    check("/clients for a studio_admin: active + pending, never rejected", (await q(clientStatusesVisibleTo({ ...base, studio_admin: true }))).data.map((r) => r.id), ["cA", "cP"]);
  }
  {
    const { admin } = fakeDb({ clients: CLIENTS });
    // the picker/search/list shape every filtered page uses
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (await (admin as any).from("clients").select("id,name").eq("status", ACTIVE_CLIENT).order("name")) as { data: Row[] };
    check("a picker list: active only", r.data.map((x) => x.id), ["cA"]);
  }

  // ═══ 4. the issuance gate ══════════════════════════════════════════════════
  console.log("\n── 4. no document for a client that is not active");
  {
    const prod = { id: "p1", show_id: "s1", client_id: "cP", kind: "client", legacy: false, price_override: null, status: "הוקלט", studio_hours: null } as never;
    const show = { id: "s1", client_id: "cP", billing_mode: "per_episode", default_rate: 900 } as never;
    const e = checkEligibility(prod, show, { id: "cP", name: "ממתין בע״מ", morning_client_id: "mP", status: "pending" });
    check("checkEligibility: pending is BLOCKED (applicable, with the sentence)", e, { ok: false, applicable: true, reason: inactiveClientMessage("ממתין בע״מ", "pending") });
    const e2 = checkEligibility(prod, show, { id: "cP", name: "x", morning_client_id: null, status: "pending" });
    check("checkEligibility: pending wins over 'not mapped' (the reason says pending)", (e2 as { reason: string }).reason.includes("ממתין לאישור"), true);
    const e3 = checkEligibility(prod, show, { id: "cA", name: "x", morning_client_id: "mA", status: null });
    check("checkEligibility: a missing status refuses (absent is not active)", e3.ok, false);
    const e4 = checkEligibility(prod, show, { id: "cA", name: "x", morning_client_id: "mA", status: "active" });
    check("checkEligibility: active passes", e4.ok, true);
  }
  {
    const { admin } = fakeDb({ clients: CLIENTS });
    const m = await findInactiveClients(admin, ["cA", "cP", "cR", "gone", null]);
    check("findInactiveClients: pending, rejected and a missing row — never the active one", Array.from(m.keys()).sort(), ["cP", "cR", "gone"]);
    let threw = false;
    try {
      await findInactiveClients(fakeDb({ clients: CLIENTS }, { failOn: "clients" }).admin, ["cA"]);
    } catch {
      threw = true;
    }
    check("findInactiveClients: a failed read THROWS (never a silent pass)", threw, true);
  }
  {
    const { admin, calls } = fakeDb({ clients: CLIENTS, productions: [], misc_productions: [] });
    const row: PendingRow = {
      id: "pd1", doc_type: "tax_invoice", production_id: null, job_id: null, client_id: "cP",
      amount: 100, payload: { client: { id: "mP" } } as never, status: "approved", morning_doc_id: null, attempts: 0,
    };
    const out = await issuePendingDocument(admin, row, "actor");
    check("issuePendingDocument: pending client refused", out, { ok: false, error: inactiveClientMessage("ממתין בע״מ", "pending") });
    const ev = calls.filter((c) => c.table === "events" && c.op === "insert").map((c) => (c.payload as { event_type: string }).event_type);
    check("…and the refusal is evented", ev, ["issue_blocked_client_inactive"]);
    check("…and the queue row was never touched", calls.filter((c) => c.table === "pending_documents").length, 0);
    check("…and no document was written", calls.filter((c) => c.table === "documents").length, 0);
  }
  {
    const { admin } = fakeDb({ clients: CLIENTS }, { failOn: "clients" });
    const row: PendingRow = {
      id: "pd2", doc_type: "tax_invoice", production_id: null, job_id: null, client_id: "cA",
      amount: 100, payload: {} as never, status: "approved", morning_doc_id: null, attempts: 0,
    };
    const out = await issuePendingDocument(admin, row, "actor");
    check("issuePendingDocument: an unreadable status is a refusal", out.ok, false);
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
