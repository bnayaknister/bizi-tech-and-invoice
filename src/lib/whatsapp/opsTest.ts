import { parseBillingNotifyNumbers, parseNotifyNumbers, rejectedNotifyNumbers } from "./notify";

// ═══════════════════════════════════════════════════════════════════════════
// B38-7 — "שליחת התראת בדיקה" and the alert recipients, on the settings screen.
// PURE — no env reads here; the callers pass the variables in.
// ═══════════════════════════════════════════════════════════════════════════
//
// Owner, 22.10: one bizi_ops_alert to the owner's own number, the result
// (Meta's message id or its exact error) on the screen, an event, once a
// minute at most. Owner only (role 'owner', not admin).
//
// "The owner's number" is the FIRST entry of WHATSAPP_NOTIFY_NUMBERS — the
// same number every ops alert goes to (recordBookingNotification). profiles
// carries no phone, so that is the one place the system knows it. Empty or
// malformed → Bnaya's number (owner instruction).

/** {{1}} {{2}} {{3}} of the test, owner wording 22.10 */
export const OPS_TEST_PARAMS = ["בדיקה – התראות מהמערכת", "אין צורך לפעול", "להתעלם מההודעה"] as const;

export const OPS_TEST_FALLBACK_WA_ID = "972528933975";
export const OPS_TEST_EVENT = "whatsapp_test_alert";
export const OPS_TEST_MIN_INTERVAL_MS = 60_000;

/** the one recipient of the test, or null when the caller is not the owner */
export function opsTestRecipient(role: string | null | undefined, notifyRaw: string | null | undefined): string | null {
  if (role !== "owner") return null;
  return parseNotifyNumbers(notifyRaw)[0] ?? OPS_TEST_FALLBACK_WA_ID;
}

/** seconds still to wait (0 = may send) after the last test at `lastAt` */
export function opsTestWaitSeconds(lastAt: string | null | undefined, now: Date): number {
  if (!lastAt) return 0;
  const t = Date.parse(lastAt);
  if (!Number.isFinite(t)) return 0;
  const left = OPS_TEST_MIN_INTERVAL_MS - (now.getTime() - t);
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/** "972528933975" → "••••••••3975": only the last four digits show */
export function maskWaId(waId: string): string {
  const d = waId.replace(/\D/g, "");
  if (d.length <= 4) return d;
  return "•".repeat(d.length - 4) + d.slice(-4);
}

export type AlertRecipientsView = {
  /** WHATSAPP_NOTIFY_NUMBERS, normalised and masked; the first one gets the ops alerts */
  notify: string[];
  /** WHATSAPP_BILLING_NOTIFY_NUMBERS (the bookkeeper), normalised and masked */
  billing: string[];
  /** entries the system refuses and therefore never messages */
  notifyRejected: number;
  billingRejected: number;
};

export function alertRecipientsView(notifyRaw: string | null | undefined, billingRaw: string | null | undefined): AlertRecipientsView {
  const billingEntries = (billingRaw ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const billing = parseBillingNotifyNumbers(billingRaw);
  return {
    notify: parseNotifyNumbers(notifyRaw).map(maskWaId),
    billing: billing.map(maskWaId),
    notifyRejected: rejectedNotifyNumbers(notifyRaw).length,
    // a duplicate is not a refusal: count the entries no normalisation accepted
    billingRejected: billingEntries.filter((e) => parseBillingNotifyNumbers(e).length === 0).length,
  };
}
