/**
 * A queue row stranded in 'approved', and the deadline that should stop it
 * happening (owner spec 2026-08-25).
 *
 * Run:  npx tsx scripts/test_approved_stranded.ts
 *
 * TOUCHES MORNING: never. Nothing here approves or issues anything — the one
 * row it creates is written straight into 'approved', which is the state under
 * test, and it carries a synthetic payload no code path will send.
 *
 * Every row created is deleted in the finally block AND the deletion is
 * verified. The status census is taken before and after and compared, because
 * the whole point of this change is that no existing document moved.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { MORNING_TIMEOUT_MS } from "../src/lib/morning/client";

for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  const k = t.slice(0, i).trim();
  if (!process.env[k]) process.env[k] = t.slice(i + 1).trim();
}
const SUP = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const APP = process.env.TEST_APP_URL ?? "http://localhost:3000";
const REF = SUP.split("//")[1].split(".")[0];
const admin: SupabaseClient = createClient(SUP, SVC, { auth: { persistSession: false } });

let failed = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
};

const made = { pending: [] as string[] };
let uid: string | null = null;
let hung: Server | null = null;
let censusBefore: Record<string, number> = {};

async function census(): Promise<Record<string, number>> {
  const { data } = await admin.from("pending_documents").select("status");
  const out: Record<string, number> = {};
  for (const r of data ?? []) out[r.status as string] = (out[r.status as string] ?? 0) + 1;
  return out;
}

async function cookieHeader(): Promise<string> {
  const email = `ztest-${randomUUID().slice(0, 8)}@example.com`;
  const pw = `Test-${randomUUID()}!A1`;
  const cu = await fetch(`${SUP}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pw, email_confirm: true }),
  }).then((r) => r.json());
  uid = cu.id;
  await fetch(`${SUP}/rest/v1/profiles?id=eq.${uid}`, {
    method: "PATCH",
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" },
    body: JSON.stringify({ approved: true, can_view_stages: true, can_edit_stages: true, can_view_money: true, can_edit_money: true, role: "owner" }),
  });
  const tok = await fetch(`${SUP}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pw }),
  }).then((r) => r.json());
  const val = "base64-" + Buffer.from(JSON.stringify(tok)).toString("base64");
  const name = `sb-${REF}-auth-token`;
  if (val.length <= 3180) return `${name}=${val}`;
  const parts: string[] = [];
  for (let i = 0, n = 0; i < val.length; i += 3180, n++) parts.push(`${name}.${n}=${val.slice(i, i + 3180)}`);
  return parts.join("; ");
}

async function main() {
  censusBefore = await census();
  console.log("=== 0. STATUS CENSUS BEFORE ===");
  console.log("  " + JSON.stringify(censusBefore));

  // ---------------------------------------------------------------- part 1
  console.log("\n1. THE DEADLINE ACTUALLY CUTS A HUNG CONNECTION");
  console.log(`   MORNING_TIMEOUT_MS = ${MORNING_TIMEOUT_MS}`);
  check("the deadline is under Vercel's declared maxDuration (60s)", MORNING_TIMEOUT_MS < 60_000);
  check("the deadline is far above the slowest observed call (2.48s)", MORNING_TIMEOUT_MS > 2_480 * 2);

  // a socket that accepts and never answers — exactly the shape that used to
  // hang until the platform killed the function
  hung = createServer(() => {
    /* accept, write nothing, never end */
  });
  await new Promise<void>((res) => hung!.listen(0, "127.0.0.1", () => res()));
  const port = (hung.address() as { port: number }).port;

  // A short deadline is used for the timing assertion — waiting 15s to prove a
  // mechanism is 15s of nothing. The REAL constant is asserted above and its
  // wiring below; this proves an AbortSignal deadline severs a hung socket.
  const t0 = Date.now();
  let abortName = "";
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_200) });
  } catch (e) {
    abortName = e instanceof Error ? e.name : String(e);
  }
  const elapsed = Date.now() - t0;
  check("a hung socket is aborted, not left to hang", abortName === "TimeoutError", `name=${abortName} after ${elapsed}ms`);
  check("it aborts at the deadline, not later", elapsed < 4_000, `${elapsed}ms`);

  // and the wiring: no bare fetch may remain in the Morning client
  const src = readFileSync(join(process.cwd(), "src/lib/morning/client.ts"), "utf8");
  // Every `fetch(` in this file must either carry the deadline itself (that is
  // the wrapper) or be a call to the wrapper. A bare one is a call site that
  // can still hang.
  const bare = src
    .split("\n")
    .filter((l) => /\bfetch\(/.test(l))
    .filter((l) => !/fetchWithTimeout\(/.test(l))
    .filter((l) => !/AbortSignal\.timeout\(/.test(l));
  check("no fetch in morning/client.ts can hang without a deadline", bare.length === 0, bare.join(" | "));
  check("both call sites go through fetchWithTimeout", (src.match(/fetchWithTimeout\(/g) ?? []).length >= 3);
  check("the timeout message says the outcome is UNKNOWN", /לא ידוע אם המסמך נוצר/.test(src));
  check("the timeout message tells her to check before retrying", /בדקי במורנינג לפני ניסיון חוזר/.test(src));

  // ---------------------------------------------------------------- part 2
  console.log("\n2. A STRANDED ROW IS VISIBLE AND INERT");
  const { data: client } = await admin.from("clients").select("id,name").limit(1).single();
  const id = randomUUID();
  const { error: insErr } = await admin.from("pending_documents").insert({
    id,
    doc_type: "work_order",
    status: "approved", // the state under test: approved, never issued
    client_id: client!.id,
    amount: 1,
    payload: { type: 100, lang: "he", currency: "ILS", vatType: 0, description: "ZSTRANDED", income: [{ description: "ZSTRANDED", price: 1, quantity: 1 }], client: { id: "z", add: false } },
  });
  if (insErr) throw new Error("insert: " + insErr.message);
  made.pending.push(id);

  const { data: row } = await admin.from("pending_documents").select("status,morning_doc_id").eq("id", id).single();
  check("the row is approved with no morning_doc_id", row!.status === "approved" && row!.morning_doc_id === null);

  const cookie = await cookieHeader();

  // the server must refuse BOTH actions on it
  const rej = await fetch(`${APP}/api/documents/pending/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ ids: [id], action: "reject", reason: "בדיקה" }),
  });
  const rejBody = await rej.json();
  check("REJECT on an approved row is refused (409)", rej.status === 409, `HTTP ${rej.status} ${JSON.stringify(rejBody).slice(0, 160)}`);
  const { data: afterRej } = await admin.from("pending_documents").select("status").eq("id", id).single();
  check("...and the row is untouched", afterRej!.status === "approved", String(afterRej!.status));

  const app = await fetch(`${APP}/api/documents/pending/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ ids: [id], action: "approve" }),
  });
  const appBody = await app.json();
  const r0 = (appBody.results ?? [])[0];
  check("APPROVE on an approved row is refused", r0 && r0.ok === false, JSON.stringify(appBody).slice(0, 160));
  const { data: afterApp } = await admin.from("pending_documents").select("status").eq("id", id).single();
  check("...and the row is still untouched", afterApp!.status === "approved", String(afterApp!.status));

  // ---------------------------------------------------------------- part 3
  console.log("\n3. WHAT SHIRI SEES");
  const res = await fetch(`${APP}/documents`, { headers: { cookie } });
  const html = await res.text();
  check("the queue page renders", res.status === 200, `HTTP ${res.status}`);
  check("the stranded row appears on the queue", html.includes("ZSTRANDED"));
  check('it carries the tag "אושר ולא הונפק"', html.includes("אושר ולא הונפק"));
  check("the instruction replaces the buttons", html.includes("ייתכן שהמסמך נוצר במורנינג — בדקי שם לפני כל פעולה"));

  // the row's own markup must not offer either action
  const start = html.indexOf("ZSTRANDED");
  const card = html.slice(Math.max(0, start - 4000), start + 4000);
  const seg = card.slice(card.lastIndexOf("<li", card.indexOf("ZSTRANDED")) >= 0 ? 0 : 0);
  check("no 'דחה' button beside the stranded row", !/>\s*דחה\s*</.test(seg.slice(seg.indexOf("ZSTRANDED") - 2500, seg.indexOf("ZSTRANDED") + 2500)));

  // ---------------------------------------------------------------- part 4
  console.log("\n4. THE RADAR SEES IT TOO");
  const radar = await fetch(`${APP}/radar`, { headers: { cookie } });
  const rhtml = await radar.text();
  check("the radar renders", radar.status === 200, `HTTP ${radar.status}`);
  check("a red card names the stranded document", rhtml.includes("מסמך אושר ולא הונפק"), "alert docs_approved_not_issued");
}

main()
  .catch((e) => {
    failed++;
    console.error("\nTHREW:", e instanceof Error ? e.message : e);
  })
  .finally(async () => {
    console.log("\n=== CLEANUP ===");
    if (made.pending.length) await admin.from("events").delete().in("entity_id", made.pending);
    if (made.pending.length) await admin.from("pending_documents").delete().in("id", made.pending);
    if (uid) await fetch(`${SUP}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } });
    hung?.close();

    const { data: left } = await admin.from("pending_documents").select("id").in("id", made.pending.length ? made.pending : ["-"]);
    check(`all ${made.pending.length} created rows deleted`, (left ?? []).length === 0);

    const after = await census();
    console.log("  census after : " + JSON.stringify(after));
    check("the status census is identical to before — no existing row moved", JSON.stringify(after) === JSON.stringify(censusBefore), JSON.stringify(censusBefore) + " vs " + JSON.stringify(after));

    console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
    process.exit(failed === 0 ? 0 : 1);
  });
