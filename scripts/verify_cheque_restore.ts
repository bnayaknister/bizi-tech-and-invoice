/**
 * Payment-method restore verification — READ ONLY. Runs the REAL priorPayment /
 * priorChequeFields against live queue rows and prints what the approval modal
 * would reopen with. Writes nothing: no insert, no update, no event.
 *
 * Why it exists: the modal used to call setPayMethod(4) on every open, so a row
 * that failed on a cheque came back showing העברה בנקאית — one click from a tax
 * document issued by a method nobody chose, silently and irreversibly. The fix
 * restores the method from the row's own stored payload instead. That restore
 * is a pure function over data, which is exactly the part an HTTP test cannot
 * see, so it is checked here against the real rows.
 *
 * Run:  npx tsx scripts/verify_cheque_restore.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { PAYMENT_METHODS, priorChequeFields, priorPayment } from "../src/lib/morning/types";

for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  const k = t.slice(0, i).trim();
  if (!process.env[k]) process.env[k] = t.slice(i + 1).trim();
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false } }
);

const label = (code: number | null) =>
  code === null ? "(בחר אמצעי — ריק)" : PAYMENT_METHODS.find((m) => m.code === code)?.label ?? `?${code}`;

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? `   [${detail}]` : ""));
  if (!ok) failed++;
}

async function main() {
  // every queue row that carries money — the only ones the modal asks about
  const { data: rows, error } = await admin
    .from("pending_documents")
    .select("id,doc_type,status,amount,attempts,last_error,payload,morning_doc_number")
    .in("doc_type", ["tax_receipt", "receipt"])
    .order("created_at", { ascending: true });
  if (error) throw error;

  console.log(`\n${rows?.length ?? 0} payment-carrying queue rows, and what the modal reopens with:\n`);
  for (const r of rows ?? []) {
    const prior = priorPayment(r.payload as Record<string, unknown>);
    const code = prior ? Number(prior.type) : null;
    const chq = priorChequeFields(prior);
    const chqText = Object.keys(chq).length
      ? " · " + Object.entries(chq).map(([k, v]) => `${k}=${v || "(ריק)"}`).join(" ")
      : "";
    console.log(
      `  ${r.id.slice(0, 8)}  ${String(r.doc_type).padEnd(12)} ${String(r.status).padEnd(8)} ` +
        `doc=${r.morning_doc_number ?? "—"}  →  ${label(code)}${chqText}`
    );
  }

  // The row this whole piece of work came from: it failed on a cheque, and the
  // old screen reopened it on העברה בנקאית.
  const gal = (rows ?? []).find((r) => r.status === "failed" && r.last_error?.includes("צ׳ק"));
  console.log("\nthe reported row:");
  if (!gal) {
    console.log("  (not present — it has since been issued or removed)");
  } else {
    const prior = priorPayment(gal.payload as Record<string, unknown>);
    check("a previous attempt is found", prior !== null);
    check("reopens on צ׳ק (2), not העברה בנקאית (4)", Number(prior?.type) === 2, String(prior?.type));
    check(
      "the four cheque inputs are prefilled from that attempt",
      Object.keys(priorChequeFields(prior)).length === 4,
      JSON.stringify(priorChequeFields(prior))
    );
  }

  // A row that was never approved must leave the picker EMPTY — no guess.
  console.log("\na row with no previous attempt:");
  const fresh = (rows ?? []).find((r) => priorPayment(r.payload as Record<string, unknown>) === null);
  if (!fresh) {
    console.log("  (every live row carries a payment block — checked against a literal instead)");
    check("no payment block → null", priorPayment({ income: [] }) === null);
    check("empty payment array → null", priorPayment({ payment: [] }) === null);
  } else {
    check(`${fresh.id.slice(0, 8)} reopens empty`, priorPayment(fresh.payload as Record<string, unknown>) === null);
  }
  check("a payment row with no type → null (nothing to restore)", priorPayment({ payment: [{ price: 1 }] }) === null);
  check("a non-cheque prior restores no cheque fields",
    Object.keys(priorChequeFields({ type: 4 })).length === 0);

  console.log(failed ? `\n${failed} failed\n` : "\nall checks passed\n");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
