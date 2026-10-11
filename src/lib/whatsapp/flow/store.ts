import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { expiresAtFor, parseFlowState, type FlowState } from "./machine";

// ═══════════════════════════════════════════════════════════════════════════
// The conversation row — `wa_conversations` (0104). One row per phone number.
// ═══════════════════════════════════════════════════════════════════════════
//
// The TYPED client. 0104 was applied on 2026-10-11 and `database.types.ts`
// regenerated against it, so every column below is vouched for by the drift
// check. Until then this file ran on the untyped one — the same window as the
// webhook route before 0101 and lib/booking/contacts.ts before 0103.
//
// 🔴 A FAILED READ IS STILL HANDLED, not hoped away: it returns `{ ok: false }`
// and the driver falls back to the E9-3 reply (the booking link), so a
// database error never silences the bot.
//
// ═══ 🔴 THE VERSION LOCK ═══
// Every write is conditional on the version the caller read. Two deliveries
// processed at the same moment — a double tap on "✅ לקבוע" is exactly that —
// both read version N; the first write moves it to N+1 and the second matches
// no row and reports `conflict`. The driver then sends NOTHING for the loser.
// This is what keeps one tap = one submission even before the duplicate guard
// inside submitBookingRequest gets its turn.

const TABLE = "wa_conversations" as const;

export type ConversationRow = {
  state: FlowState | null;
  version: number;
  expiresAt: string;
};

export async function loadConversation(
  admin: SupabaseClient<Database>,
  waId: string
): Promise<{ ok: true; row: ConversationRow | null } | { ok: false }> {
  try {
    const { data, error } = await admin
      .from(TABLE)
      .select("state,version,expires_at")
      .eq("wa_id", waId)
      .maybeSingle();
    if (error) {
      console.error("wa/flow: קריאת השיחה נכשלה", error.message);
      return { ok: false };
    }
    if (!data) return { ok: true, row: null };
    return { ok: true, row: { state: parseFlowState(data.state), version: data.version, expiresAt: data.expires_at } };
  } catch (e) {
    console.error("wa/flow: קריאת השיחה זרקה", e);
    return { ok: false };
  }
}

export type SaveOutcome = { kind: "saved"; version: number } | { kind: "conflict" } | { kind: "error" };

/**
 * Write the state, conditional on `expectedVersion`.
 *
 * `null` means "there was no row when I read": an INSERT that refuses a
 * duplicate key, so two first messages racing produce one conversation.
 * A number means "the row I read was at this version": an UPDATE that
 * matches only that version.
 */
export async function saveConversation(
  admin: SupabaseClient<Database>,
  waId: string,
  state: FlowState,
  expectedVersion: number | null,
  now: Date
): Promise<SaveOutcome> {
  const fields = {
    show_id: state.showId,
    step: state.step,
    // ⚠️ the one cast, and it is sound: FlowState is plain strings, numbers,
    // nulls and arrays of them (it round-trips through JSON — see the suite),
    // but a type without an index signature is not assignable to `Json`.
    state: state as unknown as Json,
    updated_at: now.toISOString(),
    expires_at: expiresAtFor(now),
  };
  try {
    if (expectedVersion === null) {
      const { data, error } = await admin
        .from(TABLE)
        .upsert([{ wa_id: waId, version: 1, ...fields }], { onConflict: "wa_id", ignoreDuplicates: true })
        .select("version");
      if (error) {
        console.error("wa/flow: יצירת השיחה נכשלה", error.message);
        return { kind: "error" };
      }
      // the version is READ BACK from the row, not assumed — which is also what
      // makes a wrong column in the select above fail the build (admin.ts)
      const created = (data ?? [])[0];
      return created ? { kind: "saved", version: created.version } : { kind: "conflict" };
    }

    const next = expectedVersion + 1;
    const { data, error } = await admin
      .from(TABLE)
      .update({ version: next, ...fields })
      .eq("wa_id", waId)
      .eq("version", expectedVersion)
      .select("version");
    if (error) {
      console.error("wa/flow: עדכון השיחה נכשל", error.message);
      return { kind: "error" };
    }
    const updated = (data ?? [])[0];
    return updated ? { kind: "saved", version: updated.version } : { kind: "conflict" };
  } catch (e) {
    console.error("wa/flow: שמירת השיחה זרקה", e);
    return { kind: "error" };
  }
}
