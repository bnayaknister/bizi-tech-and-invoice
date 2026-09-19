/**
 * F10 — the three things that must hold after 0094 and the code round.
 *
 * Run:  npx tsx scripts/verify_morning_id_map.ts
 *
 * 1. TIE-BREAK PARITY. The old map (clients only, name order, first wins) and
 *    the new one must agree on every id the old one knew — `2b73787f` above
 *    all, the only Morning id two of our clients claim (גל אורן / גל אורן
 *    לרנר). A silent change there moves documents between them, and that is
 *    exactly F16. The only permitted difference is ADDED ids.
 *
 * 2. THE COLUMN ⟷ PRIMARY INVARIANT, both directions. `enqueue.ts` still reads
 *    `clients.morning_client_id`, and that is safe only while the sync trigger
 *    keeps it equal to the `is_primary` row. This is what catches the trigger
 *    ever being dropped.
 *
 * 3. THE ENGINE'S `certain` SET IS STILL EMPTY. Widening the `mid:` keys
 *    changes which edges exist, and `autoReconcile` links `certain` with no
 *    human in the loop. This is the assertion that matters most going forward:
 *    it runs the REAL engine, and if a pair ever appears it names it instead
 *    of letting the next pull link it quietly.
 *
 * 4. THE UNMAPPING TRAP, live. A client whose mapping is removed must stop
 *    being issuable EVEN THOUGH a historical alias still resolves to it. The
 *    test creates a throwaway client, maps it, gives it an alias, unmaps it,
 *    and asserts the two sides diverge exactly as designed.
 *    ⚠️ Every row it creates is deleted in `finally`, and the deletion is
 *    verified before the script reports success.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadMorningIdMap, loadMorningIdsByClient } from "../src/lib/clients/morningIds";
import { computeReconciliation } from "../src/lib/documents/reconcile";

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

const SHARED = "2b73787f-b09e-48dc-810e-3aacb0b5a394"; // גל אורן / גל אורן לרנר
const fails: string[] = [];
const ok = (s: string) => console.log("  ✅ " + s);
const bad = (s: string) => { fails.push(s); console.log("  ❌ " + s); };

/** The map EXACTLY as registry.ts and backfill.ts built it before 0094. */
async function legacyMap(): Promise<Map<string, string>> {
  const { data } = await admin
    .from("clients")
    .select("id,morning_client_id")
    .not("morning_client_id", "is", null)
    .is("merged_into", null)
    .order("name");
  const m = new Map<string, string>();
  for (const c of (data ?? []) as { id: string; morning_client_id: string }[]) {
    if (!m.has(c.morning_client_id)) m.set(c.morning_client_id, c.id);
  }
  return m;
}

async function main() {
  const names = new Map(
    (((await admin.from("clients").select("id,name")).data ?? []) as { id: string; name: string }[])
      .map((c) => [c.id, c.name])
  );

  // ── 1. tie-break parity ───────────────────────────────────────────────────
  console.log("\n1. TIE-BREAK PARITY (old map vs new)");
  const before = await legacyMap();
  const after = await loadMorningIdMap(admin);

  const changed: string[] = [];
  for (const [mid, cid] of Array.from(before.entries())) {
    const now = after.get(mid);
    if (now !== cid) changed.push(`${mid}: ${names.get(cid) ?? cid} → ${now ? names.get(now) ?? now : "(נעלם)"}`);
  }
  if (changed.length) changed.forEach((c) => bad("שויך מחדש: " + c));
  else ok(`${before.size} מזהים שהמפה הישנה הכירה — כולם מצביעים על אותו לקוח בדיוק`);

  const added = Array.from(after.keys()).filter((k) => !before.has(k));
  ok(`נוספו ${added.length} מזהים: ${added.join(", ") || "—"}`);

  // the shared id, by name, because it is the one that can move money
  if (before.get(SHARED) !== after.get(SHARED)) {
    bad(`2b73787f זז! ${names.get(before.get(SHARED) ?? "")} → ${names.get(after.get(SHARED) ?? "")}`);
  } else {
    ok(`2b73787f → ${names.get(after.get(SHARED) ?? "") ?? "?"} — זהה לפני ואחרי (F16)`);
  }

  // ── 2. column ⟷ primary, both directions ──────────────────────────────────
  console.log("\n2. clients.morning_client_id ⟷ is_primary");
  const { data: mapped } = await admin
    .from("clients").select("id,morning_client_id").not("morning_client_id", "is", null).is("merged_into", null);
  const { data: primaries } = await admin
    .from("client_morning_ids").select("client_id,morning_client_id").eq("is_primary", true);

  const primaryOf = new Map(
    ((primaries ?? []) as { client_id: string; morning_client_id: string }[]).map((r) => [r.client_id, r.morning_client_id])
  );
  const cols = (mapped ?? []) as { id: string; morning_client_id: string }[];

  const missing = cols.filter((c) => primaryOf.get(c.id) !== c.morning_client_id);
  if (missing.length) missing.forEach((c) => bad(`לעמודה של ${names.get(c.id)} אין שורת is_primary תואמת`));
  else ok(`${cols.length} לקוחות ממופים — לכל אחד שורת is_primary זהה לעמודה`);

  const orphanPrimaries = Array.from(primaryOf.entries()).filter(
    ([cid, mid]) => !cols.some((c) => c.id === cid && c.morning_client_id === mid)
  );
  if (orphanPrimaries.length) orphanPrimaries.forEach(([cid]) => bad(`שורת is_primary ללא עמודה תואמת: ${names.get(cid) ?? cid}`));
  else ok(`${primaryOf.size} שורות is_primary — לכל אחת עמודה תואמת (אין ראשי יתום)`);

  // ── 3. the engine, for real ───────────────────────────────────────────────
  console.log("\n3. המנוע האמיתי — certain חייב להישאר ריק");
  const recon = await computeReconciliation(admin);
  if (recon.certain.length !== 0) {
    bad(`certain = ${recon.certain.length} — האוטו-לינק יקשר אותם במשיכה הבאה בלי אדם!`);
    for (const p of recon.certain) {
      bad(`  #${p.doc.morning_doc_number} (${p.doc.morning_client_name}) → job ${p.job.id.slice(0, 8)} · ${p.job.campaign ?? "—"}`);
    }
  } else {
    ok("certain = 0 — אין מה לקשר אוטומטית");
  }
  console.log(
    `     gap1=${recon.gap1.length} gap2=${recon.gap2.length} gap3=${recon.gap3.length} ` +
    `unmatched=${recon.unmatchedDocCount} red=${recon.counts.redJobs} ` +
    `purple=${recon.counts.purpleJobs} unlinkedTax=${recon.counts.unlinkedTaxDocs}`
  );

  // ── 4. the unmapping trap, live ───────────────────────────────────────────
  console.log("\n4. ביטול מיפוי עוצר הנפקה, בעוד אליאס היסטורי עדיין פותר");
  let tmp: string | null = null;
  try {
    const { data: created, error } = await admin
      .from("clients")
      .insert({ name: "ZZ-F10-trap", normalized_name: "zz-f10-trap", morning_client_id: "zz-trap-primary" })
      .select("id").single();
    if (error) throw new Error("יצירת לקוח הבדיקה נכשלה: " + error.message);
    tmp = (created as { id: string }).id;

    await admin.from("client_morning_ids").insert({
      client_id: tmp, morning_client_id: "zz-trap-alias", is_primary: false, note: "בדיקה",
    });

    // unmap — the column goes null, and this is what enqueue.ts reads
    await admin.from("clients").update({ morning_client_id: null }).eq("id", tmp);

    const { data: after2 } = await admin.from("clients").select("morning_client_id").eq("id", tmp).single();
    const col = (after2 as { morning_client_id: string | null }).morning_client_id;
    if (col !== null) bad("העמודה לא התאפסה — enqueue עדיין יראה את הלקוח כממופה");
    else ok("clients.morning_client_id = null → enqueue יסרב ('לא ממופה למורנינג')");

    const rows = await loadMorningIdsByClient(admin);
    const stillOwned = rows.get(tmp) ?? [];
    if (!stillOwned.includes("zz-trap-alias")) bad("האליאס נעלם — מסמכים ישנים היו הופכים ליתומים");
    else ok(`האליאס שרד (${stillOwned.length} מזהים) — מסמכים ישנים עדיין נפתרים`);

    const { count } = await admin
      .from("client_morning_ids").select("*", { count: "exact", head: true })
      .eq("client_id", tmp).eq("is_primary", true);
    if ((count ?? 0) !== 0) bad(`נשארו ${count} שורות is_primary — ההנפקה תיפתח מחדש דרך אליאס`);
    else ok("אפס שורות is_primary → אין דרך שאליאס יחזיר את הלקוח להיות בר-הנפקה");
  } finally {
    // ⚠️ מנקים תמיד, ומאמתים את הניקוי. client_morning_ids יורד ב-cascade.
    if (tmp) {
      await admin.from("clients").delete().eq("id", tmp);
      const { count: left } = await admin
        .from("clients").select("*", { count: "exact", head: true }).eq("id", tmp);
      const { count: leftRows } = await admin
        .from("client_morning_ids").select("*", { count: "exact", head: true }).eq("client_id", tmp);
      if ((left ?? 0) !== 0 || (leftRows ?? 0) !== 0) {
        bad(`ניקוי נכשל! נותרו ${left} לקוחות ו-${leftRows} שורות מיפוי — למחוק ידנית: ${tmp}`);
      } else {
        ok("ניקוי: לקוח הבדיקה ושורותיו נמחקו, ואומת");
      }
    }
  }

  console.log(
    fails.length ? `\n❌ ${fails.length} כשלים:\n` + fails.map((f) => "   - " + f).join("\n")
                 : "\n✅ הכל עבר — המפה זהה היכן שהיתה, רחבה יותר רק היכן שהוכרע, והמלכודת סגורה."
  );
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
