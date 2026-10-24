/**
 * E14-2c — the shared half of the offline suite (test_wa_freetext_llm.ts) and
 * the live eval (eval_e14_2c.ts): the 40-message set, the pipeline exactly as
 * runFlow runs it at the menu (rule parser -> shouldCallLlm -> interpretLlm),
 * and the score (owner decision 21.10, 7: 0 wrong fields applied, >= 90% of the
 * set fully understood). Pure — no network, no env.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { eventFromMessage } from "../src/lib/whatsapp/flow/run";
import { interpretLlm, shouldCallLlm, type Interpretation, type LlmRaw, type LLM_ROOMS } from "../src/lib/whatsapp/flow/llm";
import type { FlowEvent, FlowStep } from "../src/lib/whatsapp/flow/machine";
import type { InboundMessage } from "../src/lib/whatsapp/webhook";

export type Applied = {
  day: string | null;
  studio: string | null;
  time: string | null;
  duration: number | null;
  guest: string | null;
  note: string | null;
};
export const FIELDS = ["day", "studio", "time", "duration", "guest", "note"] as const;
type Field = (typeof FIELDS)[number];

type Compact = {
  intent: "book" | "query" | "other";
  cond?: boolean;
  day?: [string, { weekday?: number; next_week?: boolean; dom?: number; month?: number; rel?: "today" | "tomorrow" | "after_tomorrow" }];
  time?: [string, number, number, "none" | "morning" | "afternoon" | "evening" | "night", "at" | "from" | "before"];
  duration?: [string, number];
  studio?: [string, string];
  guest?: [string, string];
  note?: [string, string];
  unsure?: string[];
};
export type Fixture = {
  id: number;
  cat: string;
  text: string;
  /** the conversation step the message arrives at; absent = the menu (a first message) */
  step?: FlowStep;
  expect: Applied;
  ignore?: Field[];
  model: Compact;
  /**
   * owner, 24.10: true = a cancel / move of an existing recording — the rule
   * parser must turn it into the "manage-intent" event (find the recording,
   * show its buttons); false = it must NOT (a booking's own edit, "ביטול" at
   * the summary). Absent = not scored.
   */
  manage?: boolean;
};

export function loadFixtures(): { today: string; messages: Fixture[] } {
  const raw = JSON.parse(readFileSync(join(__dirname, "fixtures", "e14_2c_messages.json"), "utf-8"));
  return { today: raw.today, messages: raw.messages };
}

/** The compact "correct model" answer -> the full shape the API returns. */
export function expandModel(c: Compact): LlmRaw {
  const sure = (k: string) => !(c.unsure ?? []).includes(k);
  return {
    intent: c.intent,
    conditional: c.cond ?? false,
    day: c.day
      ? {
          quote: c.day[0], sure: sure("day"),
          weekday: c.day[1].weekday ?? null, next_week: c.day[1].next_week ?? false,
          day_of_month: c.day[1].dom ?? null, month: c.day[1].month ?? null, relative: c.day[1].rel ?? null,
        }
      : null,
    time: c.time ? { quote: c.time[0], sure: sure("time"), hour: c.time[1], minute: c.time[2], daypart: c.time[3], kind: c.time[4] } : null,
    duration: c.duration ? { quote: c.duration[0], sure: sure("duration"), minutes: c.duration[1] } : null,
    studio: c.studio ? { quote: c.studio[0], sure: sure("studio"), room: c.studio[1] as (typeof LLM_ROOMS)[number] } : null,
    guest: c.guest ? { quote: c.guest[0], sure: sure("guest"), name: c.guest[1] } : null,
    note: c.note ? { quote: c.note[0], sure: sure("note"), text: c.note[1] } : null,
  };
}

const textMessage = (body: string): InboundMessage =>
  ({ wamid: "w-eval", waId: "972500000000", rawFrom: "972500000000", type: "text", body, raw: null }) as InboundMessage;

/** The rule parser's event at `step`, exactly as runFlow computes it (layer on, Hebrew). */
export function ruleEvent(text: string, today: string, step: FlowStep = "menu"): FlowEvent {
  return eventFromMessage(textMessage(text), { now: new Date(`${today}T10:00:00+03:00`), freeTextOn: true, step, lang: "he" });
}

/**
 * The menu pipeline for one message. `model` = the model's raw answer, or
 * null when the call failed (-> the rule parser's event, as in runFlow).
 */
export function pipeline(text: string, today: string, model: unknown | null, step: FlowStep = "menu"): {
  rule: FlowEvent;
  called: boolean;
  interpretation: Interpretation | null;
  event: FlowEvent;
} {
  const rule = ruleEvent(text, today, step);
  const called = shouldCallLlm(text, step, rule);
  if (!called || model === null) return { rule, called, interpretation: null, event: rule };
  const interpretation = interpretLlm(model, { text, todayIsrael: today, rule, step });
  return { rule, called, interpretation, event: interpretation.event ?? rule };
}

/** What an event would APPLY at the menu. A range / "before" (a filter, not a field) applies no day/time. */
export function appliedOf(e: FlowEvent): Applied {
  const a: Applied = { day: null, studio: null, time: null, duration: null, guest: null, note: null };
  if (e.type === "query") {
    const q = e.q;
    if (q.studio) a.studio = q.studio;
    if (q.duration) a.duration = q.duration;
    if (q.dateFrom && q.dateFrom === q.dateTo) a.day = q.dateFrom;
    if (q.timeFrom && !q.timeTo) a.time = `from ${q.timeFrom}`;
    // E14-2c: a part of the day ("בצהריים") is a range of starts
    if (q.timeFrom && q.timeTo) a.time = `range ${q.timeFrom}-${q.timeTo}`;
  } else if (e.type === "edit") {
    for (const x of e.edits) {
      if (x.field === "studio") a.studio = x.studio;
      else if (x.field === "studio-default") a.studio = "default";
      else if (x.field === "duration") a.duration = x.minutes;
      else if (x.field === "day") a.day = x.date;
      else if (x.field === "time-at") a.time = `at ${x.hhmm}`;
      else if (x.field === "time-from") a.time = `from ${x.hhmm}`;
      else if (x.field === "guest") a.guest = x.value;
      else if (x.field === "note") a.note = x.value;
    }
  }
  return a;
}

const norm = (t: string) => t.replace(/\s+/g, " ").trim();

/**
 * WRONG = a field applied with a value the message did not mean (or applied
 * where it must not be). Asking instead of applying is never wrong. The time
 * "from 12:00" vs "at 12:00" is the same hour, a different kind: not wrong,
 * not fully understood either. The note passes if it contains the core phrase.
 */
export function score(f: Fixture, a: Applied, event?: FlowEvent): { wrong: (Field | "manage")[]; missing: Field[]; full: boolean } {
  const wrong: (Field | "manage")[] = [];
  // owner, 24.10: a cancel / move is found and shown, never read as a booking
  if (f.manage !== undefined && event && (event.type === "manage-intent") !== f.manage) wrong.push("manage");
  const missing: Field[] = [];
  for (const k of FIELDS) {
    if (f.ignore?.includes(k)) continue;
    const want = f.expect[k];
    const got = a[k];
    if (got === null) {
      if (want !== null) missing.push(k);
      continue;
    }
    if (want === null) {
      wrong.push(k);
      continue;
    }
    if (k === "note") {
      if (!norm(String(got)).includes(norm(String(want)))) wrong.push(k);
    } else if (k === "time") {
      const [wk, wh] = String(want).split(" ");
      const [gk, gh] = String(got).split(" ");
      if (wh !== gh) wrong.push(k);
      else if (wk !== gk) missing.push(k);
    } else if (k === "guest") {
      if (norm(String(got)) !== norm(String(want))) wrong.push(k);
    } else if (got !== want) {
      wrong.push(k);
    }
  }
  return { wrong, missing, full: wrong.length === 0 && missing.length === 0 };
}

export const PASS = { maxWrong: 0, minFullShare: 0.9 };
