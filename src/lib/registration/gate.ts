import { NextResponse } from "next/server";
import { getSessionAndProfile } from "@/lib/profile";
import { isStudioAdmin } from "@/lib/clients/access";

/**
 * Every registration route's first line (E17-5): Bnaya and Eli only —
 * `studio_admin`, set only from the SQL Editor (0107). The screen hides the
 * buttons from everyone else; this is what actually refuses them.
 */
export async function requireStudioAdmin(): Promise<{ ok: true; userId: string } | { ok: false; res: NextResponse }> {
  const { user, profile } = await getSessionAndProfile();
  if (!user) return { ok: false, res: NextResponse.json({ error: "לא מחובר" }, { status: 401 }) };
  if (!isStudioAdmin(profile)) {
    return { ok: false, res: NextResponse.json({ error: "אישור הרשמות — לבניה ולאלי בלבד" }, { status: 403 }) };
  }
  return { ok: true, userId: user.id };
}
