import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { DOC_TYPE_LABEL } from "@/lib/documents/forProduction";
import type { ArchiveFacts, ArchiveJob, ArchiveTarget } from "./archiveEligibility";
import { PERF_OFF, type PerfTimer } from "@/lib/perf/timing";

// ═══════════════════════════════════════════════════════════════════════════
// Q10 — load the facts archiveEligibility needs, for a set of productions.
// ═══════════════════════════════════════════════════════════════════════════
//
// SERVICE ROLE, and only ever called for a studio_admin (the page and the
// route both gate first): it reads jobs and documents, which are money.
//
// The two folded shapes (see archiveEligibility):
//   · bundle        — a document / queue row whose bundle_job_ids contains the
//                     job (0044). Its jobs are bundle_job_ids.
//   · consolidated  — the production's queue row carries consolidated_into
//                     (0047, bundle.ts:562). The target's jobs are the jobs of
//                     every row folded into it, plus its own bundle_job_ids.
// A cancelled document, and a queue row that is cancelled / rejected / failed,
// is not a target: it is not where the money is.
//
// READ-ONLY. It reads only columns that existed before 0112, so it runs on the
// typed client.

const DEAD_QUEUE = new Set(["cancelled", "rejected", "failed"]);
const CHUNK = 100;

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

async function inChunks<R>(ids: string[], run: (part: string[]) => PromiseLike<{ data: R[] | null; error: unknown }>): Promise<R[]> {
  const out: R[] = [];
  for (const part of chunks(Array.from(new Set(ids)))) {
    if (part.length === 0) continue;
    const { data, error } = await run(part);
    if (error) throw error;
    out.push(...(data ?? []));
  }
  return out;
}

type JobRow = { id: string; paid: string | null; invoice_biz: string | null; invoice_tax: string | null; dismissed: boolean | null };

export async function loadArchiveFacts(
  admin: SupabaseClient<Database>,
  productionIds: string[],
  /** T37: one lap per sequential wave below (af_1 … af_5) when timing is on */
  perf: PerfTimer = PERF_OFF
): Promise<Map<string, ArchiveFacts>> {
  const out = new Map<string, ArchiveFacts>();
  if (productionIds.length === 0) return out;

  const prods = await inChunks(productionIds, (part) =>
    admin.from("productions").select("id,status,kind,show_id").in("id", part)
  );
  perf.lap("af_1_productions");
  const showIds = prods.map((p) => p.show_id).filter((x): x is string => !!x);
  const [shows, links, queueRows] = await Promise.all([
    inChunks(showIds, (part) => admin.from("shows").select("id,client_id,billing_mode").in("id", part)),
    inChunks(productionIds, (part) => admin.from("job_productions").select("production_id,job_id").in("production_id", part)),
    inChunks(productionIds, (part) =>
      admin.from("pending_documents").select("id,production_id,consolidated_into,status").in("production_id", part)
    ),
  ]);

  perf.lap("af_2_shows_links_queue");
  const jobIdsOf = new Map<string, string[]>();
  for (const l of links) jobIdsOf.set(l.production_id, [...(jobIdsOf.get(l.production_id) ?? []), l.job_id]);
  const ownJobIds = links.map((l) => l.job_id);

  // ── consolidated targets: production -> target queue row ────────────────
  const consolidatedOf = new Map<string, Set<string>>(); // production -> target ids
  for (const q of queueRows) {
    if (!q.production_id || !q.consolidated_into) continue;
    const s = consolidatedOf.get(q.production_id) ?? new Set<string>();
    s.add(q.consolidated_into);
    consolidatedOf.set(q.production_id, s);
  }
  const targetIds = Array.from(new Set(Array.from(consolidatedOf.values()).flatMap((s) => Array.from(s))));
  const [targetRows, children, docBundles, queueBundles] = await Promise.all([
    inChunks(targetIds, (part) =>
      admin.from("pending_documents").select("id,status,doc_type,morning_doc_number,bundle_job_ids").in("id", part)
    ),
    inChunks(targetIds, (part) =>
      admin.from("pending_documents").select("consolidated_into,production_id,job_id").in("consolidated_into", part)
    ),
    inChunks(ownJobIds, (part) =>
      admin.from("documents").select("id,type,morning_doc_number,bundle_job_ids,cancelled_at").overlaps("bundle_job_ids", part)
    ),
    inChunks(ownJobIds, (part) =>
      admin.from("pending_documents").select("id,status,doc_type,morning_doc_number,bundle_job_ids").overlaps("bundle_job_ids", part)
    ),
  ]);

  perf.lap("af_3_targets_bundles");
  // sibling productions folded into the same target contribute their jobs
  const siblingProds = children.map((c) => c.production_id).filter((x): x is string => !!x && !jobIdsOf.has(x));
  const siblingLinks = await inChunks(siblingProds, (part) =>
    admin.from("job_productions").select("production_id,job_id").in("production_id", part)
  );
  for (const l of siblingLinks) jobIdsOf.set(l.production_id, [...(jobIdsOf.get(l.production_id) ?? []), l.job_id]);

  perf.lap("af_4_sibling_links");
  const targetJobIds = new Map<string, Set<string>>();
  const liveTargets = new Map(targetRows.filter((t) => !DEAD_QUEUE.has(t.status)).map((t) => [t.id, t]));
  for (const t of Array.from(liveTargets.values())) targetJobIds.set(t.id, new Set(t.bundle_job_ids ?? []));
  for (const c of children) {
    if (!c.consolidated_into || !liveTargets.has(c.consolidated_into)) continue;
    const s = targetJobIds.get(c.consolidated_into)!;
    if (c.job_id) s.add(c.job_id);
    if (c.production_id) for (const j of jobIdsOf.get(c.production_id) ?? []) s.add(j);
  }

  const bundles = [
    ...docBundles
      .filter((d) => !d.cancelled_at)
      .map((d) => ({ label: `${DOC_TYPE_LABEL[d.type] ?? "מסמך"} ${d.morning_doc_number ?? ""}`.trim(), jobs: d.bundle_job_ids ?? [] })),
    ...queueBundles
      .filter((q) => !DEAD_QUEUE.has(q.status))
      .map((q) => ({ label: `מסמך מאוחד בתור${q.morning_doc_number ? ` ${q.morning_doc_number}` : ""}`, jobs: q.bundle_job_ids ?? [] })),
  ].filter((b) => b.jobs.length > 1); // a one-job "bundle" is the job itself

  const allJobIds = new Set<string>(ownJobIds);
  for (const s of Array.from(targetJobIds.values())) for (const j of Array.from(s)) allJobIds.add(j);
  for (const b of bundles) for (const j of b.jobs) allJobIds.add(j);
  const jobRows = await inChunks(Array.from(allJobIds), (part) =>
    admin.from("jobs").select("id,paid,invoice_biz,invoice_tax,dismissed").in("id", part)
  );
  perf.lap("af_5_jobs");
  const jobById = new Map<string, ArchiveJob>((jobRows as JobRow[]).map((j) => [j.id, j]));
  const jobsFor = (ids: Iterable<string>) => Array.from(ids).map((id) => jobById.get(id)).filter((j): j is ArchiveJob => !!j);

  const showById = new Map(shows.map((s) => [s.id, s]));
  for (const p of prods) {
    const own = jobsFor(jobIdsOf.get(p.id) ?? []);
    const targets: Record<string, ArchiveTarget[]> = {};
    for (const job of own) {
      const list: ArchiveTarget[] = [];
      for (const b of bundles) if (b.jobs.includes(job.id)) list.push({ kind: "bundle", label: b.label, jobs: jobsFor(b.jobs) });
      for (const tid of Array.from(consolidatedOf.get(p.id) ?? [])) {
        const t = liveTargets.get(tid);
        if (!t) continue;
        const label = `${t.doc_type === "work_order" ? "הזמנת עבודה מאוחדת" : "מסמך מאוחד"}${t.morning_doc_number ? ` ${t.morning_doc_number}` : ""}`;
        list.push({ kind: "consolidated", label, jobs: jobsFor(targetJobIds.get(tid) ?? []) });
      }
      if (list.length) targets[job.id] = list;
    }
    const show = p.show_id ? showById.get(p.show_id) : undefined;
    out.set(p.id, {
      status: p.status,
      kind: p.kind,
      show: show ? { client_id: show.client_id, billing_mode: show.billing_mode } : null,
      jobs: own,
      targets,
    });
  }
  return out;
}
