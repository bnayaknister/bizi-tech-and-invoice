/**
 * ONE-TIME DATA REPAIR (owner decision 2026-08-25). Kept in the repo as the
 * record of what was changed and why, the way the other one-off repairs here are.
 *
 * Run:  npx tsx scripts/cleanup_studio_in_guest.ts
 *
 * WHAT WAS WRONG. Before V1a (bba6103) the calendar parser did not separate the
 * guest from the recording room, so titles shaped "{host} - {show} - {studio}"
 * put the ROOM in productions.guest. Five rows carry that. The convention and
 * the parser were both fixed on 2026-08-19 ("אורח: X, אולפן") and the pollution
 * does not recur — רות קבסה (23.8) and דנה ספקטור (24.8) parse correctly — so
 * this is a cleanup, not a guard. No flag was built for it: a check that fires
 * on one historical row and is silent forever after is dead code.
 *
 * WHAT IT DOES. productions.guest only, on five rows named by id:
 *   • 13.08 דעה לא פופולרית (kind=client) -> the real guest, supplied by the
 *     owner. The calendar title never recorded one, and the name it DOES carry
 *     (ברק הרשקוביץ) is the show's host — 5 of 7 titles for this show open with
 *     it — so it could not be recovered from the feed.
 *   • the four kind=internal rows -> null. Never billed; the field is merely
 *     cleaned.
 *
 * TOUCHES MORNING: never. TOUCHES A DOCUMENT PAYLOAD: never — the frozen line
 * of the 13.8 work order is REPORTED here, not rewritten. What to do about it
 * is the owner's call, and it is the last step below.
 *
 * Safe to re-run: every row is matched by id and the target values are absolute.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { missingGuestLines, isStudioName } from "../src/lib/documents/guestFlag";
import { STUDIOS } from "../src/lib/calendar/studios";

for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  const k = t.slice(0, i).trim();
  if (!process.env[k]) process.env[k] = t.slice(i + 1).trim();
}
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const REPAIRS: { id: string; when: string; show: string; kind: string; to: string | null }[] = [
  { id: "a3a70519-eb6c-45f2-80eb-45cdf60c0fd0", when: "2026-08-13", show: "דעה לא פופולרית", kind: "client", to: "אלכס קושניר" },
  { id: "f0e7c8e2-11d7-4fb9-a0b9-bf44b6cc2cbf", when: "2026-08-12", show: "גיא ואור", kind: "internal", to: null },
  { id: "c3b88f38-5718-4e2c-a1e3-abbd801bf579", when: "2026-07-19", show: "דעה לא פופולרית", kind: "internal", to: null },
  { id: "f4971d65-2b1c-4ff6-9206-f64fbf21cfd2", when: "2026-07-28", show: "גיא ואור", kind: "internal", to: null },
  { id: "e4d72c6a-77d7-4842-b352-9c850f27d8b1", when: "2026-08-18", show: "גיא ואור", kind: "internal", to: null },
];

async function main() {
  // ---- 1. BEFORE, printed so the change is reversible from this output alone
  console.log("=== BEFORE ===");
  const { data: before } = await admin
    .from("productions")
    .select("id,podcast_name,guest,record_date,kind")
    .in("id", REPAIRS.map((r) => r.id));
  for (const r of REPAIRS) {
    const b = (before ?? []).find((x) => x.id === r.id);
    console.log(`  ${r.when}  ${r.show.padEnd(18)} kind=${r.kind.padEnd(8)} guest=${JSON.stringify(b?.guest)}`);
  }
  if ((before ?? []).length !== REPAIRS.length) {
    throw new Error(`expected ${REPAIRS.length} rows, found ${(before ?? []).length} — aborting`);
  }

  // ---- 2. APPLY
  console.log("\n=== APPLYING ===");
  for (const r of REPAIRS) {
    const { error } = await admin.from("productions").update({ guest: r.to }).eq("id", r.id);
    if (error) throw new Error(`${r.id}: ${error.message}`);
    console.log(`  ${r.when}  guest -> ${JSON.stringify(r.to)}`);
  }

  // ---- 3. AFTER
  console.log("\n=== AFTER ===");
  const { data: after } = await admin
    .from("productions")
    .select("id,podcast_name,guest,record_date,kind")
    .in("id", REPAIRS.map((r) => r.id));
  for (const r of REPAIRS) {
    const a = (after ?? []).find((x) => x.id === r.id);
    const ok = (a?.guest ?? null) === r.to;
    console.log(`  ${ok ? "OK  " : "FAIL"}  ${r.when}  guest=${JSON.stringify(a?.guest ?? null)}`);
  }

  // ---- 4. the whole table: is any studio name left in a guest field?
  console.log("\n=== VERIFY: STUDIO NAMES LEFT IN guest ===");
  const { data: all } = await admin
    .from("productions")
    .select("id,podcast_name,guest,record_date")
    .not("guest", "is", null);
  const left = (all ?? []).filter((p) => isStudioName(p.guest as string, STUDIOS));
  console.log(`  productions with a guest: ${(all ?? []).length}`);
  console.log(`  of them, guest IS a studio name: ${left.length}`);
  for (const p of left) console.log(`    STILL POLLUTED: ${p.record_date} ${JSON.stringify(p.guest)}`);

  // ---- 5. the frozen line of the 13.8 work order, read AFTER the guest fix
  console.log("\n=== THE 13.8 DOCUMENT, AFTER THE GUEST FIX ===");
  const target = REPAIRS[0];
  const { data: docs } = await admin
    .from("pending_documents")
    .select("id,doc_type,status,created_at,payload")
    .eq("production_id", target.id);
  for (const d of docs ?? []) {
    const lines = ((d.payload as { income?: { description?: string }[] })?.income ?? []).map((l) => l.description ?? "");
    console.log(`  ${d.doc_type}/${d.status}  queued ${String(d.created_at).slice(0, 10)}`);
    console.log(`    payload.description : ${JSON.stringify((d.payload as { description?: string })?.description)}`);
    console.log(`    income[0]           : ${JSON.stringify(lines[0])}`);
    console.log(`    contains "גבעון"    : ${lines.some((l) => l.includes("גבעון"))}`);
    console.log(`    contains the guest  : ${lines.some((l) => l.includes(String(target.to)))}`);
    const flag = missingGuestLines([target.to], lines, STUDIOS);
    console.log(`    guest-missing flag  : ${flag.length > 0 ? `LIT on line(s) ${JSON.stringify(flag)}` : "silent"}`);
  }
}
main().catch((e) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
