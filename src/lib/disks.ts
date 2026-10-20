// B35 — recording disks as a closed list (storage_disks, 0120). PURE: no
// server imports, so the drawer, the settings screen and a pure suite share it.
//
// The database is the wall: a unique index on storage_disk_key(name), the
// trg_disk_sync trigger (a name that is not on the list is refused, a hidden
// disk is not chosen anew) and ON DELETE RESTRICT. Everything here only turns
// those walls into sentences before the round trip.

export type DiskOption = { id: string; name: string };

export const DISK_NAME_MAX = 60;

/** The same key as SQL public.storage_disk_key(): no whitespace, lower case. Keep in lockstep. */
export function diskKey(name: string): string {
  return name.trim().replace(/\s+/g, "").toLowerCase();
}

export type DiskNameCheck = { ok: true; name: string } | { ok: false; error: string };

/** A disk name as the table's CHECK accepts it: trimmed, inner spaces collapsed, 1..60 chars. */
export function validateDiskName(raw: unknown): DiskNameCheck {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) return { ok: false, error: "שם הכונן חובה" };
  if (Array.from(name).length > DISK_NAME_MAX) return { ok: false, error: `שם הכונן ארוך מדי (עד ${DISK_NAME_MAX} תווים)` };
  return { ok: true, name };
}

/** Another disk that the new name would collide with (spaces / case ignored), or null. */
export function diskCollision(name: string, disks: DiskOption[], selfId: string | null = null): DiskOption | null {
  const key = diskKey(name);
  return disks.find((d) => d.id !== selfId && diskKey(d.name) === key) ?? null;
}

/**
 * The technician's choices: the visible disks, plus the production's current
 * disk when it is hidden (so the window opens on what is really stored, and
 * saving without touching it keeps it). Never a free-text entry.
 */
export function diskChoices(
  visible: DiskOption[],
  current: { id: string | null; name: string | null }
): { id: string; label: string }[] {
  const out = visible.map((d) => ({ id: d.id, label: d.name }));
  if (current.id && !visible.some((d) => d.id === current.id)) {
    out.push({ id: current.id, label: `${current.name ?? "כונן"} (מוסתר)` });
  }
  return out;
}

/** A Postgres error from a storage_disks write -> the sentence the owner reads. */
export function diskWriteError(err: { code?: string; message?: string } | null | undefined): string {
  switch (err?.code) {
    case "23505":
      return "כבר יש כונן בשם הזה (בלי תלות ברווחים ובאותיות גדולות/קטנות)";
    case "23503":
      return "יש הפקות על הכונן הזה — אי אפשר למחוק אותו, אפשר להסתיר";
    case "23514":
      return "שם הכונן לא תקין";
    default:
      return err?.message ?? "השמירה נכשלה";
  }
}
