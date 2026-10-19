/**
 * B28 (minimal): the double-billing guard on POST /api/documents/bundle-from-show.
 *
 * Run (against a local `next start` on the production DB):
 *   npm run build && npx next start -p 3109 &
 *   APP=http://localhost:3109 npx tsx scripts/test_bundle_guard.ts
 *
 * A. bundleConflict — pure, fixtures only.
 * B. loadShowBundles — READ-ONLY against the real history (מחנה משותף has two
 *    issued bundles, the last on 4.10; אילון לוי one on 6.10).
 * C. the route, with a throwaway @bizi-test.local user (can_edit_money): a
 *    second bundle for מחנה משותף without the flag must be refused 409
 *    recent_issued, write a bundle_from_show_refused event, and create NO job
 *    and NO queue row. The override path is NOT exercised live — it would
 *    queue a real work order — only its decision is covered in A.
 *
 * Never reaches Morning (nothing is approved). Cleans up in finally: the test
 * user's events, anything it might have queued if the guard failed, then the
 * user itself, verified (GET 404).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  const k = t.slice(0, i).trim();
  if (!process.env[k]) process.env[k] = t.slice(i + 1).trim().replace(/^"|"$/g, "");
}

const SUP = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const REF = new URL(SUP).hostname.split(".")[0];
const APP = process.env.APP ?? "http://localhost:3109";
const MACHANE = "719e59fe-59c3-46f6-9100-5d8260743179"; // מחנה משותף
const ILON = "653b039e-f756-4401-87d0-ce3a4c77ae31"; // פודקאסט אילון לוי

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

const adminH = { apikey: SERVICE, "User-Agent": "bizi-admin/1.0", "Content-Type": "application/json" };
const restH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };

async function main() {
  const { bundleConflict, loadShowBundles } = await import("../src/lib/documents/bundleGuard");
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(SUP, SERVICE, { auth: { persistSession: false } });

  // ---- A. pure ------------------------------------------------------------
  const now = new Date("2026-10-19T12:00:00Z");
  const b = (status: string, issued: string | null = null) => ({
    id: status + (issued ?? ""), status, created_at: "2026-09-01T00:00:00Z", issued_at: issued, morning_doc_number: "1", quantity: 2,
  });
  check("A1 no bundles → null", bundleConflict([], now) === null);
  for (const st of ["pending", "approved", "failed"]) {
    check(`A2 ${st} → live_in_queue`, bundleConflict([b(st)], now)?.kind === "live_in_queue");
  }
  check("A3 issued 10 days ago → recent_issued", bundleConflict([b("issued", "2026-10-09T08:00:00Z")], now)?.kind === "recent_issued");
  check("A4 issued 40 days ago → null", bundleConflict([b("issued", "2026-09-09T08:00:00Z")], now) === null);
  check("A5 rejected/cancelled ignored", bundleConflict([b("rejected"), b("cancelled")], now) === null);
  check("A6 live wins over recent", bundleConflict([b("issued", "2026-10-15T08:00:00Z"), b("pending")], now)?.kind === "live_in_queue");
  const pick = bundleConflict([b("issued", "2026-10-01T08:00:00Z"), { ...b("issued", "2026-10-10T08:00:00Z"), morning_doc_number: "LAST" }], now);
  check("A7 recent = the latest issued", pick?.bundle.morning_doc_number === "LAST");

  // ---- B. read-only on the real history -----------------------------------
  const machane = await loadShowBundles(admin, MACHANE);
  check("B1 מחנה משותף: 2 bundles found", machane.length === 2, JSON.stringify(machane));
  const mc = bundleConflict(machane, new Date());
  check("B2 מחנה משותף → recent_issued 10341", mc?.kind === "recent_issued" && mc.bundle.morning_doc_number === "10341", JSON.stringify(mc));
  const ilon = await loadShowBundles(admin, ILON);
  check("B3 אילון לוי: 1 bundle (10344)", ilon.length === 1 && ilon[0].morning_doc_number === "10344", JSON.stringify(ilon));

  // ---- C. the route ---------------------------------------------------------
  const email = `b28-guard-${randomBytes(4).toString("hex")}@bizi-test.local`;
  const password = `Probe-${randomBytes(6).toString("hex")}`;
  let uid: string | null = null;
  try {
    const cu = await fetch(`${SUP}/auth/v1/admin/users`, {
      method: "POST", headers: adminH, body: JSON.stringify({ email, password, email_confirm: true }),
    });
    uid = ((await cu.json()) as { id: string }).id;
    await fetch(`${SUP}/rest/v1/profiles?id=eq.${uid}`, {
      method: "PATCH", headers: restH,
      body: JSON.stringify({ approved: true, role: "tech", can_edit_money: true, can_view_money: true }),
    });
    const tok = await (await fetch(`${SUP}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
    })).json();
    const val = "base64-" + Buffer.from(JSON.stringify(tok)).toString("base64");
    const name = `sb-${REF}-auth-token`;
    const cookie =
      val.length <= 3180
        ? `${name}=${val}`
        : (val.match(/.{1,3180}/g) ?? []).map((c, i) => `${name}.${i}=${c}`).join("; ");

    const res = await fetch(`${APP}/api/documents/bundle-from-show`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ showId: MACHANE, quantity: 1, unitPrice: 500 }),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: string; recent?: { number?: string } };
    check("C1 second bundle without the flag → 409 recent_issued", res.status === 409 && body.code === "recent_issued", `${res.status} ${JSON.stringify(body)}`);
    check("C2 the 409 names the last order (10341)", body.recent?.number === "10341", JSON.stringify(body));

    const { data: evs } = await admin.from("events").select("event_type,payload").eq("actor_id", uid);
    const types = (evs ?? []).map((e) => e.event_type);
    check("C3 a bundle_from_show_refused event was written", types.includes("bundle_from_show_refused"), types.join(","));
    check("C4 nothing was queued", !types.includes("document_queued"), types.join(","));
  } finally {
    if (uid) {
      // anything the test user queued if the guard had failed: queue rows + their jobs
      const { data: queued } = await admin.from("events").select("entity_id,payload").eq("actor_id", uid).eq("event_type", "document_queued");
      for (const q of (queued ?? []) as { entity_id: string; payload: { job_id?: string } }[]) {
        await admin.from("pending_documents").delete().eq("id", q.entity_id);
        if (q.payload?.job_id) await admin.from("jobs").delete().eq("id", q.payload.job_id);
        console.log(`cleanup: removed leaked queue row ${q.entity_id}`);
      }
      await admin.from("events").delete().eq("actor_id", uid);
      const del = await fetch(`${SUP}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: adminH });
      const get = await fetch(`${SUP}/auth/v1/admin/users/${uid}`, { headers: adminH });
      const { count } = await admin.from("events").select("id", { count: "exact", head: true }).eq("actor_id", uid);
      check("Z cleanup: user DELETE 200, GET 404, 0 events", del.status === 200 && get.status === 404 && count === 0, `${del.status}/${get.status}/${count}`);
    }
  }

  console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
