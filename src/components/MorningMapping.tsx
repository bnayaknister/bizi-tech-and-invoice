"use client";

import { useCallback, useState } from "react";
import {
  MAPPING_CANCEL,
  MAPPING_CONFIRM,
  MAPPING_TITLE,
  mappingBody,
} from "@/lib/clients/morningMapping";

/**
 * The act of mapping one of our clients to a Morning client — the POST, the
 * shared-mapping handshake, and the warning dialog that handshake needs.
 *
 * ═══ EXTRACTED, NOT REWRITTEN (owner 7.10) ═══
 * All of this was `save()` inside MorningClientsClient.tsx, where it was the
 * only caller. /clients now needs the same act from a client's card, and the
 * owner's rule was explicit: reuse, no duplication, no new route. So the body
 * of `save()` moved here verbatim — same endpoint, same payload, same 409
 * handshake, same `backfilled` notice — and the settings screen calls it.
 *
 * 🔴 THE 409 IS THE PART THAT MUST NOT BE RE-IMPLEMENTED. Mapping two of our
 * clients onto ONE Morning client is legitimate and deliberate (owner
 * 2026-07-20): the route refuses the first attempt with the list of clients
 * already on that card, the caller shows it, and the retry carries
 * `confirm_shared`. A second screen that forgot the retry would simply fail to
 * map; a second screen that sent `confirm_shared` from the start would map
 * silently and lose the warning entirely. One implementation, two callers.
 */

export type SharedPending = {
  clientId: string;
  morningId: string;
  morningName?: string;
  sharedWith: string[];
};

export type AssignOutcome =
  | { ok: true; backfilled: number }
  | { ok: false; needsShared: true }
  | { ok: false; needsShared: false; error: string };

export function useMorningMapping() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingShared, setPendingShared] = useState<SharedPending | null>(null);

  /**
   * `morningId: null` UNMAPS — the direction that repairs, and the one the
   * route lets through without any of the checks above.
   *
   * Returns an outcome instead of setting an error string: the two callers
   * word their failures differently (the settings screen shows the raw
   * message, the client card wraps it in the approved "לא בוצע שום שינוי"
   * sentence), and a shared hook must not pick one of them.
   */
  const assign = useCallback(
    async (
      clientId: string,
      morningId: string | null,
      morningName?: string,
      confirmShared = false
    ): Promise<AssignOutcome> => {
      setBusyId(clientId);
      try {
        const res = await fetch("/api/morning/clients", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: clientId,
            morning_client_id: morningId,
            morning_client_name: morningName,
            confirm_shared: confirmShared,
          }),
        });
        const body = await res.json();
        if (res.status === 409 && body.needs_confirmation) {
          // shared mapping — warn, don't block. Hold it for the modal.
          setPendingShared({
            clientId,
            morningId: morningId as string,
            morningName,
            sharedWith: body.shared_with ?? [],
          });
          return { ok: false, needsShared: true };
        }
        if (!res.ok) return { ok: false, needsShared: false, error: body.error ?? "שמירה נכשלה" };
        setPendingShared(null);
        return { ok: true, backfilled: Number(body.backfilled ?? 0) };
      } catch {
        return { ok: false, needsShared: false, error: "שגיאת רשת" };
      } finally {
        setBusyId(null);
      }
    },
    []
  );

  return { assign, busyId, pendingShared, setPendingShared };
}

/**
 * The shared-mapping warning. Awareness, not a block — the second call goes
 * through, which is why the confirm button says what it is agreeing to rather
 * than just "OK".
 *
 * Markup moved verbatim out of MorningClientsClient so that screen renders
 * byte-identically; the suite asserts exactly that.
 */
export function SharedMappingModal({
  pending,
  busy,
  onConfirm,
  onCancel,
}: {
  pending: SharedPending;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
      {/* `--bg` is not a variable this project defines (globals.css has
          --bg-base / --bg-panel / --bg-elevated and no bare --bg), so this
          panel was painting itself with an invalid declaration and coming
          out transparent. Same bug, same day, as the two approval modals on
          /documents — fixed with the values every other modal already uses. */}
      <div
        style={{
          background: "rgba(15,13,28,0.94)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
        }}
        className="border border-[var(--rule)] rounded-2xl p-5 max-w-md w-full"
      >
        <h3 className="font-bold text-sm mb-2">לקוח מורנינג משותף</h3>
        <p className="text-sm mb-3">
          לקוח זה כבר משויך ל<span className="font-bold">{pending.sharedWith.join(", ")}</span>. שתי
          הישויות יחויבו לאותו לקוח במורנינג.
        </p>
        <p className="text-[11px] text-[var(--faint)] mb-4">אם זו אותה ישות משלמת עם כמה מותגים — זה תקין.</p>
        <div className="flex gap-2">
          <button
            disabled={busy}
            onClick={onConfirm}
            className="flex-1 bg-[var(--signal)] text-white text-xs font-bold rounded-xl px-4 py-2 disabled:opacity-40"
          >
            כן, זו אותה ישות משלמת
          </button>
          <button
            onClick={onCancel}
            className="flex-1 text-xs rounded-xl px-4 py-2 border border-[var(--rule)]"
          >
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 🔴 THE MAPPING CONFIRMATION WINDOW. Wording approved by the owner, 7.10 —
 * title, body and both buttons, all from lib/clients/morningMapping.ts.
 *
 * Pure, and that is what lets the suite COUNT that the previous card's name
 * and the new one each appear exactly once. A window that showed the new name
 * in both slots would read as "nothing is changing" on the one action that
 * decides whose name is printed on every future invoice.
 *
 * `from === null` is the FIRST mapping and renders the shorter sentence —
 * there is no card being replaced, so there is no "instead of".
 */
export function MappingChangeConfirm({
  toName,
  fromName,
  busy = false,
  onConfirm,
  onCancel,
}: {
  toName: string;
  fromName: string | null;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="rounded-lg border border-amber-500/50 px-2.5 py-2"
      style={{ background: "rgba(251,191,36,0.10)" }}
    >
      <div className="text-[11px] font-bold text-amber-200 mb-1">{MAPPING_TITLE}</div>
      <div className="text-[10px] text-amber-100 leading-relaxed">{mappingBody(toName, fromName)}</div>
      <div className="flex items-center gap-2 mt-1.5">
        <button
          onClick={onConfirm}
          disabled={busy}
          className="text-[10px] rounded-lg px-2 py-1 border border-amber-500/60 text-amber-300"
        >
          {MAPPING_CONFIRM}
        </button>
        <button onClick={onCancel} className="text-[10px] text-[var(--faint)] underline">
          {MAPPING_CANCEL}
        </button>
      </div>
    </div>
  );
}
