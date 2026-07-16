import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseCsv, detectKind, buildPlan, norm, type ImportKind } from "@/lib/import/merge";
import { loadDbRows, archiveIdSet, nextExternalId } from "@/lib/import/server";

type Decision = "skip" | "restore" | "update";

export async function POST(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_import").eq("id", user.id).single();
  if (!profile?.can_import) return NextResponse.json({ error: "אין הרשאת ייבוא" }, { status: 403 });

  const { text, decisions = {} } = (await request.json()) as {
    text: string;
    decisions?: Record<string, Decision>;
  };
  const { headers, rows } = parseCsv(text ?? "");
  const kind = detectKind(headers);
  if (!kind) return NextResponse.json({ error: "קובץ לא מזוהה" }, { status: 400 });

  const admin = createAdminClient();
  const dbRows = await loadDbRows(admin, kind);
  const csvIds = rows.map((r) => (r["ID"] || "").trim()).filter(Boolean);
  const archive = await archiveIdSet(admin, kind, csvIds);
  const plan = buildPlan(kind, rows, dbRows, archive);

  // for new productions: match podcast name → show; for new jobs: client name → id
  const nameLookup = await buildNameLookup(admin, kind);
  const genId = nextExternalId(kind, dbRows.map((d) => d.external_id));
  let genCounter = 1;

  const applied = { created: 0, updated: 0, unchanged: 0, archiveSkipped: 0, skipped: 0 };
  const table = kind === "production" ? "productions" : "jobs";

  // plan.rows is in the same order as the parsed CSV rows (buildPlan iterates
  // them in order), so rows[i] is the raw source for plan.rows[i]
  for (let i = 0; i < plan.rows.length; i++) {
    const row = plan.rows[i];
    const raw = rows[i];
    if (row.bucket === "unchanged") { applied.unchanged++; continue; }

    if (row.bucket === "archive") {
      const decision = decisions[row.externalId ?? ""] ?? "skip";
      // ⚠️ never silently touch the archive — restore/update stay owner-driven
      // and, since archive is currently empty, arrive here only intentionally
      if (decision === "skip") { applied.archiveSkipped++; continue; }
      applied.skipped++; // restore/update not wired yet — treated as skip, reported
      continue;
    }

    if (row.bucket === "update" && row.matchedId) {
      const patch: Record<string, unknown> = {};
      for (const c of row.changes) patch[c.field] = c.to;
      if (Object.keys(patch).length === 0) { applied.unchanged++; continue; }
      const { error } = await admin.from(table).update(patch).eq("id", row.matchedId);
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      applied.updated++;
      continue;
    }

    if (row.bucket === "new") {
      const clientName = kind === "job" ? raw["לקוח"] ?? "" : "";
      const insert = buildInsert(kind, row.values, row.externalId ?? genId(genCounter++), nameLookup, clientName);
      if (insert === null) { applied.skipped++; continue; } // e.g. job with no matching client
      const { error } = await admin.from(table).insert(insert);
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      applied.created++;
    }
  }

  await admin.from("events").insert({
    entity_type: "import",
    entity_id: user.id,
    event_type: "csv_imported",
    actor_id: user.id,
    payload: { kind, filename_rows: rows.length, ...applied },
  });

  return NextResponse.json({ ok: true, kind, applied });
}

async function buildNameLookup(admin: ReturnType<typeof createAdminClient>, kind: ImportKind) {
  if (kind === "production") {
    const { data } = await admin.from("shows").select("id,name,aliases");
    const byName = new Map<string, string>();
    for (const s of data ?? []) {
      byName.set(norm(s.name), s.id);
      for (const a of (s.aliases as string[] | null) ?? []) byName.set(norm(a), s.id);
    }
    return byName;
  }
  const { data } = await admin.from("clients").select("id,name");
  const byName = new Map<string, string>();
  for (const c of data ?? []) byName.set(norm(c.name), c.id);
  return byName;
}

function buildInsert(
  kind: ImportKind,
  values: Record<string, string | number | null>,
  externalId: string,
  nameLookup: Map<string, string>,
  clientName: string
): Record<string, unknown> | null {
  if (kind === "production") {
    // new work from today — legacy=false, enters the automation chain.
    // 6 stages are created by trg_create_default_stages on insert.
    return {
      podcast_name: values.podcast_name,
      record_date: values.record_date,
      guest: values.guest,
      studio: values.studio,
      episode_no: values.episode_no,
      notes: values.notes,
      show_id: nameLookup.get(norm(String(values.podcast_name ?? ""))) ?? null,
      kind: "internal", // owner marks it 'client' when it should bill
      legacy: false,
      external_id: externalId,
    };
  }
  // job: needs a client. client_id is money-managed (not an importable field),
  // so for a brand-new job resolve it from the CSV's לקוח column by name.
  // Jobs whose client doesn't resolve are surfaced as skipped, never created
  // client-less.
  const clientId = nameLookup.get(norm(clientName));
  if (!clientId) return null;
  return {
    date: values.date,
    campaign: values.campaign,
    amount: values.amount,
    invoice_biz: values.invoice_biz,
    invoice_tax: values.invoice_tax,
    notes: values.notes,
    client_id: clientId,
    legacy: false,
    manual_only: false,
    external_id: externalId,
  };
}
