// ═══════════════════════════════════════════════════════════════════════════
// E14-3 — monitoring the free-text layer after it opens to everyone (owner,
// 22.10). PURE: no env, no Supabase — the flow and the cron feed it.
// ═══════════════════════════════════════════════════════════════════════════
//
// Every typed Hebrew message that reaches the language layer leaves ONE event,
// `wa_freetext_message`: the step, whether the model was asked (and what came
// of it), and how much of the message was understood. NO PHONE NUMBER, ever —
// and the message text and the bot's answer are kept ONLY for a message that
// was not fully understood (the owner's review list), nothing for the rest.
// A request the bot submitted for such a number adds `wa_freetext_booking`.
//
// Every evening at 21:30 (Israel) the cron counts the day and sends the owner
// one bizi_ops_alert. The monitoring starts by itself on the first evening the
// layer is open to everyone (switch on + empty allowlist) — it writes
// `freetext_monitor_started` once — and stops by itself after 14 days.

export const FREETEXT_EVENT = "wa_freetext_message";
export const FREETEXT_BOOKING_EVENT = "wa_freetext_booking";
export const MONITOR_STARTED_EVENT = "freetext_monitor_started";
export const MONITOR_SUMMARY_EVENT = "freetext_monitor_summary";
export const MONITOR_DAYS = 14;

export type Understood = "full" | "partial" | "none" | "greeting";

/** the parsed event's shape, as much as classification needs */
export type ClassifiableEvent =
  | { type: "text"; text?: string }
  | { type: "query"; q: { dropped: string[] } }
  | { type: "edit"; dropped: string[]; maybe?: unknown[] }
  | { type: string };

/** the steps where typed text is PARSED (elsewhere it is the value asked for: a guest, a note) */
const PARSING_STEPS = new Set(["menu", "duration", "studio-default", "studio", "day", "hour", "summary"]);

/**
 * How much of a typed message was understood. PURE.
 *   none     — nothing was read: the bot answered with the step again / "לא הבנתי"
 *   partial  — something was read, something was dropped or left as a question
 *   full     — everything was read (or the text was the value the step asked for)
 *   greeting — a short first message ("שלום", "היי") answered with the menu: not a miss
 */
export function classifyFreeText(input: {
  step: string;
  event: ClassifiableEvent;
  /** a live conversation existed before this message */
  live: boolean;
  /** an open "08:00 או 20:00?" / "another room?" question was answered */
  answeringQuestion?: boolean;
  text: string;
}): Understood {
  if (input.answeringQuestion) return "full";
  const e = input.event;
  if (e.type === "query") return (e as { q: { dropped: string[] } }).q.dropped.length > 0 ? "partial" : "full";
  if (e.type === "edit") {
    const ed = e as { dropped: string[]; maybe?: unknown[] };
    return ed.dropped.length > 0 || (ed.maybe?.length ?? 0) > 0 ? "partial" : "full";
  }
  if (e.type === "text") {
    if (!PARSING_STEPS.has(input.step)) return "full";
    const words = input.text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).length;
    if (!input.live && input.step === "menu" && words <= 2) return "greeting";
    return "none";
  }
  // a typed word the rule parser maps to a button ("ביטול", "חזרה", "כן") — read
  return "full";
}

/** the bot's answer as one line of text (the body; buttons/list titles are not the answer) */
export function replyText(reply: { body?: string } | null | undefined): string | null {
  const b = reply?.body?.replace(/\s+/g, " ").trim();
  return b ? b : null;
}

/** day N of the monitoring (1..14) on `today`, or null when outside it. PURE. */
export function monitorDay(startDate: string | null | undefined, today: string): number | null {
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return null;
  const a = Date.UTC(+startDate.slice(0, 4), +startDate.slice(5, 7) - 1, +startDate.slice(8, 10));
  const b = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  const n = Math.round((b - a) / 86_400_000) + 1;
  return n >= 1 && n <= MONITOR_DAYS ? n : null;
}

export type MonitorEventRow = { event_type: string; created_at: string; payload: unknown };
export type DayCounts = { messages: number; llm: number; notUnderstood: number; bookings: number };

/** count one Israeli day out of the events (each already filtered to that day). PURE. */
export function countDay(rows: MonitorEventRow[]): DayCounts {
  const c: DayCounts = { messages: 0, llm: 0, notUnderstood: 0, bookings: 0 };
  for (const r of rows) {
    const p = (r.payload ?? {}) as { llm_called?: boolean; understood?: Understood };
    if (r.event_type === FREETEXT_EVENT) {
      c.messages++;
      if (p.llm_called) c.llm++;
      if (p.understood === "none" || p.understood === "partial") c.notUnderstood++;
    } else if (r.event_type === FREETEXT_BOOKING_EVENT) {
      c.bookings++;
    }
  }
  return c;
}

/** the three bizi_ops_alert parameters of the evening summary — one line each */
export function summaryParams(day: number, dateIsrael: string, c: DayCounts): { title: string; details: string; action: string } {
  const dm = `${Number(dateIsrael.slice(8, 10))}.${Number(dateIsrael.slice(5, 7))}`;
  return {
    title: `סיכום טקסט חופשי ${dm} (יום ${day} מתוך ${MONITOR_DAYS})`,
    details: `הודעות חופשיות: ${c.messages} · עברו ל-LLM: ${c.llm} · לא הובנו במלואן: ${c.notUnderstood} · הזמנות שנקבעו: ${c.bookings}`,
    action: c.notUnderstood > 0 ? "לעבור על ההודעות שלא הובנו במסך ההגדרות ← טקסט חופשי" : "אין צורך לפעול",
  };
}
