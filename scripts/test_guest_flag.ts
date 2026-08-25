/**
 * The guest-missing flag, against the real table (owner spec 2026-08-25).
 *
 * Run:  npx tsx scripts/test_guest_flag.ts
 *
 * TOUCHES MORNING: never. Nothing here issues, approves or enqueues — the
 * predicate under test is pure, and the rows it is exercised against are read,
 * not written.
 *
 * WRITES: only the synthetic bundle in part 3, which needs rows that do not
 * exist yet (no redemption has ever run in this account). Every row it creates
 * is deleted in the finally block AND the deletion is verified before this
 * script reports success.
 *
 * The cases are the REAL ones. A synthetic fixture would prove the function
 * agrees with itself; these prove it agrees with the table the bookkeeper is
 * looking at — including "ברק הרשקוביץ-גבעון", a real guest whose name ends in
 * a real studio, which is the one input that turns this flag from a help into a
 * liability if it is implemented with `includes`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { missingGuestLines, isStudioName } from "../src/lib/documents/guestFlag";
import { STUDIOS } from "../src/lib/calendar/studios";
import { buildLineItemText } from "../src/lib/documents/enqueue";

for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  const k = t.slice(0, i).trim();
  if (!process.env[k]) process.env[k] = t.slice(i + 1).trim();
}
const admin: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// everything this script creates, so the finally block is exhaustive
const made = { pending: [] as string[] };

// the single-production shape the screens use: one guest, one base line
const flagged = (guest: string | null, line: string): boolean =>
  missingGuestLines([guest], [line], STUDIOS).length > 0;

async function main() {
  // ---------------------------------------------------------------- part 1
  // Every accrued row in the table, judged against what a human reads.
  console.log("\n1. THE REAL ACCRUED QUEUE");
  const { data: accrued } = await admin
    .from("pending_documents")
    .select("id,created_at,payload,productions(podcast_name,record_date,guest)")
    .eq("doc_type", "work_order")
    .eq("status", "accrued")
    .order("created_at");

  let sawGuestless = 0;
  let sawStudio = 0;
  let sawMissing = 0;
  let sawPresent = 0;

  for (const r of (accrued ?? []) as unknown as Array<Record<string, unknown>>) {
    const prod = r.productions as { guest?: string; podcast_name?: string } | null;
    const guest = prod?.guest ?? null;
    const line = ((r.payload as { income?: { description?: string }[] })?.income ?? [])[0]?.description ?? "";
    const isMissing = flagged(guest, line);
    const date = (r.created_at as string).slice(0, 10);

    if (!guest?.trim()) {
      sawGuestless++;
      check(`${date} no guest -> silent`, !isMissing, JSON.stringify(line));
    } else if (isStudioName(guest, STUDIOS)) {
      sawStudio++;
      check(`${date} guest="${guest}" is a STUDIO -> silent`, !isMissing, JSON.stringify(line));
    } else if (line.includes(guest.trim())) {
      sawPresent++;
      check(`${date} guest="${guest}" is on the line -> silent`, !isMissing);
    } else {
      sawMissing++;
      check(`${date} guest="${guest}" missing from line -> FLAG`, isMissing, JSON.stringify(line));
    }
  }

  // The queue must actually contain each shape, or the passes above are vacuous.
  console.log(
    `\n  coverage: guestless=${sawGuestless} studio=${sawStudio} present=${sawPresent} missing=${sawMissing}`
  );
  check("the real queue exercises a guestless row", sawGuestless > 0);
  check("the real queue exercises a studio-as-guest row", sawStudio > 0);
  check("the real queue exercises a guest-on-the-line row", sawPresent > 0);
  check("the real queue exercises a guest-missing row", sawMissing > 0);

  // ---------------------------------------------------------------- part 2
  // The trap. A containment test against the studio list would swallow this
  // man, and the flag would then report "fine" on the shape it exists to catch.
  console.log("\n2. THE TRAP — a real guest whose name contains a real studio");
  // Selected on the CONDITION, not on a name: any production whose guest
  // contains a studio variant without being one. Hard-coding a person here
  // would let the test keep passing after that row is edited away, which is
  // exactly when it stops meaning anything.
  const { data: candidates } = await admin
    .from("productions")
    .select("id,podcast_name,guest,record_date")
    .not("guest", "is", null);
  const variants = STUDIOS.flatMap((s) => s.variants);
  const trap = ((candidates ?? []) as Array<Record<string, unknown>>).find((p) => {
    const g = String(p.guest ?? "");
    return variants.some((v) => g.includes(v)) && !isStudioName(g, STUDIOS);
  });

  check("a guest containing a studio name exists in the table", !!trap, trap ? String(trap.guest) : "NONE FOUND");
  if (trap) {
    const which = variants.filter((v) => String(trap.guest).includes(v));
    console.log(`  (trap row: guest="${trap.guest}" contains studio ${JSON.stringify(which)})`);
    const guest = trap.guest as string;
    check(`guest="${guest}" is NOT classified as a studio`, !isStudioName(guest, STUDIOS));
    // the pre-B line for that production: show + raw date, no guest
    const preB = `הזמנת עבודה — ${trap.podcast_name} ${trap.record_date}`;
    check(`guest="${guest}" missing from a pre-B line -> FLAG`, flagged(guest, preB), JSON.stringify(preB));
    // and the line B builds for the same production stays silent
    const postB = `הזמנת עבודה — ${buildLineItemText(trap as never)}`;
    check(`the same guest on B's own line -> silent`, !flagged(guest, postB), JSON.stringify(postB));
  }
  // the room itself, on the same list, must still be silent
  check('guest="גבעון" (the room) -> silent', !flagged("גבעון", "הזמנת עבודה — דעה לא פופולרית 2026-08-13"));
  check('guest="גבעון קטן" (a variant) -> silent', !flagged("גבעון קטן", "הזמנת עבודה — x 2026-08-13"));
  // whitespace, exactly as the feed stores it
  check('guest="יואב בלום " (trailing space) on the line -> silent', !flagged("יואב בלום ", "הזמנת עבודה — סטימצקי · יואב בלום · 09.08.26"));
  check('guest="יואב בלום " (trailing space) off the line -> FLAG', flagged("יואב בלום ", "הזמנת עבודה — סטימצקי 2026-08-09"));

  // ---------------------------------------------------------------- part 3
  // A bundle with ONE bad line among good ones: the flag must name the right
  // index, and it must do so by TEXT — the redeem route reads its source rows
  // with no ORDER BY, so position is not reproducible.
  console.log("\n3. A BUNDLE WITH ONE MISSING GUEST");
  const guests = ["רות קבסה אברמזון", "עידן טנדלר", "דנה ספקטור"];
  const lines = [
    "הזמנת עבודה — דעה לא פופולרית · רות קבסה אברמזון · 23.08.26",
    "הזמנת עבודה — דעה לא פופולרית 2026-08-02", // the bad one, index 1
    "הזמנת עבודה — חתונמיות · דנה ספקטור · 24.08.26",
  ];
  const missing = missingGuestLines(guests, lines, STUDIOS);
  check("exactly one line is flagged", missing.length === 1, JSON.stringify(missing));
  check("it is index 1, the line that lost its guest", missing[0] === 1);

  // the same three lines, resolved the way page.tsx resolves them: by text, off
  // rows written in a DIFFERENT order than the bundle holds
  const { data: client } = await admin.from("clients").select("id").limit(1).single();
  const bundleId = randomUUID();
  const shuffled = [2, 0, 1]; // sources come back in whatever order the DB likes
  const sourceRows = shuffled.map((i) => ({
    id: randomUUID(),
    doc_type: "work_order",
    status: "consolidated",
    consolidated_into: bundleId,
    client_id: client!.id,
    amount: 100,
    payload: { income: [{ description: lines[i], price: 100, quantity: 1 }] },
  }));

  const { error: bundleErr } = await admin.from("pending_documents").insert({
    id: bundleId,
    doc_type: "work_order",
    status: "pending",
    client_id: client!.id,
    amount: 300,
    payload: { income: lines.map((d) => ({ description: d, price: 100, quantity: 1 })) },
  });
  if (bundleErr) throw new Error("bundle insert: " + bundleErr.message);
  made.pending.push(bundleId);

  const { error: srcErr } = await admin.from("pending_documents").insert(sourceRows);
  if (srcErr) throw new Error("sources insert: " + srcErr.message);
  made.pending.push(...sourceRows.map((r) => r.id));

  // replay page.tsx's resolution against the rows as the DB returns them
  const { data: sources } = await admin
    .from("pending_documents")
    .select("payload")
    .eq("consolidated_into", bundleId);
  const guestOf = new Map<string, string | null>();
  sourceRows.forEach((s, n) => guestOf.set(lines[shuffled[n]], guests[shuffled[n]]));
  const byText = new Map<string, string | null>();
  for (const s of (sources ?? []) as unknown as Array<Record<string, unknown>>) {
    const text = ((s.payload as { income?: { description?: string }[] })?.income ?? [])[0]?.description;
    if (typeof text === "string" && !byText.has(text)) byText.set(text, guestOf.get(text) ?? null);
  }
  const resolved = lines.map((l) => byText.get(l) ?? null);
  check("text-matching recovers every guest despite the shuffled read", resolved.join("|") === guests.join("|"), JSON.stringify(resolved));
  const missing2 = missingGuestLines(resolved, lines, STUDIOS);
  check("the flag still names index 1 after the round trip", missing2.length === 1 && missing2[0] === 1, JSON.stringify(missing2));

  // ---------------------------------------------------------------- part 4
  console.log("\n4. DEGENERATE INPUTS (must never throw, never flag)");
  check("no guests, no lines", missingGuestLines([], [], STUDIOS).length === 0);
  check("guest but no lines at all", missingGuestLines(["x"], [], STUDIOS).length === 0);
  check("lines but no guests", missingGuestLines([], ["a", "b"], STUDIOS).length === 0);
  check("null guest, null line", missingGuestLines([null], [null], STUDIOS).length === 0);
  check("whitespace-only guest", missingGuestLines(["   "], ["a"], STUDIOS).length === 0);
  check(
    "guests shorter than lines -> only index 0 is judged (add-ons are never flagged)",
    missingGuestLines(["דנה ספקטור"], ["הזמנת עבודה — חתונמיות · דנה ספקטור · 24.08.26", "עריכת ריל"], STUDIOS).length === 0
  );
}

main()
  .catch((e) => {
    failed++;
    console.error("\nTHREW:", e instanceof Error ? e.message : e);
  })
  .finally(async () => {
    console.log("\nCLEANUP");
    if (made.pending.length) {
      await admin.from("pending_documents").delete().in("id", made.pending);
    }
    // verified, not assumed
    const { data: left } = await admin.from("pending_documents").select("id").in("id", made.pending.length ? made.pending : ["-"]);
    const leftover = (left ?? []).length;
    check(`all ${made.pending.length} created rows deleted`, leftover === 0, leftover ? `${leftover} LEFT BEHIND` : "");

    console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
    process.exit(failed === 0 ? 0 : 1);
  });
