import type { SupabaseClient } from "@supabase/supabase-js";
import { norm, type DbRow, type ImportKind } from "./merge";

// Load current DB rows for an import kind, each pre-tagged with the exact
// fingerprint string buildPlan expects (see fingerprintCsv in merge.ts).
export async function loadDbRows(admin: SupabaseClient, kind: ImportKind): Promise<DbRow[]> {
  if (kind === "production") {
    const { data, error } = await admin
      .from("productions")
      .select("id,external_id,podcast_name,record_date,guest,studio,episode_no,notes")
      .limit(5000);
    if (error) throw error;
    return (data ?? []).map((p) => ({
      ...p,
      fingerprint: [norm(p.podcast_name), p.record_date ?? null, norm(p.guest), norm(p.studio)].join("|"),
      title: p.podcast_name ?? "—",
    }));
  }
  const [{ data: jobs, error }, { data: clients }] = await Promise.all([
    admin.from("jobs").select("id,external_id,client_id,campaign,date,amount,invoice_biz,invoice_tax,notes").limit(5000),
    admin.from("clients").select("id,name"),
  ]);
  if (error) throw error;
  const clientName = new Map((clients ?? []).map((c) => [c.id, c.name as string]));
  return (jobs ?? []).map((j) => {
    const cname = j.client_id ? clientName.get(j.client_id) ?? "" : "";
    const amt = j.amount == null ? "" : String(Math.trunc(Number(j.amount)));
    return {
      ...j,
      fingerprint: [norm(cname), norm(j.campaign), j.date ?? null, amt].join("|"),
      title: `${cname} · ${j.campaign ?? "—"}`,
    };
  });
}

export async function archiveIdSet(
  admin: SupabaseClient,
  kind: ImportKind,
  externalIds: string[]
): Promise<Set<string>> {
  if (externalIds.length === 0) return new Set();
  const { data, error } = await admin.rpc("import_archive_ids", { p_kind: kind, p_ids: externalIds });
  if (error) throw error;
  return new Set((data ?? []).map((r: { external_id: string }) => r.external_id));
}

// next synthetic external_id (P#### / C####) for a brand-new row that arrived
// without one — keeps the key space consistent with the CSV's own scheme
export function nextExternalId(kind: ImportKind, existing: (string | null)[]): (n: number) => string {
  const prefix = kind === "production" ? "P" : "C";
  let max = 0;
  for (const e of existing) {
    if (e && e[0] === prefix) {
      const n = parseInt(e.slice(1), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return (offset: number) => `${prefix}${String(max + offset).padStart(4, "0")}`;
}
