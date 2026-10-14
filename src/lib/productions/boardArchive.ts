import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { archiveEligibility, BOARD_ARCHIVE_STATUS, type ArchiveEligibility } from "./archiveEligibility";
import { PERF_OFF, type PerfTimer } from "@/lib/perf/timing";
import { loadArchiveFacts } from "./archiveFacts";

// ═══════════════════════════════════════════════════════════════════════════
// Q10 — archive / restore on the board. Server only, studio_admin only.
// ═══════════════════════════════════════════════════════════════════════════
//
// The CALLER has already proven the actor is studio_admin (route.ts). Both
// writes go through the service role because 0112's trigger refuses any
// session write to the two columns — the route is the only door.
//
// ═══ RE-CHECKED AT THE MOMENT OF EXECUTION (owner decision 6) ═══
// What the board showed as eligible is a hint. Eligibility is computed again
// here, from the database, and only what is eligible NOW is written. The
// UPDATE also re-states the two conditions it can (status = הופץ, not already
// archived), so a status change that lands between the read and the write
// cannot be archived over — and 0112's CHECK is the last wall behind that.
//
// Every archive and restore is an event with who and when (decision 8); a
// bulk run shares one batch_id so the batch can be read back as one act.
//
// TYPED CLIENT throughout: 0112 was applied on 2026-10-13 and
// database.types.ts regenerated against it, so a misspelt board_archived_*
// column fails the build instead of a 42703 at runtime.

export const BOARD_ARCHIVE_MAX = 500;

export type ArchiveOutcome = {
  archived: string[];
  skipped: { id: string; reason: string }[];
};

export type RestoreOutcome = { restored: string[]; skipped: { id: string; reason: string }[] };

function clean(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return Array.from(new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))).slice(0, BOARD_ARCHIVE_MAX);
}

export async function archiveOnBoard(
  admin: SupabaseClient<Database>,
  actorId: string,
  rawIds: unknown,
  opts: { bulk: boolean; now?: Date }
): Promise<ArchiveOutcome> {
  const ids = clean(rawIds);
  const out: ArchiveOutcome = { archived: [], skipped: [] };
  if (ids.length === 0) return out;

  const { data: current, error: readErr } = await admin
    .from("productions")
    .select("id,status,board_archived_at,board_archived_by")
    .in("id", ids);
  if (readErr) throw readErr;
  const rowById = new Map((current ?? []).map((r) => [r.id, r]));

  const facts = await loadArchiveFacts(admin, ids);
  const toWrite: string[] = [];
  for (const id of ids) {
    const row = rowById.get(id);
    const f = facts.get(id);
    if (!row || !f) {
      out.skipped.push({ id, reason: "ההפקה לא נמצאה." });
      continue;
    }
    if (row.board_archived_at) {
      out.skipped.push({ id, reason: "ההפקה כבר מאורכבת." });
      continue;
    }
    const e = archiveEligibility(f);
    if (!e.eligible) {
      out.skipped.push({ id, reason: e.reason });
      continue;
    }
    toWrite.push(id);
  }
  if (toWrite.length === 0) return out;

  const at = (opts.now ?? new Date()).toISOString();
  const { data: written, error: writeErr } = await admin
    .from("productions")
    .update({ board_archived_at: at, board_archived_by: actorId })
    .in("id", toWrite)
    .eq("status", BOARD_ARCHIVE_STATUS)
    .is("board_archived_at", null)
    .select("id");
  if (writeErr) throw writeErr;
  const done = new Set((written ?? []).map((r) => r.id));
  for (const id of toWrite) {
    if (done.has(id)) out.archived.push(id);
    else out.skipped.push({ id, reason: "ההפקה השתנתה בזמן הארכוב — רעננו את המסך." });
  }

  if (out.archived.length) {
    const batchId = randomUUID();
    const { error: evErr } = await admin.from("events").insert(
      out.archived.map((id) => ({
        entity_type: "production",
        entity_id: id,
        event_type: "production_board_archived",
        actor_id: actorId,
        payload: {
          at,
          bulk: opts.bulk,
          batch_id: batchId,
          batch_size: out.archived.length,
          skipped_in_batch: out.skipped.length,
        },
      }))
    );
    if (evErr) console.error("board-archive: רישום האירועים נכשל", evErr);
  }
  return out;
}

export async function restoreOnBoard(
  admin: SupabaseClient<Database>,
  actorId: string,
  rawIds: unknown
): Promise<RestoreOutcome> {
  const ids = clean(rawIds);
  const out: RestoreOutcome = { restored: [], skipped: [] };
  if (ids.length === 0) return out;

  const { data: current, error: readErr } = await admin
    .from("productions")
    .select("id,status,board_archived_at,board_archived_by")
    .in("id", ids);
  if (readErr) throw readErr;
  const rows = current ?? [];
  // a COPY of what the archive was, taken before the write — the event records it
  const archived = rows.filter((r) => r.board_archived_at).map((r) => ({ ...r }));
  const known = new Set(rows.map((r) => r.id));
  for (const id of ids) {
    if (!known.has(id)) out.skipped.push({ id, reason: "ההפקה לא נמצאה." });
    else if (!archived.some((r) => r.id === id)) out.skipped.push({ id, reason: "ההפקה אינה מאורכבת." });
  }
  if (archived.length === 0) return out;

  const { data: written, error: writeErr } = await admin
    .from("productions")
    .update({ board_archived_at: null, board_archived_by: null })
    .in("id", archived.map((r) => r.id))
    .not("board_archived_at", "is", null)
    .select("id");
  if (writeErr) throw writeErr;
  const done = new Set((written ?? []).map((r) => r.id));
  out.restored = archived.map((r) => r.id).filter((id) => done.has(id));

  if (out.restored.length) {
    const { error: evErr } = await admin.from("events").insert(
      archived
        .filter((r) => done.has(r.id))
        .map((r) => ({
          entity_type: "production",
          entity_id: r.id,
          event_type: "production_board_restored",
          actor_id: actorId,
          payload: { archived_at: r.board_archived_at, archived_by: r.board_archived_by },
        }))
    );
    if (evErr) console.error("board-archive: רישום אירוע השליפה נכשל", evErr);
  }
  return out;
}

// ─── the request, minus HTTP — so the permission gate is testable ──────────

export const BOARD_ARCHIVE_FORBIDDEN = "ארכוב בקנבן — לבניה ולאלי בלבד";

export type BoardArchiveRequest = {
  userId: string | null;
  profile: { approved: boolean | null; studio_admin: boolean | null } | null;
  body: unknown;
};

export async function handleBoardArchive(
  req: BoardArchiveRequest,
  deps: { admin: SupabaseClient<Database>; now?: Date }
): Promise<{ status: number; json: Record<string, unknown> }> {
  if (!req.userId) return { status: 401, json: { error: "לא מחובר" } };
  // owner decision 5: studio_admin only, on the server (isStudioAdmin's rule)
  if (!req.profile?.approved || !req.profile.studio_admin) {
    return { status: 403, json: { error: BOARD_ARCHIVE_FORBIDDEN } };
  }
  const body = (req.body ?? {}) as { action?: unknown; ids?: unknown };
  if (body.action === "archive" || body.action === "archive_bulk") {
    const r = await archiveOnBoard(deps.admin, req.userId, body.ids, {
      bulk: body.action === "archive_bulk",
      now: deps.now,
    });
    return { status: 200, json: r };
  }
  if (body.action === "restore") {
    const r = await restoreOnBoard(deps.admin, req.userId, body.ids);
    return { status: 200, json: r };
  }
  return { status: 400, json: { error: "פעולה לא מוכרת" } };
}

// ─── T37: the board's eligibility, off the kanban's critical path ──────────
//
// Measured 14.10 (T35): the kanban page spent 660–670ms in
// archive_eligibility AFTER its main wave — five sequential waves inside
// loadArchiveFacts, ~100–170ms each on the service-role hop. That is the
// whole of the page's tail for studio_admin. The page no longer computes it:
// the board renders at once and asks this, separately, when the kanban tab is
// on screen; the archive buttons appear when it answers.
//
// SAME RULE, SAME FACTS: archiveEligibility over loadArchiveFacts, for the
// same population the page used (status הופץ, not merged away). And the
// archive itself still re-checks at the moment of execution (archiveOnBoard).

export async function boardEligibility(
  admin: SupabaseClient<Database>,
  perf: PerfTimer = PERF_OFF
): Promise<Record<string, ArchiveEligibility>> {
  const { data, error } = await admin
    .from("productions")
    .select("id")
    .eq("status", BOARD_ARCHIVE_STATUS)
    .is("merged_into", null);
  if (error) throw error;
  perf.lap("hofatz_ids");
  const ids = (data ?? []).map((r) => r.id);
  const facts = await loadArchiveFacts(admin, ids, perf);
  const out: Record<string, ArchiveEligibility> = {};
  for (const [id, f] of Array.from(facts)) out[id] = archiveEligibility(f);
  perf.lap("eligibility");
  return out;
}

export async function handleBoardEligibility(
  req: Pick<BoardArchiveRequest, "userId" | "profile">,
  deps: { admin: SupabaseClient<Database>; perf?: PerfTimer }
): Promise<{ status: number; json: Record<string, unknown> }> {
  if (!req.userId) return { status: 401, json: { error: "לא מחובר" } };
  // studio_admin only, like the buttons it feeds — and it reads money (jobs,
  // documents), so nobody else's browser receives it
  if (!req.profile?.approved || !req.profile.studio_admin) {
    return { status: 403, json: { error: BOARD_ARCHIVE_FORBIDDEN } };
  }
  return { status: 200, json: { eligibility: await boardEligibility(deps.admin, deps.perf) } };
}
