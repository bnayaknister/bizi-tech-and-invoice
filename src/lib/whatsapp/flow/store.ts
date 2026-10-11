import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { expiresAtFor, parseFlowState, type FlowState } from "./machine";

// ═══════════════════════════════════════════════════════════════════════════
// The conversation row — `wa_conversations` (0104). One row per phone number.
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ THE UNTYPED CLIENT, DELIBERATELY. 0104 is applied by hand and
// `database.types.ts` is regenerated only afterwards (supabase/migrations/
// README.md, step 3); a types entry for a table that does not exist yet would
// fail scripts/check-schema-drift.mjs on the dangerous "-" side. The same
// window, and the same choice, as the webhook route before 0101 and
// lib/booking/contacts.ts before 0103. This file goes typed in the commit that
// follows the apply.
//
// 🔴 AND UNTIL 0104 IS APPLIED, EVERY CALL HERE FAILS — and that is handled,
// not hoped away: a failed read returns `{ ok: false }`, and the driver falls
// back to the E9-3 reply (the booking link). The bot never goes silent because
// this table is missing.
//
// ═══ 🔴 THE VERSION LOCK ═══
// Every write is conditional on the version the caller read. Two deliveries
// processed at the same moment — a double tap on "✅ לקבוע" is exactly that —
// both read version N; the first write moves it to N+1 and the second matches
// no row and reports `conflict`. The driver then sends NOTHING for the loser.
// This is what keeps one tap = one submission even before the duplicate guard
// inside submitBookingRequest gets its turn.

const TABLE = "wa_conversations";

export type ConversationRow = {
  state: FlowState | null;
  version: number;
  expiresAt: string;
};

const untyped = (admin: SupabaseClient<Database>) => admin as unknown as SupabaseClient;

export async function loadConversation(
  admin: SupabaseClient<Database>,
  waId: string
): Promise<{ ok: true; row: ConversationRow | null } | { ok: false }> {
  try {
    const { data, error } = await untyped(admin)
      .from(TABLE)
      .select("state,version,expires_at")
      .eq("wa_id", waId)
      .maybeSingle();
    if (error) {
      console.error("wa/flow: קריאת השיחה נכשלה", error.message);
      return { ok: false };
    }
    if (!data) return { ok: true, row: null };
    const r = data as { state: unknown; version: number; expires_at: string };
    return { ok: true, row: { state: parseFlowState(r.state), version: r.version, expiresAt: r.expires_at } };
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
    state: state as unknown as Json,
    updated_at: now.toISOString(),
    expires_at: expiresAtFor(now),
  };
  try {
    if (expectedVersion === null) {
      const { data, error } = await untyped(admin)
        .from(TABLE)
        .upsert([{ wa_id: waId, version: 1, ...fields }], { onConflict: "wa_id", ignoreDuplicates: true })
        .select("version");
      if (error) {
        console.error("wa/flow: יצירת השיחה נכשלה", error.message);
        return { kind: "error" };
      }
      return (data ?? []).length === 1 ? { kind: "saved", version: 1 } : { kind: "conflict" };
    }

    const next = expectedVersion + 1;
    const { data, error } = await untyped(admin)
      .from(TABLE)
      .update({ version: next, ...fields })
      .eq("wa_id", waId)
      .eq("version", expectedVersion)
      .select("version");
    if (error) {
      console.error("wa/flow: עדכון השיחה נכשל", error.message);
      return { kind: "error" };
    }
    return (data ?? []).length === 1 ? { kind: "saved", version: next } : { kind: "conflict" };
  } catch (e) {
    console.error("wa/flow: שמירת השיחה זרקה", e);
    return { kind: "error" };
  }
}
