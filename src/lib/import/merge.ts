// Bidirectional CSV import — pure merge logic (no DB access here).
// The API route feeds this the parsed CSV rows + the current DB rows and
// gets back a plan: which rows are new / updated / unchanged / in-archive,
// and for updates, exactly which fields changed. Managed fields (status,
// links, legacy, …) are never in the importable set, so they can't be
// overwritten. Import never deletes: a DB row absent from the CSV is simply
// not mentioned in the plan.

export type ImportKind = "production" | "job";

export type ParsedCsv = { headers: string[]; rows: Record<string, string>[] };

// minimal RFC-4180-ish parser (handles quotes, commas, CRLF, BOM)
export function parseCsv(text: string): ParsedCsv {
  const clean = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); field = ""; row = []; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].every((v) => v.trim() === "")) continue; // skip blank lines
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = (rows[r][i] ?? "").trim()));
    out.push(obj);
  }
  return { headers, rows: out };
}

const PROD_MARKERS = ["שם הפודקאסט", "תאריך הקלטה"];
const JOB_MARKERS = ["לקוח", "קמפיין", "מחיר"];

export function detectKind(headers: string[]): ImportKind | null {
  const has = (m: string[]) => m.every((x) => headers.includes(x));
  if (has(PROD_MARKERS)) return "production";
  if (has(JOB_MARKERS)) return "job";
  return null;
}

// ---- helpers ----
export function norm(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}
export function parseDate(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  if (!t || ["---", "-", "—"].includes(t)) return null;
  const m = t.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (!m) return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
  const [, d, mo] = m;
  let y = m[3];
  if (y.length === 2) y = "20" + y;
  return `${y.padStart(4, "0")}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}
export function parseInt0(s: string | null | undefined): number | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// ---- field mapping: CSV column -> DB column, importable fields only ----
// Managed DB columns (status, kind, show_id, on_hold*, legacy, external_id,
// job_productions, due_date, contract_id, …) are deliberately absent.
export type FieldMap = { csv: string; db: string; kind: "text" | "date" | "int" | "num" };

export const FIELD_MAPS: Record<ImportKind, FieldMap[]> = {
  production: [
    { csv: "שם הפודקאסט", db: "podcast_name", kind: "text" },
    { csv: "תאריך הקלטה", db: "record_date", kind: "date" },
    { csv: "שם אורחים", db: "guest", kind: "text" },
    { csv: "אולפן", db: "studio", kind: "text" },
    { csv: "פרק מספר", db: "episode_no", kind: "int" },
    { csv: "הערות לפרק", db: "notes", kind: "text" },
  ],
  job: [
    { csv: "תאריך", db: "date", kind: "date" },
    { csv: "קמפיין", db: "campaign", kind: "text" },
    { csv: "מחיר", db: "amount", kind: "num" },
    { csv: "חשבונית עסקה", db: "invoice_biz", kind: "text" },
    { csv: "חשבונית מס", db: "invoice_tax", kind: "text" },
    { csv: "הערות", db: "notes", kind: "text" },
  ],
};

function coerce(map: FieldMap, raw: string): string | number | null {
  if (map.kind === "date") return parseDate(raw);
  if (map.kind === "int") return parseInt0(raw);
  if (map.kind === "num") {
    const t = (raw ?? "").replace(/[,₪\s]/g, "").trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  const t = (raw ?? "").trim();
  return t === "" ? null : t;
}

// value from a DB row normalised the same way, for change detection
function dbValue(map: FieldMap, v: unknown): string | number | null {
  if (v == null) return null;
  if (map.kind === "int") return typeof v === "number" ? v : parseInt0(String(v));
  if (map.kind === "num") return typeof v === "number" ? v : Number(v);
  return String(v);
}

export type FieldChange = {
  field: string;
  label: string;
  from: unknown;
  to: unknown;
  // true when `from` (DB) is free text that fully contains `to` (CSV) as a
  // substring plus more — the CSV is a partial/stale version of what the
  // system already knows (e.g. a manual note enriched after seeding).
  // Applying the update would DESTROY that extra information, so this is
  // never bundled into a bulk "approve all" — the owner confirms it alone.
  infoLoss?: boolean;
};
export type RowPlan = {
  externalId: string | null;
  title: string;
  bucket: "new" | "update" | "unchanged" | "archive";
  matchedId: string | null; // DB id when update/unchanged
  changes: FieldChange[];
  values: Record<string, string | number | null>; // importable values (for apply)
  hasInfoLoss: boolean;
  // only meaningful for bucket === "new": this row is already closed
  // (paid + tax invoice already issued — spec §7's exact archiving rule,
  // the one that already classified 106+1 historical jobs) so it must be
  // created directly in archive, never as a live row. A brand-new row has
  // no app-tracked payment state to protect, so reading paid/invoice_tax
  // straight from the CSV here is correct — unlike an update to an
  // existing row, where the app's own workflow may have moved further.
  archiveDestined?: boolean;
};

// CSV is a strict, non-identical substring of what's already in the DB —
// the field would lose information if this update were applied blindly.
// Scoped to text fields; dates/numbers don't have meaningful "substring"
// semantics for this kind of partial-data detection.
function isInfoLoss(mapKind: FieldMap["kind"], from: unknown, to: unknown): boolean {
  if (mapKind !== "text") return false;
  if (typeof from !== "string" || typeof to !== "string") return false;
  if (from.length === 0 || from === to) return false;
  return from.includes(to);
}

export type ImportPlan = {
  kind: ImportKind;
  rows: RowPlan[];
  counts: { new: number; update: number; unchanged: number; archive: number };
};

const ID_COL = "ID";

export function fingerprintCsv(kind: ImportKind, r: Record<string, string>): string {
  if (kind === "production")
    return [norm(r["שם הפודקאסט"]), parseDate(r["תאריך הקלטה"]), norm(r["שם אורחים"]), norm(r["אולפן"])].join("|");
  return [norm(r["לקוח"]), norm(r["קמפיין"]), parseDate(r["תאריך"]), parseInt0(r["מחיר"]) ?? ""].join("|");
}

// The DB fingerprint is built by the API route (it knows client names); it
// passes a `fingerprint` string on each dbRow so this stays pure.
export type DbRow = { id: string; external_id: string | null; fingerprint: string; title: string } & Record<string, unknown>;

export function buildPlan(
  kind: ImportKind,
  csvRows: Record<string, string>[],
  dbRows: DbRow[],
  archiveIds: Set<string>
): ImportPlan {
  const byExt = new Map<string, DbRow>();
  const byFp = new Map<string, DbRow[]>();
  for (const d of dbRows) {
    if (d.external_id) byExt.set(d.external_id, d);
    const arr = byFp.get(d.fingerprint) ?? [];
    arr.push(d);
    byFp.set(d.fingerprint, arr);
  }
  const usedFp = new Map<string, number>();
  const maps = FIELD_MAPS[kind];
  const plan: RowPlan[] = [];

  for (const r of csvRows) {
    const externalId = (r[ID_COL] || "").trim() || null;
    const values: Record<string, string | number | null> = {};
    for (const m of maps) values[m.db] = coerce(m, r[m.csv]);
    const title = kind === "production" ? r["שם הפודקאסט"] || "—" : `${r["לקוח"] || ""} · ${r["קמפיין"] || "—"}`;

    // 1) match by external_id, 2) fingerprint (next unused in group), 3) new
    let match: DbRow | null = externalId ? byExt.get(externalId) ?? null : null;
    if (!match) {
      const fp = fingerprintCsv(kind, r);
      const group = byFp.get(fp) ?? [];
      const idx = usedFp.get(fp) ?? 0;
      if (idx < group.length) { match = group[idx]; usedFp.set(fp, idx + 1); }
    }

    // archive rule: if the id lives in archive, never touch — flag for decision
    if (externalId && archiveIds.has(externalId) && !match) {
      plan.push({ externalId, title, bucket: "archive", matchedId: null, changes: [], values, hasInfoLoss: false });
      continue;
    }

    if (!match) {
      const archiveDestined =
        kind === "job" && (r["שולם"] || "").trim() === "כן" && (r["חשבונית מס"] || "").trim() !== "";
      plan.push({ externalId, title, bucket: "new", matchedId: null, changes: [], values, hasInfoLoss: false, archiveDestined });
      continue;
    }

    const changes: FieldChange[] = [];
    for (const m of maps) {
      const to = values[m.db];
      const from = dbValue(m, (match as Record<string, unknown>)[m.db]);
      const same = (from ?? null) === (to ?? null);
      if (!same) {
        changes.push({
          field: m.db,
          label: m.csv,
          from: from ?? null,
          to: to ?? null,
          infoLoss: isInfoLoss(m.kind, from ?? null, to ?? null),
        });
      }
    }
    plan.push({
      externalId: externalId ?? match.external_id,
      title,
      bucket: changes.length ? "update" : "unchanged",
      matchedId: match.id,
      changes,
      values,
      hasInfoLoss: changes.some((c) => c.infoLoss),
    });
  }

  const counts = { new: 0, update: 0, unchanged: 0, archive: 0 };
  for (const p of plan) counts[p.bucket]++;
  return { kind, rows: plan, counts };
}
