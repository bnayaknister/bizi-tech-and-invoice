import { matchTitleToShow, type ShowForMatch } from "./match";
import type { CalendarEvent } from "./parse";

export type ExistingProductionRow = {
  id: string;
  calendar_uid: string;
  status: string;
  calendar_removed: boolean;
};

export type CreateAction = { event: CalendarEvent; show: ShowForMatch };
export type UpdateAction = { productionId: string; event: CalendarEvent };

export type SyncPlan = {
  toCreate: CreateAction[];
  toUpdate: UpdateAction[]; // untouched, calendar owns the fields — apply
  toFlagChanged: { productionId: string }[]; // touched — never overwrite, just flag
  toFlagRemoved: string[]; // production ids whose calendar_uid vanished from the feed
  toUnflagRemoved: string[]; // previously flagged removed, event is back
  skippedNoMatch: number; // titles matching no alias — silently absent from the system
};

// Pure — no DB access, so the exact same code path runs against a real
// fetched feed or a fake test ICS (screens-spec §11 owner rule: "permit,
// not block" + the 4-case conflict resolution).
//
// `touchedIds` is precomputed by the caller: any production with a
// non-calendar-prefixed event already logged against it (drawer edit, kanban
// move, hold, stage update) — "מה שהיומן יצר, היומן מעדכן, כל עוד לא נגעו בו".
export function buildSyncPlan(
  events: CalendarEvent[],
  shows: ShowForMatch[],
  existingByUid: Map<string, ExistingProductionRow>,
  touchedIds: Set<string>
): SyncPlan {
  const plan: SyncPlan = {
    toCreate: [],
    toUpdate: [],
    toFlagChanged: [],
    toFlagRemoved: [],
    toUnflagRemoved: [],
    skippedNoMatch: 0,
  };
  const seenUids = new Set<string>();

  for (const event of events) {
    const match = matchTitleToShow(event.title, shows);
    if (!match) {
      // the studio's calendar is shared with the other company's ad
      // recordings — an unmatched title is presumed to be theirs, and the
      // system never invents a show or raises a flag for it
      plan.skippedNoMatch++;
      continue;
    }
    seenUids.add(event.uid);

    const existing = existingByUid.get(event.uid);
    if (!existing) {
      plan.toCreate.push({ event, show: match.show });
      continue;
    }

    if (existing.calendar_removed) plan.toUnflagRemoved.push(existing.id);

    // untouched + still at the very first stage of the pipeline → the
    // calendar owns these fields, safe to sync in place. Anything else
    // (worked on, or in a status a plain calendar edit shouldn't move)
    // never gets silently overwritten.
    if (!touchedIds.has(existing.id) && existing.status === "עתיד_להתחיל") {
      plan.toUpdate.push({ productionId: existing.id, event });
    } else {
      plan.toFlagChanged.push({ productionId: existing.id });
    }
  }

  for (const [uid, row] of Array.from(existingByUid.entries())) {
    if (!seenUids.has(uid) && !row.calendar_removed) {
      plan.toFlagRemoved.push(row.id);
    }
  }

  return plan;
}
