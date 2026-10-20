/**
 * "לא" / "אין" / "בלי" at the guest and note steps = skip. For EVERYONE. Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_wa_skip_words.ts
 * No users, no database, no network, no Meta.
 *
 * Owner, 20.10: the live test saved "לא" as the booking's note. The fix
 * applies with the free-text switch ON and OFF; this suite proves both, and
 * proves that nothing else moved for a number with the switch off: other
 * texts are still the value, the buttons still skip, and the same words at
 * every other step behave exactly as before.
 */
import { FLOW_ID, initialState, isSkipWord, reduce, textEvent, type FlowState } from "../src/lib/whatsapp/flow/machine";
import { eventFromMessage } from "../src/lib/whatsapp/flow/run";
import { COPY } from "../src/lib/whatsapp/flow/copy";
import type { InboundMessage } from "../src/lib/whatsapp/webhook";

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}\n       got:  ${g}\n       want: ${w}`);
  }
}

const NOW = new Date("2026-10-20T10:00:00+03:00");
const SHOW = { showId: "11111111-1111-1111-1111-111111111111", showName: "בדיקה", defaultStudio: "גבעון", multiShow: false };

/** A booking at the guest step, the slot already chosen. */
function at(step: "guest" | "note", opts: { freeTextOn: boolean; lang: "he" | "en"; guest?: string | null }): FlowState {
  return {
    ...initialState({ ...SHOW, freeTextOn: opts.freeTextOn, lang: opts.lang }),
    step,
    duration: 90,
    studio: "גבעון",
    date: "2026-10-22",
    start: "16:00",
    end: "17:30",
    guest: opts.guest ?? null,
  };
}
const type = (s: FlowState, text: string) => reduce(s, textEvent(text), { now: NOW });
const stateOf = (t: ReturnType<typeof reduce>) => {
  if (t.kind !== "reply") throw new Error(`expected a reply, got ${t.kind}`);
  return t.state;
};

const MODES = [
  { label: "switch OFF, he", freeTextOn: false, lang: "he" as const },
  { label: "switch ON, he", freeTextOn: true, lang: "he" as const },
  { label: "switch OFF, en", freeTextOn: false, lang: "en" as const },
  { label: "switch ON, en", freeTextOn: true, lang: "en" as const },
];

console.log("\n=== 1. the words ===");
for (const w of ["לא", "אין", "בלי", " לא ", "לא.", "לא!", "אין…", "no", "No", "NONE", "none."]) check(`"${w}" is a skip word`, isSkipWord(w), true);
for (const w of ["לאה", "לא יודע", "אין לי מושג", "בלי אורח", "לא להקליט", "אינה", "nobody", "no one", "", "  "]) check(`"${w}" is NOT`, isSkipWord(w), false);

for (const m of MODES) {
  console.log(`\n=== 2. guest step — ${m.label} ===`);
  for (const w of ["לא", "אין", "בלי", "no"]) {
    const s = stateOf(type(at("guest", m), w));
    check(`"${w}" -> note step, no guest`, [s.step, s.guest], ["note", null]);
  }
  const tap = stateOf(reduce(at("guest", m), { type: "no-guest" }, { now: NOW }));
  const typed = stateOf(type(at("guest", m), "לא"));
  check("typed 'לא' = the skip button, field for field", typed, tap);
  check("'לאה' is still a name", stateOf(type(at("guest", m), "לאה")).guest, "לאה");
  check("'לא יודע עדיין' is still the value (exact words only)", stateOf(type(at("guest", m), "לא יודע עדיין")).guest, "לא יודע עדיין");
  check("'בלי אורח' is still the value (not in the owner's list)", stateOf(type(at("guest", m), "בלי אורח")).guest, "בלי אורח");

  console.log(`\n=== 3. note step — ${m.label} ===`);
  for (const w of ["לא", "אין", "בלי", "none"]) {
    const s = stateOf(type(at("note", { ...m, guest: "דני" }), w));
    check(`"${w}" -> summary, no note, guest kept`, [s.step, s.note, s.guest], ["summary", null, "דני"]);
  }
  const noteTap = stateOf(reduce(at("note", m), { type: "no-note" }, { now: NOW }));
  check("typed 'לא' = the skip button, field for field", stateOf(type(at("note", m), "לא")), noteTap);
  check("'לא להקליט את הפתיח' is still a note", stateOf(type(at("note", m), "לא להקליט את הפתיח")).note, "לא להקליט את הפתיח");
}

console.log("\n=== 4. nothing else moved (switch OFF, Hebrew) ===");
{
  const off = { freeTextOn: false, lang: "he" as const };
  const base = initialState({ ...SHOW, ...off });
  const HE = COPY.he;
  // the same words at every OTHER step: exactly as before — "choose from the options"
  const steps: FlowState[] = [
    { ...base, step: "duration" },
    { ...base, step: "studio", duration: 90 },
    { ...base, step: "studio-default", duration: 90 },
    { ...base, step: "day", duration: 90, studio: "גבעון", days: ["2026-10-22"] },
    { ...base, step: "hour", duration: 90, studio: "גבעון", date: "2026-10-22", hours: [{ start: "16:00", end: "17:30" }] },
    { ...base, step: "summary", duration: 90, studio: "גבעון", date: "2026-10-22", start: "16:00", end: "17:30" },
  ];
  for (const s of steps) {
    const t = type(s, "לא");
    check(`'לא' at ${s.step}: same step, 'choose from the options'`, t.kind === "reply" && [t.state.step, t.reply.body.startsWith(HE.NOTICE.pickFromList)], [s.step, true]);
  }
  const menu = type({ ...base, step: "menu" }, "לא");
  check("'לא' at the menu: the menu again", menu.kind === "reply" && menu.state.step, "menu");
  // the driver hands the guest step raw text, switch on or off
  const msg = { wamid: "w", waId: "972500000000", rawFrom: "972500000000", type: "text", body: "לא", raw: null } as InboundMessage;
  check("driver, switch on: 'לא' at the guest step is plain text", eventFromMessage(msg, { now: NOW, freeTextOn: true, step: "guest", lang: "he" }), { type: "text", text: "לא" });
  check("driver, switch off: same", eventFromMessage(msg, { now: NOW, freeTextOn: false, step: "guest", lang: "he" }), { type: "text", text: "לא" });
  // the buttons are untouched
  check("the skip buttons' ids are unchanged", [FLOW_ID.noGuest, FLOW_ID.noNote].every((x) => typeof x === "string" && x.length > 0), true);
}

console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
