// Renaming a show (owner 20.10). PURE — the route reads, this decides, the
// route writes. No server imports, so a pure suite can drive it directly.
//
// 🔴 THE OLD NAME BECOMES AN ALIAS. Calendar sync matches event titles against
// a show's name AND aliases (the same `normShowLabel` as /api/shows): a
// recording booked in the shared calendar under the old title must still land
// on this show after the rename. So the old name is appended to the aliases
// unless it is already there (under the same normalisation).
//
// And the duplicate rule is the one /api/shows applies to a new show: the new
// name may not equal any OTHER show's name or alias — a collision there is a
// recording sent to the wrong show.

/** Same normalisation the calendar-sync matcher and /api/shows use. Keep in lockstep. */
export function normShowLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’"׳״`.,:;!?()[\]/\\*+\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const SHOW_NAME_MAX = 120;

export type RenamePlan =
  | { ok: true; name: string; aliases: string[]; aliasAdded: string | null }
  | { ok: false; code: "empty" | "too-long" | "unchanged" | "duplicate"; error: string };

export function planShowRename(
  current: { id: string; name: string; aliases: string[] | null },
  rawName: unknown,
  others: { id: string; name: string; aliases: string[] | null }[]
): RenamePlan {
  const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ") : "";
  if (!name) return { ok: false, code: "empty", error: "שם התוכנית חובה" };
  if (Array.from(name).length > SHOW_NAME_MAX) {
    return { ok: false, code: "too-long", error: `שם התוכנית ארוך מדי (עד ${SHOW_NAME_MAX} תווים)` };
  }
  if (name === current.name) return { ok: false, code: "unchanged", error: "השם לא השתנה" };

  const key = normShowLabel(name);
  for (const s of others) {
    if (s.id === current.id) continue;
    for (const label of [s.name, ...(s.aliases ?? [])]) {
      if (label && normShowLabel(label) === key) {
        return {
          ok: false,
          code: "duplicate",
          error: `התוכנית "${s.name}" כבר משתמשת ב"${label}" — שם כפול ישלח הקלטה לתוכנית הלא נכונה`,
        };
      }
    }
  }

  // the new name is the name now — drop it from the aliases if it was one
  const kept = (current.aliases ?? []).filter((a) => normShowLabel(a) !== key);
  const oldKey = normShowLabel(current.name);
  // a change of spelling only (same normalised label) needs no alias: the
  // matcher already reads both the same way
  const needsAlias = oldKey !== key && !kept.some((a) => normShowLabel(a) === oldKey);
  return {
    ok: true,
    name,
    aliases: needsAlias ? [...kept, current.name] : kept,
    aliasAdded: needsAlias ? current.name : null,
  };
}
