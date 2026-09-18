import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseCsv, detectKind, buildPlan, norm, type ImportKind } from "@/lib/import/merge";
import { loadDbRows, archiveIdSet, nextExternalId } from "@/lib/import/server";

type Decision = "skip" | "restore" | "update" | "confirm_overwrite";

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

  const applied = { created: 0, createdArchived: 0, updated: 0, unchanged: 0, archiveSkipped: 0, skipped: 0, infoLossSkipped: 0 };
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
      // 🟠 CSV is a stale/partial version of a free-text field the system
      // already knows more about — never bundled into bulk apply; the owner
      // must opt in per row (decisions[externalId] === "confirm_overwrite").
      if (row.hasInfoLoss && decisions[row.externalId ?? ""] !== "confirm_overwrite") {
        applied.infoLossSkipped++;
        continue;
      }
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
      const externalId = row.externalId ?? genId(genCounter++);

      // spec §7's exact archiving rule, applied at creation time: a new job
      // that arrives already paid + tax-invoiced never touches public.jobs —
      // it's closed history, same as its siblings (0015/0016 backfill).
      if (row.archiveDestined) {
        // job import: the lookup is the client map (see buildNameLookup)
        const clientId = (nameLookup as Map<string, string>).get(norm(clientName));
        if (!clientId) { applied.skipped++; continue; }
        const { error } = await admin.rpc("insert_archive_job", {
          p_job: {
            client_id: clientId,
            date: row.values.date,
            campaign: row.values.campaign,
            amount: row.values.amount,
            invoice_biz: row.values.invoice_biz,
            invoice_tax: row.values.invoice_tax,
            paid: (raw["שולם"] ?? "").trim(),
            notes: row.values.notes,
            external_id: externalId,
          },
        });
        if (error) return NextResponse.json({ error: error.message }, { status: 400 });
        applied.createdArchived++;
        continue;
      }

      const paidRaw = kind === "job" ? (raw["שולם"] ?? "").trim() : "";
      const insert = buildInsert(kind, row.values, externalId, nameLookup, clientName, paidRaw);
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

// P9 (2026-09-18): for a production import the lookup now carries the show's
// BILLING DECLARATION, not just its id. buildInsert needs billing_mode and
// client_id to derive `kind` the same way the calendar sync does — see the
// note there. The map is still keyed by normalised name/alias and still
// resolves to one show; only the value grew.
type ShowLookup = { id: string; billing_mode: string | null; client_id: string | null };

async function buildNameLookup(admin: ReturnType<typeof createAdminClient>, kind: ImportKind) {
  if (kind === "production") {
    const { data } = await admin.from("shows").select("id,name,aliases,billing_mode,client_id");
    const byName = new Map<string, ShowLookup>();
    for (const s of data ?? []) {
      const entry: ShowLookup = {
        id: s.id,
        billing_mode: (s.billing_mode as string | null) ?? null,
        client_id: (s.client_id as string | null) ?? null,
      };
      byName.set(norm(s.name), entry);
      for (const a of (s.aliases as string[] | null) ?? []) byName.set(norm(a), entry);
    }
    return byName;
  }
  const { data } = await admin.from("clients").select("id,name");
  const byName = new Map<string, string>();
  for (const c of data ?? []) byName.set(norm(c.name), c.id);
  return byName;
}

// maps the raw שולם CSV cell to the paid_status enum — same shape as the
// original seed.py mapping. A brand-new row has no app-tracked payment
// state yet, so the CSV is the only source of truth for it.
function mapPaid(raw: string): string {
  if (raw === "כן" || raw === "לא") return raw;
  if (raw.startsWith("ללא חיוב")) return "ללא חיוב";
  return "לא ידוע";
}

function buildInsert(
  kind: ImportKind,
  values: Record<string, string | number | null>,
  externalId: string,
  // production → ShowLookup (id + billing declaration); job → the client id.
  // buildNameLookup returns one or the other, keyed by `kind`.
  nameLookup: Map<string, ShowLookup> | Map<string, string>,
  clientName: string,
  paidRaw: string
): Record<string, unknown> | null {
  if (kind === "production") {
    const show = (nameLookup as Map<string, ShowLookup>).get(
      norm(String(values.podcast_name ?? ""))
    );
    // new work from today — legacy=false, enters the automation chain.
    // 6 stages are created by trg_create_default_stages on insert.
    return {
      podcast_name: values.podcast_name,
      record_date: values.record_date,
      guest: values.guest,
      studio: values.studio,
      episode_no: values.episode_no,
      notes: values.notes,
      show_id: show?.id ?? null,
      // P9 (owner decision 2026-09-18). Was a hard-coded `kind: "internal"`
      // with the note "owner marks it 'client' when it should bill" — the one
      // creation path in the app that ignored the show's billing declaration
      // entirely. The rule below is the SAME expression the calendar sync uses
      // (api/calendar/sync/route.ts:289); the two intake paths now agree.
      //
      // client_id rides along for the same reason the sync writes it
      // (sync/route.ts:296): ensure_job_for_production copies prod.client_id
      // onto the job it creates, so kind='client' without a client would mint
      // the first client-less job in the books. Measured 2026-09-18: 0 of 103
      // jobs carry a null client_id, and the column is nullable — nothing
      // would have raised.
      //
      // ⚠️ This does NOT make an import bill anything. A new row lands at the
      // column default 'עתיד_להתחיל', and 0061 refuses to create a job in that
      // status (it writes job_skipped_not_recorded instead). A job appears only
      // when a human advances the status, one row at a time.
      kind:
        show?.billing_mode === "contract"
          ? "contract"
          : show?.billing_mode === "per_episode" && show.client_id
            ? "client"
            : "internal",
      client_id: show?.client_id ?? null,
      legacy: false,
      external_id: externalId,
    };
  }
  // job: needs a client. client_id is money-managed (not an importable field),
  // so for a brand-new job resolve it from the CSV's לקוח column by name.
  // Jobs whose client doesn't resolve are surfaced as skipped, never created
  // client-less.
  const clientId = (nameLookup as Map<string, string>).get(norm(clientName));
  if (!clientId) return null;
  return {
    date: values.date,
    campaign: values.campaign,
    amount: values.amount,
    invoice_biz: values.invoice_biz,
    invoice_tax: values.invoice_tax,
    notes: values.notes,
    client_id: clientId,
    paid: mapPaid(paidRaw),
    legacy: false,
    manual_only: false,
    external_id: externalId,
  };
}
