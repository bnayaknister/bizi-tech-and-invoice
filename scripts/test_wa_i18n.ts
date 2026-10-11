/**
 * E19 — the bilingual bot. Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_wa_i18n.ts
 * No users, no database, no network, no Meta — F19 is open and nothing here
 * goes near it.
 *
 * Covers:
 *   1. the dictionary: both languages have the same leaves, every leaf is
 *      classified by what Meta limits it to, and every one — every function
 *      called with worst-case arguments — fits, in BOTH languages;
 *   2. English is English: no Hebrew letter in any English leaf except the
 *      ones that name Hebrew on purpose (the language switch);
 *   3. no client text outside the dictionary: the bot's source files are
 *      scanned for Hebrew in code that is not a log line or the owner's notice;
 *   4. the language helpers: button ids, typed switch words, template fallback;
 *   5. the machine: language in the state, the menu's switch button or hint,
 *      the "refresh" after a switch, and old states without a language;
 *   6. dates and times in Asia/Jerusalem, on both sides of the clock change.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COPY, LANG_WORDS, STUDIO_EN, copy, dayEn, dayHe, type BotCopy, type Lang } from "../src/lib/whatsapp/flow/copy";
import {
  FLOW_ID,
  initialState,
  parseFlowState,
  reduce,
  render,
  start,
  textEvent,
  type FlowReply,
  type FlowState,
  type Transition,
} from "../src/lib/whatsapp/flow/machine";
import { toRecordingOption } from "../src/lib/whatsapp/flow/run";
import {
  TEMPLATE_EN_APPROVED,
  langButtonId,
  langFromText,
  langOrDefault,
  languageFromMessage,
  languageFromSaved,
  languageQuestion,
  parseLangId,
  templateLanguageFor,
} from "../src/lib/whatsapp/lang";
import { flowPayload } from "../src/lib/whatsapp/reply";
import { BUTTON_LIMITS, LIST_LIMITS, SECTION_TITLE_MAX } from "../src/lib/whatsapp/client";
import { BOOKABLE_ROOM_NAMES } from "../src/lib/booking/request";
import { BOOKING_DURATIONS } from "../src/lib/booking/duration";

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
  } else {
    failed++;
    console.log(`  ❌ ${name}\n       got:  ${g}\n       want: ${w}`);
  }
}
const section = (s: string) => console.log(`\n── ${s}`);

/** Meta counts characters; client.ts truncates by code point, so do we. */
const len = (s: string) => Array.from(s).length;
const HEBREW = /[֐-׿]/;

// ═══ 1. the dictionary, leaf by leaf ════════════════════════════════════════

type Kind = "button" | "listButton" | "rowTitle" | "rowDesc" | "section" | "body" | "words";
const LIMIT: Record<Exclude<Kind, "words">, number> = {
  button: BUTTON_LIMITS.title, // 20
  listButton: LIST_LIMITS.button, // 20
  rowTitle: LIST_LIMITS.rowTitle, // 24
  rowDesc: LIST_LIMITS.rowDescription, // 72
  section: SECTION_TITLE_MAX, // 24
  body: LIST_LIMITS.body, // 1024 — the interactive body, the tighter of the two
};

/**
 * Every leaf, by what it becomes in a WhatsApp message. A new leaf that is not
 * listed here FAILS the suite — so nothing reaches a client unmeasured.
 */
const KIND: Record<string, Kind> = {
  "fmt.day": "rowTitle",
  "fmt.studio": "rowTitle",
  "fmt.durationShort": "rowTitle",
  "LANG.pickerBody": "body",
  "LANG.pickHe": "button",
  "LANG.pickEn": "button",
  "LANG.switchButton": "button",
  "LANG.switchHint": "body",
  "LANG.switched": "body",
  "REPLY.neutral": "body",
  "REPLY.link": "body",
  "REPLY.listBody": "body",
  "REPLY.listButton": "listButton",
  "REPLY.listSection": "section",
  // NAV.back/restart are both a list row AND a button: the tighter limit
  "NAV.back": "button",
  "NAV.restart": "button",
  "NAV.sectionChoices": "section",
  "NAV.sectionNav": "section",
  "NAV_WORDS.back": "words",
  "NAV_WORDS.restart": "words",
  "MENU.body": "body",
  "MENU.bodyWithLink": "body",
  "MENU.go": "button",
  "MENU.link": "button",
  "MENU.mine": "button",
  "MENU.switchShow": "button",
  "MINE.body": "body",
  "MINE.button": "listButton",
  "MINE.title": "rowTitle",
  "MINE.description": "rowDesc",
  "MANAGE.body": "body",
  "MANAGE.move": "button",
  "MANAGE.cancel": "button",
  "CANCEL_CONFIRM.body": "body",
  "CANCEL_CONFIRM.yes": "button",
  "MOVE_SUMMARY.body": "body",
  "MOVE_SUMMARY.confirm": "button",
  "DURATION.body": "body",
  "DURATION.button": "listButton",
  "DURATION.title": "rowTitle",
  "DURATION.description": "rowDesc",
  "STUDIO_DEFAULT.body": "body",
  "STUDIO_DEFAULT.moveBody": "body",
  "STUDIO_DEFAULT.yes": "button",
  "STUDIO_DEFAULT.other": "button",
  "STUDIO.body": "body",
  "STUDIO.button": "listButton",
  "STUDIO.row": "rowTitle",
  "DAY.body": "body",
  "DAY.button": "listButton",
  "DAY.title": "rowTitle",
  "DAY.description": "rowDesc",
  "DAY.more": "rowTitle",
  "HOUR.body": "body",
  "HOUR.button": "listButton",
  "HOUR.title": "rowTitle",
  "HOUR.more": "rowTitle",
  "GUEST.body": "body",
  "GUEST.skip": "button",
  "GUEST.tooLong": "body",
  "NOTE.body": "body",
  "NOTE.skip": "button",
  "NOTE.tooLong": "body",
  "SUMMARY.body": "body",
  "SUMMARY.confirm": "button",
  "SUMMARY.cancel": "button",
  "OUTCOME.approved": "body",
  "OUTCOME.pending": "body",
  "OUTCOME.cancelled": "body",
  "OUTCOME.alreadySent": "body",
  "OUTCOME.submitting": "body",
  "OUTCOME.tooMany": "body",
  "OUTCOME.bookingCancelled": "body",
  "OUTCOME.moved": "body",
  "OUTCOME.movePending": "body",
  "OUTCOME.moveAbandoned": "body",
  "OUTCOME.forwardedCancel": "body",
  "OUTCOME.forwardedMove": "body",
  "OUTCOME.notActive": "body",
  "NOTICE.expired": "body",
  "NOTICE.stale": "body",
  "NOTICE.pickFromList": "body",
  "NOTICE.slotTaken": "body",
  "NOTICE.dayFull": "body",
  "NOTICE.noDays": "body",
  "NOTICE.submitFailed": "body",
  "NOTICE.feedFailed": "body",
  "NOTICE.noRecordings": "body",
  "NOTICE.manageFailed": "body",
};

// ── worst-case arguments ──
const DATES: string[] = [];
{
  const d = new Date(Date.UTC(2026, 0, 1));
  while (d.getUTCFullYear() < 2028) {
    DATES.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
}
const ROOMS = [...BOOKABLE_ROOM_NAMES] as string[];
const DURS = [...BOOKING_DURATIONS];
/** a long show name — user data, the same in both languages */
const LONG_SHOW = "The Long-Named Weekly Podcast Show 2026"; // 39
const URL = "https://bizi-app.vercel.app/b/" + "A".repeat(43);
const rec = (date: string, studio: string) => ({ showName: LONG_SHOW, date, start: "23:30", end: "23:59", studio });
const SAMPLE_DATES = ["2026-10-14", "2026-12-30", "2026-09-27", "2027-02-28"];

/** For each function leaf: every argument tuple to try. Missing = the suite fails. */
const SAMPLES: Record<string, unknown[][]> = {
  "fmt.day": DATES.map((d) => [d]),
  "fmt.studio": ROOMS.map((r) => [r]),
  "fmt.durationShort": DURS.map((d) => [d]),
  "REPLY.link": [[LONG_SHOW, URL]],
  "MENU.body": [[LONG_SHOW]],
  "MENU.bodyWithLink": [[LONG_SHOW, URL], [LONG_SHOW, null]],
  "MINE.title": DATES.map((d) => [d, "23:30"]),
  "MINE.description": ROOMS.map((r) => [LONG_SHOW, r]),
  "MANAGE.body": ROOMS.map((r) => [rec("2026-12-30", r)]),
  "CANCEL_CONFIRM.body": ROOMS.map((r) => [rec("2026-12-30", r)]),
  "MOVE_SUMMARY.body": [
    [
      {
        showName: LONG_SHOW,
        from: { dateIsrael: "2026-12-30", start: "23:30", end: "23:59", studio: "גבעון גדול" },
        to: { dateIsrael: "2026-12-31", start: "23:30", end: "23:59", studio: "גבעון גדול" },
      },
    ],
  ],
  "DURATION.title": DURS.map((d) => [d]),
  "DURATION.description": DURS.map((d) => [d]),
  "STUDIO_DEFAULT.body": ROOMS.map((r) => [r]),
  "STUDIO_DEFAULT.moveBody": ROOMS.map((r) => [r]),
  "STUDIO_DEFAULT.yes": ROOMS.map((r) => [r]),
  "STUDIO.row": ROOMS.map((r) => [r]),
  "DAY.body": ROOMS.flatMap((r) => DURS.map((d) => [r, d])),
  "DAY.title": DATES.map((d) => [d]),
  "DAY.description": Array.from({ length: 99 }, (_, i) => [i + 1]),
  "HOUR.body": DATES.map((d) => [d]),
  "HOUR.title": [["23:30", "23:59"]],
  "SUMMARY.body": ROOMS.flatMap((r) =>
    DURS.map((d) => [
      {
        showName: LONG_SHOW,
        dateIsrael: "2026-12-30",
        start: "23:30",
        end: "23:59",
        studio: r,
        duration: d,
        guest: "G".repeat(120), // GUEST_MAX_CHARS
        note: "N".repeat(500), // NOTE_MAX_CHARS
      },
    ])
  ),
  "OUTCOME.approved": SAMPLE_DATES.flatMap((d) => ROOMS.map((r) => [LONG_SHOW, d, "23:30", r])),
  "OUTCOME.pending": SAMPLE_DATES.map((d) => [LONG_SHOW, d, "23:30"]),
  "OUTCOME.bookingCancelled": SAMPLE_DATES.map((d) => [LONG_SHOW, d, "23:30"]),
  "OUTCOME.moved": SAMPLE_DATES.flatMap((d) => ROOMS.map((r) => [LONG_SHOW, d, "23:30", r])),
  "OUTCOME.movePending": SAMPLE_DATES.map((d) => [d, "23:30"]),
  "NOTICE.noDays": ROOMS.flatMap((r) => DURS.map((d) => [r, d])),
};

/** Walk an object's leaves -> [path, value]. */
function leaves(o: unknown, prefix = ""): [string, unknown][] {
  if (o && typeof o === "object" && !Array.isArray(o)) {
    return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, o]];
}

/** Every string a leaf can produce. */
function outputs(path: string, v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "function") {
    const s = SAMPLES[path];
    if (!s) return [];
    return s.map((args) => (v as (...a: unknown[]) => string)(...args));
  }
  return [];
}

section("1. the dictionary — same leaves, all classified, all within Meta's limits");
{
  const he = leaves(COPY.he);
  const en = leaves(COPY.en);
  check("he and en have exactly the same leaves", en.map(([p]) => p), he.map(([p]) => p));
  check(
    "every leaf has the same type in both languages",
    he.filter(([p, v]) => typeof v !== typeof en.find(([q]) => q === p)?.[1]).map(([p]) => p),
    []
  );
  check("every leaf is classified (KIND) — a new one must be added there", he.map(([p]) => p).filter((p) => !KIND[p]), []);
  check("no stale KIND entry", Object.keys(KIND).filter((k) => !he.some(([p]) => p === k)), []);
  check(
    "every function leaf has worst-case samples",
    he.filter(([, v]) => typeof v === "function").map(([p]) => p).filter((p) => !SAMPLES[p]),
    []
  );

  for (const lang of ["he", "en"] as Lang[]) {
    const over: string[] = [];
    let measured = 0;
    for (const [path, v] of leaves(COPY[lang])) {
      const kind = KIND[path];
      if (!kind || kind === "words") continue;
      for (const out of outputs(path, v)) {
        measured++;
        if (len(out) > LIMIT[kind]) over.push(`${path} (${kind} ${len(out)}/${LIMIT[kind]}): ${out.slice(0, 40)}`);
        if (out.trim() === "") over.push(`${path}: empty`);
      }
    }
    check(`${lang}: every output within its limit (measured=${measured})`, over, []);
  }

  // the typed words are matched lower-cased and trimmed — they must be stored that way
  for (const lang of ["he", "en"] as Lang[]) {
    const words = [...COPY[lang].NAV_WORDS.back, ...COPY[lang].NAV_WORDS.restart];
    check(`${lang}: nav words are lower-case and trimmed`, words.filter((w) => w !== w.trim().toLowerCase()), []);
  }
  const nav = (["he", "en"] as Lang[]).flatMap((l) => [...COPY[l].NAV_WORDS.back, ...COPY[l].NAV_WORDS.restart]);
  const switchWords = Object.values(LANG_WORDS).flat();
  check("a language word is never a nav word", switchWords.filter((w) => nav.includes(w)), []);
}

// ═══ 2. English is English ══════════════════════════════════════════════════

section("2. no Hebrew in the English dictionary (except naming Hebrew itself)");
{
  /** the leaves that name Hebrew on purpose: the switch, and the bilingual picker */
  const MAY_BE_HEBREW = new Set(["LANG.pickerBody", "LANG.pickHe", "LANG.switchButton", "LANG.switchHint"]);
  const leaks: string[] = [];
  for (const [path, v] of leaves(COPY.en)) {
    if (MAY_BE_HEBREW.has(path) || KIND[path] === "words") continue;
    for (const out of outputs(path, v)) if (HEBREW.test(out)) leaks.push(`${path}: ${out.slice(0, 60)}`);
  }
  check("no Hebrew letter in any English output", leaks, []);
  check("every studio has an English name", ROOMS.filter((r) => !STUDIO_EN[r]), []);
  check("the picker is the same in both dictionaries", COPY.en.LANG.pickerBody, COPY.he.LANG.pickerBody);
  check("the picker body is bilingual", [HEBREW.test(COPY.he.LANG.pickerBody), /[A-Za-z]/.test(COPY.he.LANG.pickerBody)], [true, true]);
  check("English link replies say the page is in Hebrew (recommendation, not yet approved)", COPY.en.REPLY.link("X", URL).includes("(the page is in Hebrew)"), true);
  check("…and the Hebrew does not", COPY.he.REPLY.link("X", URL).includes("Hebrew"), false);
}

// ═══ 3. no client text outside the dictionary ═══════════════════════════════

section("3. the bot's source carries no client text of its own");
{
  const FILES = [
    "src/lib/whatsapp/reply.ts",
    "src/lib/whatsapp/lang.ts",
    "src/lib/whatsapp/flow/machine.ts",
    "src/lib/whatsapp/flow/run.ts",
    "src/lib/whatsapp/flow/store.ts",
  ];
  /**
   * Hebrew allowed in code (not comments) only here:
   *   · log lines — the developer reads them, not the client;
   *   · the owner's notice excerpt in reply.ts — owner-facing, Hebrew by scope.
   */
  const ALLOWED = [/console\.(error|log|warn)\(/, /excerpt: `אין קישור הזמנה לתוכנית/];
  const strip = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")) // block comments, lines kept
      .split("\n")
      .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1")); // line comments (not "https://")
  const found: string[] = [];
  for (const f of FILES) {
    const lines = strip(readFileSync(join(process.cwd(), f), "utf8"));
    lines.forEach((l, i) => {
      if (!HEBREW.test(l)) return;
      if (ALLOWED.some((re) => re.test(l))) return;
      found.push(`${f}:${i + 1}: ${l.trim().slice(0, 80)}`);
    });
  }
  check(`no Hebrew outside comments/logs in ${FILES.length} bot files`, found, []);

  // and the old exports are gone, so nothing can import a sentence around the dictionary
  const reply = readFileSync(join(process.cwd(), "src/lib/whatsapp/reply.ts"), "utf8");
  check("reply.ts no longer exports its own sentences", /export (const|function) (NEUTRAL_REPLY|LIST_COPY|linkReplyBody)/.test(reply), false);
}

// ═══ 4. the language helpers ════════════════════════════════════════════════

section("4. button ids, typed words, template language");
{
  const W = "wamid.HBgMOTcyNTAxMjM0NTY3FQIAEhgUM0E5QkQ2RjQ5RjU2QjM4QjE3MDcA";
  check("langButtonId round-trips with a pending message", parseLangId(langButtonId("en", W)), { lang: "en", pending: W });
  check("…and without one", parseLangId(langButtonId("he")), { lang: "he", pending: null });
  check("a language id fits Meta's 256", len(langButtonId("en", W)) <= BUTTON_LIMITS.id, true);
  check("unknown language refused", parseLangId("lang:fr"), null);
  check("not ours refused", parseLangId("f:go"), null);
  check("non-string refused", parseLangId(42), null);
  check("a pending value with spaces refused", parseLangId("lang:en:a b"), null);
  check("a pending value with a quote refused", parseLangId(`lang:en:x"y`), null);
  check("an empty pending value refused", parseLangId("lang:en:"), null);
  check("an overlong pending value refused", parseLangId("lang:en:" + "a".repeat(201)), null);

  check("'English' switches", langFromText("English"), "en");
  check("case and spaces do not matter", langFromText("  ENGLISH "), "en");
  check("'עברית' switches", langFromText("עברית"), "he");
  check("'Hebrew' switches", langFromText("hebrew"), "he");
  check("'אנגלית' switches", langFromText("אנגלית"), "en");
  check("a sentence containing the word does not", langFromText("english please"), null);
  check("empty does not", langFromText(""), null);
  check("null does not", langFromText(null), null);

  check("langOrDefault: garbage is Hebrew", langOrDefault("fr"), "he");
  check("no template is marked as approved in English yet", Object.keys(TEMPLATE_EN_APPROVED), []);
  check("an English client falls back to the Hebrew template", templateLanguageFor("bizi_client_approved", "en"), "he");
  TEMPLATE_EN_APPROVED["bizi_test_template"] = true;
  check("…until its English version is marked approved", templateLanguageFor("bizi_test_template", "en"), "en");
  check("…and a Hebrew client stays Hebrew regardless", templateLanguageFor("bizi_test_template", "he"), "he");
  delete TEMPLATE_EN_APPROVED["bizi_test_template"];

  // ── the decision the reply layer acts on ──
  const msg = (interactiveId: string | null, type = "interactive", body: string | null = null) => ({ interactiveId, type, body });
  check("a picker tap resumes the held message", languageFromMessage(msg(langButtonId("en", W))), { kind: "resume", lang: "en", pending: W });
  check("the menu's switch button re-sends the step", languageFromMessage(msg("lang:he")), { kind: "switch", lang: "he" });
  check("typed 'English' re-sends the step in English", languageFromMessage(msg(null, "text", "English")), { kind: "switch", lang: "en" });
  check("an ordinary message says nothing about language", languageFromMessage(msg(null, "text", "hi, Tuesday?")), null);
  check("a flow tap says nothing about language", languageFromMessage(msg("f:go")), null);
  check("a crafted language id is ignored, not trusted", languageFromMessage(msg("lang:fr:x")), null);
  check("'English' as a button caption is not typed text", languageFromMessage(msg(null, "image", "English")), null);
  check("a saved language is used", languageFromSaved({ ok: true, lang: "en" }), { kind: "use", lang: "en" });
  check("no saved language -> ask", languageFromSaved({ ok: true, lang: null }), { kind: "ask" });
  check("a failed read -> Hebrew, no question", languageFromSaved({ ok: false }), { kind: "use", lang: "he" });
  const q = languageQuestion(W);
  check("the question offers עברית and English, in that order", q.buttons.map((b) => b.title), ["עברית", "English"]);
  check("…each carrying the held message", q.buttons.map((b) => parseLangId(b.id)), [
    { lang: "he", pending: W },
    { lang: "en", pending: W },
  ]);
  check("…and fits Meta", q.buttons.every((b) => len(b.title) <= BUTTON_LIMITS.title && len(b.id) <= BUTTON_LIMITS.id), true);
}

// ═══ 5. the machine ═════════════════════════════════════════════════════════

const SHOW = {
  showId: "11111111-1111-1111-1111-111111111111",
  showName: "Unpopular Opinion",
  defaultStudio: "גבעון",
  multiShow: false,
};
const reply = (t: Transition): FlowReply => {
  if (t.kind !== "reply") throw new Error(`expected a reply, got ${t.kind}`);
  return t.reply;
};
const buttons = (r: FlowReply) => (r.type === "buttons" ? r.buttons : []);
/** every visible string of a reply */
const texts = (r: FlowReply): string[] =>
  r.type === "text"
    ? [r.body]
    : r.type === "buttons"
    ? [r.body, ...r.buttons.map((b) => b.title)]
    : [r.body, r.button, ...r.sections.flatMap((s) => [s.title, ...s.rows.flatMap((x) => [x.title, x.description ?? ""])])];

section("5. the machine speaks the state's language");
{
  check("a state starts in Hebrew by default", initialState(SHOW).lang, "he");
  check("…and bilingual off", initialState(SHOW).bilingualOn, false);
  check("an English show info starts in English", initialState({ ...SHOW, lang: "en" }).lang, "en");

  const old = { ...initialState(SHOW) } as Partial<FlowState>;
  delete old.lang;
  delete old.bilingualOn;
  check("a state saved before E19 reads back as Hebrew", parseFlowState(old)?.lang, "he");
  check("…with bilingual off", parseFlowState(old)?.bilingualOn, false);
  check("a stored garbage language reads back as Hebrew", parseFlowState({ ...initialState(SHOW), lang: "fr" })?.lang, "he");

  // bilingual OFF: the Hebrew menu is exactly E9-5's — no button, no hint
  const heOff = reply(start({ ...SHOW, manageOn: true, linkUrl: URL }));
  check("switch off: no language button", buttons(heOff).map((b) => b.id), [FLOW_ID.go, FLOW_ID.mine]);
  check("switch off: no hint", heOff.body.includes("English"), false);

  // ON, one podcast: room for the button
  const heOn = reply(start({ ...SHOW, manageOn: true, linkUrl: URL, bilingualOn: true }));
  check("on, one podcast: the third button switches to English", buttons(heOn).map((b) => [b.id, b.title]).at(-1), [
    "lang:en",
    "🌐 English",
  ]);
  const enOn = reply(start({ ...SHOW, manageOn: true, linkUrl: URL, bilingualOn: true, lang: "en" }));
  check("on, English: the button switches to Hebrew", buttons(enOn).map((b) => [b.id, b.title]).at(-1), ["lang:he", "🌐 עברית"]);
  check("the English menu is English", enOn.body.startsWith("Hi! 🎙️ Want to book a recording for Unpopular Opinion?"), true);

  // ON, several podcasts: no room -> a typed hint
  const multi = reply(start({ ...SHOW, multiShow: true, manageOn: true, linkUrl: URL, bilingualOn: true }));
  check("on, several podcasts: still three buttons, none of them the language", buttons(multi).map((b) => b.id), [
    FLOW_ID.go,
    FLOW_ID.mine,
    FLOW_ID.switchShow,
  ]);
  check("…and the body says how to type it", multi.body.endsWith(COPY.he.LANG.switchHint), true);
  const multiEn = reply(start({ ...SHOW, multiShow: true, manageOn: true, linkUrl: URL, bilingualOn: true, lang: "en" }));
  check("…in English, the hint is in Hebrew (it is for a Hebrew reader)", multiEn.body.endsWith(COPY.en.LANG.switchHint), true);

  // a whole English booking, with an English show name: no Hebrew anywhere
  // except the language switch
  const enState: FlowState = { ...initialState({ ...SHOW, lang: "en", bilingualOn: true, manageOn: true, linkUrl: URL }) };
  const leaks: string[] = [];
  const scan = (t: Transition) => {
    if (t.kind !== "reply") return;
    for (const s of texts(t.reply)) {
      const clean = s.replace(COPY.en.LANG.switchButton, "").replace(COPY.en.LANG.switchHint, "");
      if (HEBREW.test(clean)) leaks.push(`${t.state.step}: ${s.slice(0, 60)}`);
    }
  };
  scan(render(enState));
  for (const step of ["duration", "studio-default", "studio", "guest", "note"] as const) {
    scan(render({ ...enState, step, duration: 90 }));
  }
  scan(render({ ...enState, step: "day", duration: 180, studio: "גבעון גדול", days: ["2026-10-14", "2026-10-15"] }));
  scan(render({ ...enState, step: "hour", duration: 90, studio: "חשמונאים", date: "2026-10-14", hours: [{ start: "10:00", end: "11:30" }] }));
  scan(
    render({
      ...enState,
      step: "summary",
      duration: 240,
      studio: "גבעון גדול",
      date: "2026-10-14",
      start: "10:00",
      end: "14:00",
      guest: null,
      note: null,
    })
  );
  const target = {
    id: "22222222-2222-2222-2222-222222222222",
    showId: SHOW.showId,
    showName: "Unpopular Opinion",
    studio: "חשמונאים",
    date: "2026-10-20",
    start: "10:00",
    end: "11:30",
    startIso: "2026-10-20T07:00:00Z",
    durationMinutes: 90,
    guest: null,
    note: null,
  };
  scan(render({ ...enState, step: "mine", recordings: [target] }));
  scan(render({ ...enState, step: "manage", target }));
  scan(render({ ...enState, step: "cancel-confirm", target }));
  scan(
    render({
      ...enState,
      step: "summary",
      mode: "move",
      target,
      duration: 90,
      studio: "גבעון",
      date: "2026-10-21",
      start: "12:00",
      end: "13:30",
    })
  );
  scan(render({ ...enState, step: "submitting" }));
  scan(reduce({ ...enState, step: "duration" }, { type: "text", text: "hello" }));
  scan(reduce({ ...enState, step: "duration" }, { type: "go" }));
  check("an English conversation renders no Hebrew (studios included)", leaks, []);

  // the studio list: Hebrew ids (the identifier), English titles
  const studios = reply(render({ ...enState, step: "studio", duration: 90 }));
  const rows = studios.type === "list" ? studios.sections[0].rows : [];
  check("studio rows keep the Hebrew id", rows.map((r) => r.id), ROOMS.map((r) => FLOW_ID.studio(r as never)));
  check("…and show the English name", rows.map((r) => r.title), ["Givon", "Givon Large", "Hashmonaim"]);

  // refresh — after a language switch
  const day: FlowState = { ...enState, step: "day", duration: 90, studio: "גבעון", days: ["2026-10-14"] };
  const r1 = reduce(day, { type: "refresh" });
  check("refresh re-sends the same step", r1.state.step, "day");
  check("…under 'switched' in the new language", reply(r1).body.startsWith(COPY.en.LANG.switched), true);
  check("refresh mid-submission says only 'in progress'", reply(reduce({ ...enState, step: "submitting" }, { type: "refresh" })).body, COPY.en.OUTCOME.submitting);
  const r3 = reduce({ ...enState, step: "done" }, { type: "refresh" });
  check("refresh after a finished booking goes to the menu", r3.state.step, "menu");
  check("…saying so", reply(r3).body.startsWith(COPY.en.LANG.switched), true);
  check("refresh keeps every choice", r1.state.days, day.days);

  // a Hebrew state renders the approved Hebrew, unchanged
  check("Hebrew approval is title.ts's text", copy("he").OUTCOME.approved("דעה", "2026-10-14", "10:00", "גבעון"), "ההקלטה של דעה אושרה: יום ד׳ 14.10 ב-10:00, אולפן גבעון. נתראה!");
  check("English approval", copy("en").OUTCOME.approved("Opinion", "2026-10-14", "10:00", "גבעון"), "Your Opinion recording is confirmed: Wed 14 Oct at 10:00, Givon studio. See you there!");

  // typed nav words — both languages, any case
  check("'Back' is back", textEvent("Back"), { type: "back" });
  check("'חזרה' is back", textEvent("חזרה"), { type: "back" });
  check("'Start over' is restart", textEvent("  Start   over "), { type: "restart" });
  check("'English' is NOT a nav word (the reply layer handles it)", textEvent("English").type, "text");

  // the payload passes untouched — nothing relied on truncation
  const payload = flowPayload("972500000000", enOn) as { interactive: { action: { buttons: { reply: { title: string } }[] } } };
  check("English menu buttons reach Graph untruncated", payload.interactive.action.buttons.map((b) => b.reply.title), buttons(enOn).map((b) => b.title));
  check("copy(garbage) is Hebrew", copy("fr" as Lang) === COPY.he, true);
}

// ═══ 6. dates and times — Asia/Jerusalem ════════════════════════════════════

section("6. dates and times, on both sides of the clock change");
{
  check("dayEn", dayEn("2026-10-14"), "Wed 14 Oct");
  check("dayHe", dayHe("2026-10-14"), "יום ד׳ 14.10");
  check("dayEn on the change day", dayEn("2026-10-25"), "Sun 25 Oct");
  check("dayEn on a leap day", dayEn("2028-02-29"), "Tue 29 Feb");
  check("dayEn of garbage is itself", dayEn("nope"), "nope");

  // 00:30 Israel, once on summer time (UTC+3) and once on winter time (UTC+2):
  // the date and the hour come from Asia/Jerusalem, never from UTC
  const opt = (iso: string) =>
    toRecordingOption({ id: "x", show_id: "s", studio: "גבעון", start_at: iso, end_at: iso, guest: null, note: null, showName: "S" });
  const summer = opt("2026-10-24T21:30:00Z");
  check("summer time: 21:30Z is 00:30 the next Israeli day", [summer.date, summer.start], ["2026-10-25", "00:30"]);
  check("…and the English line says Sunday", COPY.en.MINE.title(summer.date, summer.start), "Sun 25 Oct · 00:30");
  const winter = opt("2026-10-25T22:30:00Z");
  check("winter time: 22:30Z is 00:30 the next Israeli day", [winter.date, winter.start], ["2026-10-26", "00:30"]);
  check("…and the English line says Monday", COPY.en.MINE.title(winter.date, winter.start), "Mon 26 Oct · 00:30");
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
if (failed > 0) process.exit(1);
