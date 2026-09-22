/**
 * extractStudioAndGuest — the calendar title convention (owner spec 2026-08-19).
 *
 * Run:  npx tsx scripts/test_title_parse.ts
 *
 * TOUCHES NOTHING. No database, no network, no env. The parser is a pure
 * function and the studio list is passed in, so this whole file is arguments
 * in / values out — which is the point of keeping the list out of the parser.
 *
 * The convention under test:
 *   studio — a known studio name, anywhere in the title, longest match first.
 *   guest  — the text after "אורח:" / "אורחת:", up to the next comma or end
 *            of title.
 * Anything that doesn't follow it yields null rather than a guess.
 */
import { extractStudioAndGuest } from "../src/lib/calendar/match";
import { STUDIOS } from "../src/lib/calendar/studios";

type Case = {
  name: string;
  title: string;
  studio: string | null;
  guest: string | null;
};

const CASES: Case[] = [
  // ---- the central case from the spec ---------------------------------
  {
    name: "spec example: guest after the label, studio after the comma",
    title: "דעה לא פופולרית - ברק הרשקוביץ אורח: רות קבסה אברמזון, גבעון",
    studio: "גבעון",
    guest: "רות קבסה אברמזון",
  },
  {
    // the same title, asserting the negative: only the label decides who the
    // guest is. This is the behaviour change from the old parser.
    name: "spec example: the name BEFORE the label is not the guest",
    title: "דעה לא פופולרית - ברק הרשקוביץ אורח: רות קבסה אברמזון, גבעון",
    studio: "גבעון",
    guest: "רות קבסה אברמזון",
  },

  // ---- no label -> no guest -------------------------------------------
  {
    name: "no label at all -> guest is null, studio still read",
    title: "דעה לא פופולרית - ברק הרשקוביץ, גבעון",
    studio: "גבעון",
    guest: null,
  },
  {
    name: "real legacy title (pre-convention) -> null guest, not garbage",
    title: "הקלטות  בלי ירייה אחת עופר גולן - חשמונאים ",
    studio: "חשמונאים",
    guest: null,
  },
  {
    name: "label present but empty -> null, not an empty string",
    title: "דעה לא פופולרית אורח: , גבעון",
    studio: "גבעון",
    guest: null,
  },
  // ---- both grammatical genders of the label ---------------------------
  {
    name: "אורחת: is the same label",
    title: "פודקאסט אורחת: שירי אביאל, חשמונאים",
    studio: "חשמונאים",
    guest: "שירי אביאל",
  },
  {
    name: "אורחת: mid-title, real feed phrasing",
    title: "בן של מלך עם אורחת: קורין קיציס, חשמונאים",
    studio: "חשמונאים",
    guest: "קורין קיציס",
  },
  {
    name: "אורחת with no colon is a word, not a label",
    title: "וכטל ואורחת ליאור, גבעון",
    studio: "גבעון",
    guest: null,
  },

  // ---- longest-first: "גבעון גדול" must not read as "גבעון" ------------
  {
    name: "גבעון גדול is its own studio, not גבעון + גדול",
    title: "סדרת חינוך - אור גיא ומיכאלי אורח: דנה לוי, גבעון גדול",
    studio: "גבעון גדול",
    guest: "דנה לוי",
  },
  {
    name: "גבעון גדול with no guest label",
    title: "סדרת חינוך - אור גיא ומיכאלי - גבעון גדול",
    studio: "גבעון גדול",
    guest: null,
  },
  {
    // ⚠️ THE ONE THAT READS BACKWARDS. "גבעון בחוץ" is the SAME ROOM as
    // גבעון גדול (owner, 2026-09-22) even though it contains "גבעון". Without
    // its entry in studios.ts the shorter variant would match and this would
    // come back "גבעון" — the small room, the opposite of the decision.
    // Migration 0095 moved the one stored row the same way; this case is what
    // keeps the parser and the data from drifting apart again.
    name: "גבעון בחוץ is גבעון גדול, NOT גבעון (owner decision)",
    title: "סדרת חינוך אורח: דנה לוי, גבעון בחוץ",
    studio: "גבעון גדול",
    guest: "דנה לוי",
  },
  {
    // "גבעון בוט" with no apostrophe. It already canonicalised correctly
    // through the bare "גבעון" substring — but only as a PREFIX, leaving
    // " בוט" in the remainder the guest is read from. Naming the whole phrase
    // removes the whole phrase, so nothing leaks into the guest slot.
    name: "גבעון בוט (no apostrophe) is גבעון, and בוט does not leak into the guest",
    title: "סדרת חינוך אורח: דנה לוי, גבעון בוט",
    studio: "גבעון",
    guest: "דנה לוי",
  },

  // ---- canonicalisation of variants ------------------------------------
  {
    name: "החשמונאים -> canonical חשמונאים",
    title: "SFI פודקאסט אורח: הילית שגיא, החשמונאים",
    studio: "חשמונאים",
    guest: "הילית שגיא",
  },
  {
    name: "גבעון קטן -> canonical גבעון",
    title: "חתונמיות אורח: נועה בר, גבעון קטן",
    studio: "גבעון",
    guest: "נועה בר",
  },
  {
    name: "גבעון בוט' (straight apostrophe) -> canonical גבעון",
    title: "חתונמיות אורח: נועה בר, גבעון בוט'",
    studio: "גבעון",
    guest: "נועה בר",
  },
  {
    name: "גבעון בוט׳ (Hebrew geresh) -> canonical גבעון",
    title: "חתונמיות אורח: נועה בר, גבעון בוט׳",
    studio: "גבעון",
    guest: "נועה בר",
  },

  // ---- boundary handling ------------------------------------------------
  {
    name: "no comma after the guest -> reads to end of title",
    title: "עומר חן פודקאסט, חשמונאים אורח: דניאל קיד",
    studio: "חשמונאים",
    guest: "דניאל קיד",
  },
  {
    name: "studio removed from the text before the guest is cut (no comma)",
    title: "עומר חן פודקאסט אורח: דניאל קיד חשמונאים",
    studio: "חשמונאים",
    guest: "דניאל קיד",
  },
  {
    name: "studio before the label",
    title: "בינה נשית, חשמונאים, אורח: נטע צמח",
    studio: "חשמונאים",
    guest: "נטע צמח",
  },
  {
    name: "no studio in the title -> null, caller falls back to default_studio",
    title: "הנעות קטנות אורח: יוסי כהן",
    studio: null,
    guest: "יוסי כהן",
  },
  {
    name: "double spaces and a trailing space survive",
    title: "EY פודקאסט   אורח:   מיכל  אבן  ,  החשמונאים ",
    studio: "חשמונאים",
    guest: "מיכל אבן",
  },
  {
    name: "space before the colon",
    title: "חתונמיות אורח : נועה בר, גבעון",
    studio: "גבעון",
    guest: "נועה בר",
  },
  {
    name: "separator right after the label is stripped",
    title: "חתונמיות אורח: - נועה בר, גבעון",
    studio: "גבעון",
    guest: "נועה בר",
  },
  {
    name: "a guest whose name contains a studio word keeps their name",
    title: "סדרת חינוך אורח: גבעון כהן, גבעון גדול",
    studio: "גבעון גדול",
    guest: "גבעון כהן",
  },
  {
    name: "empty title",
    title: "",
    studio: null,
    guest: null,
  },
];

let failed = 0;
for (const c of CASES) {
  const got = extractStudioAndGuest(c.title, STUDIOS);
  const ok = got.studio === c.studio && got.guest === c.guest;
  if (ok) {
    console.log(`  PASS  ${c.name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${c.name}`);
    console.log(`        title    ${JSON.stringify(c.title)}`);
    console.log(`        expected studio=${JSON.stringify(c.studio)} guest=${JSON.stringify(c.guest)}`);
    console.log(`        got      studio=${JSON.stringify(got.studio)} guest=${JSON.stringify(got.guest)}`);
  }
}

console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
if (failed > 0) process.exit(1);
