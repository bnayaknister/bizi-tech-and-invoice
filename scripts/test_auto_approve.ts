/**
 * Pure auto-approval suite — E9-2.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_auto_approve.ts
 *
 * SYNTHETIC FIXTURES ONLY. No user is created, no row is written, no route is
 * called, no feed is fetched, nothing reaches Meta or Google — F19 is open, so
 * every rule under test here was written as a pure function on purpose and the
 * impure halves (`approveBookingRequest`, `recordBookingNotification`) are
 * deliberately thin wrappers around them.
 *
 * Every assertion COUNTS (rule 56). "The one-a-day rule works" is not an
 * assertion — "with one approved row on that date the verdict is
 * second-same-day, and with it on the next date the verdict is auto" is.
 *
 * ⚠️ WHAT THIS SUITE CANNOT REACH, AND WHAT COVERS IT INSTEAD:
 *   · the status flip, the EXCLUDE and the revert   -> they are database
 *     behaviour. The revert's own constraint pairing (`decided_at` back to
 *     null with the status) is 0096's `booking_requests_decided_chk`, proven
 *     by supabase/verify/0096_dryrun.sql against a real table.
 *   · the live ICS read -> scripts/test_booking.ts drives computeAvailability
 *     over fixture calendars; here we assert the DURATION arithmetic that
 *     decides which starts exist at all.
 */
import {
  approvedSameDayCount,
  autoApproveVerdict,
  isAutoApproveOn,
  type SameDayRow,
} from "../src/lib/booking/decide";
import {
  BOOKING_DURATIONS,
  DEFAULT_BOOKING_DURATION,
  DURATION_LABEL,
  durationFromRange,
  durationTag,
  validateDuration,
} from "../src/lib/booking/duration";
import {
  approvedNoticeBody,
  buildNotificationRows,
  notificationWamid,
  parseNotifyNumbers,
  pendingNoticeBody,
  rejectedNotifyNumbers,
  whenPhrase,
  type BookingFacts,
} from "../src/lib/whatsapp/notify";
import { computeAvailability, israelInstant, type AvailabilityWindow } from "../src/lib/calendar/availability";
import { STUDIOS } from "../src/lib/calendar/studios";
import type { CalendarEvent } from "../src/lib/calendar/parse";

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

// ── fixtures ────────────────────────────────────────────────────────────────

const GIVON = "גבעון";
const SUNDAY = "2026-09-27";
const MONDAY = "2026-09-28";
const FRIDAY = "2026-10-02";

/**
 * A busy calendar event, with EVERY field `CalendarEvent` requires.
 *
 * ⚠️ `location` and `recurrence` are not optional on that type and are spelled
 * out rather than cast away: `as CalendarEvent` on a partial literal is how a
 * fixture stops matching the thing it is standing in for, and this suite's
 * whole claim is that the production availability engine behaves this way.
 */
const busy = (
  dateIsrael: string,
  from: [number, number],
  to: [number, number],
  title = "גבעון — משהו אחר"
): CalendarEvent => ({
  uid: `busy-${dateIsrael}-${from[0]}${from[1]}`,
  title,
  start: israelInstant(dateIsrael, from[0], from[1]),
  end: israelInstant(dateIsrael, to[0], to[1]),
  location: null,
  recurrence: null,
  allDay: false,
});

/** An approved row at a given Israeli date and hour. */
const approvedAt = (dateIsrael: string, hh: number, mm = 0): SameDayRow => ({
  start_at: israelInstant(dateIsrael, hh, mm).toISOString(),
  status: "approved",
});
const pendingAt = (dateIsrael: string, hh: number, mm = 0): SameDayRow => ({
  start_at: israelInstant(dateIsrael, hh, mm).toISOString(),
  status: "pending",
});

console.log("\n=== 1. rule א — one slot a day per podcast ===");
{
  // the FIRST request of the day
  check(
    "no approved rows at all -> auto",
    autoApproveVerdict({ switchOn: true, approvedSameDay: approvedSameDayCount([], SUNDAY) }),
    { auto: true }
  );

  // the SECOND request, same day
  const oneOnSunday = [approvedAt(SUNDAY, 9)];
  check("one approved on that date is counted", approvedSameDayCount(oneOnSunday, SUNDAY), 1);
  check(
    "a second request the same day -> stays pending, and the reason is named",
    autoApproveVerdict({ switchOn: true, approvedSameDay: approvedSameDayCount(oneOnSunday, SUNDAY) }),
    { auto: false, reason: "second-same-day" }
  );

  // rule ב — a DIFFERENT day is unaffected
  check("the same row is not counted against the next day", approvedSameDayCount(oneOnSunday, MONDAY), 0);
  check(
    "a different day in the same week -> auto (rule ב: no weekly limit)",
    autoApproveVerdict({ switchOn: true, approvedSameDay: approvedSameDayCount(oneOnSunday, MONDAY) }),
    { auto: true }
  );

  // rule ב, stated as the owner stated it: 2-3 recordings a week all auto
  const threeDays = [approvedAt(SUNDAY, 9), approvedAt(MONDAY, 11), approvedAt("2026-09-30", 14)];
  check("three different days -> each date still counts 1", [
    approvedSameDayCount(threeDays, SUNDAY),
    approvedSameDayCount(threeDays, MONDAY),
    approvedSameDayCount(threeDays, "2026-09-30"),
  ], [1, 1, 1]);
  check(
    "a fourth day that week -> still auto; there is no weekly counter and that is deliberate",
    autoApproveVerdict({ switchOn: true, approvedSameDay: approvedSameDayCount(threeDays, "2026-10-01") }),
    { auto: true }
  );

  // only APPROVED counts
  check("a PENDING row on that date does not block", approvedSameDayCount([pendingAt(SUNDAY, 9)], SUNDAY), 0);
  check(
    "two pending on one day is a normal state -> the third still auto-approves",
    autoApproveVerdict({
      switchOn: true,
      approvedSameDay: approvedSameDayCount([pendingAt(SUNDAY, 9), pendingAt(SUNDAY, 11)], SUNDAY),
    }),
    { auto: true }
  );
  check("a DECLINED row does not block either", approvedSameDayCount([{ ...approvedAt(SUNDAY, 9), status: "declined" }], SUNDAY), 0);

  // 🔴 the Israeli-date boundary. A recording at 23:30 Israel time is already
  // "tomorrow" in UTC for two or three hours every night; counting in UTC
  // would let one podcast book twice on a single Israeli evening.
  const lateSunday = [approvedAt(SUNDAY, 23, 30)];
  check(
    "a 23:30 Israel recording counts against the ISRAELI date, not the UTC one",
    approvedSameDayCount(lateSunday, SUNDAY),
    1
  );
  check("and not against the following date", approvedSameDayCount(lateSunday, MONDAY), 0);
  check(
    "so a second booking that same Israeli evening is refused",
    autoApproveVerdict({ switchOn: true, approvedSameDay: approvedSameDayCount(lateSunday, SUNDAY) }),
    { auto: false, reason: "second-same-day" }
  );

  // garbage never silently counts as zero-and-approve
  check("an unparseable start_at is skipped", approvedSameDayCount([{ start_at: "not-a-date", status: "approved" }], SUNDAY), 0);
  check("null rows", approvedSameDayCount(null, SUNDAY), 0);
  check("undefined rows", approvedSameDayCount(undefined, SUNDAY), 0);
  check("more than one approved on a date is reported honestly", approvedSameDayCount([approvedAt(SUNDAY, 9), approvedAt(SUNDAY, 14)], SUNDAY), 2);
}

console.log("\n=== 2. the BOOKING_AUTO_APPROVE switch (rule 40, default OFF) ===");
{
  const original = process.env.BOOKING_AUTO_APPROVE;
  try {
    delete process.env.BOOKING_AUTO_APPROVE;
    check("🔴 UNSET means OFF — every request queues, exactly as before E9-2", isAutoApproveOn(), false);
    process.env.BOOKING_AUTO_APPROVE = "true";
    check("the exact string 'true' turns it on", isAutoApproveOn(), true);
    process.env.BOOKING_AUTO_APPROVE = "false";
    check("'false' is off", isAutoApproveOn(), false);
    process.env.BOOKING_AUTO_APPROVE = "ture";
    check("🔴 a TYPO stays OFF — this is why the comparison is === 'true'", isAutoApproveOn(), false);
    process.env.BOOKING_AUTO_APPROVE = "True";
    check("capitalised 'True' is off", isAutoApproveOn(), false);
    process.env.BOOKING_AUTO_APPROVE = " true ";
    check("a padded 'true' is off — no trimming, no guessing", isAutoApproveOn(), false);
    process.env.BOOKING_AUTO_APPROVE = "1";
    check("'1' is off", isAutoApproveOn(), false);
    process.env.BOOKING_AUTO_APPROVE = "";
    check("empty is off", isAutoApproveOn(), false);
  } finally {
    if (original === undefined) delete process.env.BOOKING_AUTO_APPROVE;
    else process.env.BOOKING_AUTO_APPROVE = original;
  }

  // and the switch beats the rule in both directions
  check(
    "switch off + a free day -> no auto approval, and the reason says which gate stopped it",
    autoApproveVerdict({ switchOn: false, approvedSameDay: 0 }),
    { auto: false, reason: "switch-off" }
  );
  check(
    "switch off + a second booking that day -> still reported as switch-off, not as the rule",
    autoApproveVerdict({ switchOn: false, approvedSameDay: 1 }),
    { auto: false, reason: "switch-off" }
  );
  check("switch on + free day -> auto", autoApproveVerdict({ switchOn: true, approvedSameDay: 0 }), { auto: true });
}

console.log("\n=== 3. rule ג — the three lengths, validated and never clamped ===");
{
  check("the closed list is exactly the owner's three", BOOKING_DURATIONS, [90, 180, 240]);
  check("the default is 90", DEFAULT_BOOKING_DURATION, 90);

  check("90 passes", validateDuration(90), 90);
  check("180 passes", validateDuration(180), 180);
  check("240 passes", validateDuration(240), 240);
  check("a numeric string passes (query strings are strings)", validateDuration("180"), 180);
  check("a padded numeric string passes", validateDuration(" 240 "), 240);

  // absent vs wrong, answered differently on purpose
  check("undefined -> the DEFAULT (the pre-E9-2 behaviour)", validateDuration(undefined), 90);
  check("null -> the default", validateDuration(null), 90);
  check("an empty string -> the default", validateDuration(""), 90);

  check("🔴 120 is REFUSED, not rounded to 90", validateDuration(120), null);
  check("30 is refused — the step is not a length", validateDuration(30), null);
  check("0 is refused", validateDuration(0), null);
  check("a negative is refused", validateDuration(-90), null);
  check("a float is refused", validateDuration(90.5), null);
  check("a non-numeric string is refused", validateDuration("ninety"), null);
  check("a boolean is refused", validateDuration(true), null);
  check("an object is refused", validateDuration({ minutes: 90 }), null);
  check("every label is non-empty", BOOKING_DURATIONS.map((m) => DURATION_LABEL[m].length > 0), [true, true, true]);
}

console.log("\n=== 4. the length actually changes the grid ===");
{
  const WIN = (slotMinutes: number): AvailabilityWindow => ({
    fromIsrael: SUNDAY,
    toIsrael: SUNDAY,
    openDays: [0, 1, 2, 3, 4], // Sun–Thu
    openHour: 9,
    closeHour: 19,
    slotMinutes,
    slotStepMinutes: 30,
  });

  const startsFor = (slotMinutes: number) =>
    computeAvailability([], [], STUDIOS, WIN(slotMinutes), [])
      .free.filter((s) => s.room === GIVON)
      .map((s) => s.startIsrael);

  const at90 = startsFor(90);
  const at180 = startsFor(180);
  const at240 = startsFor(240);

  // 09:00..19:00 is 600 minutes; at a 30-minute step the last legal start is
  // the one where start + length === 19:00.
  check("90 minutes: 18 starts, 09:00 first, 17:30 last", [at90.length, at90[0], at90[at90.length - 1]], [18, "09:00", "17:30"]);
  check("180 minutes: 15 starts, last is 16:00", [at180.length, at180[at180.length - 1]], [15, "16:00"]);
  check("240 minutes: 13 starts, last is 15:00", [at240.length, at240[at240.length - 1]], [13, "15:00"]);

  // 🔴 the business-hours edge — the thing the owner asked to be sure about
  check("a 17:30 start exists at 90 minutes", at90.includes("17:30"), true);
  check("…and does NOT exist at 180: it would run to 20:30, past closing", at180.includes("17:30"), false);
  check("…nor at 240", at240.includes("17:30"), false);
  check("a 16:00 start is legal at 180 (ends exactly at 19:00)", at180.includes("16:00"), true);
  check("…and illegal at 240 (would end at 20:00)", at240.includes("16:00"), false);
  check("15:00 is the last 240 start, ending exactly at closing", at240.includes("15:00"), true);
  check("15:30 is not", at240.includes("15:30"), false);

  // the end time is the length, measured on the slot the server would store
  const first240 = computeAvailability([], [], STUDIOS, WIN(240), []).free.find(
    (s) => s.room === GIVON && s.startIsrael === "09:00"
  );
  check("a 240 slot's own end is 13:00", first240?.endIsrael, "13:00");
  check("…and its instants are 240 minutes apart", durationFromRange(first240!.start.toISOString(), first240!.end.toISOString()), 240);

  // every length still refuses a closed day
  for (const m of BOOKING_DURATIONS) {
    const friday = computeAvailability([], [], STUDIOS, { ...WIN(m), fromIsrael: FRIDAY, toIsrael: FRIDAY }, []).free;
    check(`Friday offers nothing at ${m} minutes`, friday.length, 0);
  }

  // 🔴 and a long booking is blocked by an event it would REACH, not merely one
  // it starts inside. This is the whole reason the grid is recomputed per
  // length rather than filtered on the client.
  const busyAt1130 = computeAvailability(
    [
      busy(SUNDAY, [11, 30], [12, 30]),
    ],
    [],
    STUDIOS,
    WIN(240),
    []
  ).free.filter((s) => s.room === GIVON).map((s) => s.startIsrael);
  check("a 09:00 start is refused at 240 because 11:30 is busy — two and a half hours later", busyAt1130.includes("09:00"), false);
  const busyAt1130For90 = computeAvailability(
    [
      busy(SUNDAY, [11, 30], [12, 30]),
    ],
    [],
    STUDIOS,
    WIN(90),
    []
  ).free.filter((s) => s.room === GIVON).map((s) => s.startIsrael);
  check("…while the same 09:00 start is perfectly fine at 90", busyAt1130For90.includes("09:00"), true);
}

console.log("\n=== 5. the duration tag the owner's queue shows ===");
{
  const range = (dateIsrael: string, fromH: number, toH: number) => ({
    s: israelInstant(dateIsrael, fromH, 0).toISOString(),
    e: israelInstant(dateIsrael, toH, 0).toISOString(),
  });
  const r90 = { s: israelInstant(SUNDAY, 9, 0).toISOString(), e: israelInstant(SUNDAY, 10, 30).toISOString() };
  const r180 = range(SUNDAY, 9, 12);
  const r240 = range(SUNDAY, 9, 13);

  check("🔴 90 minutes gets NO tag — it is the majority and a badge on every row is noise", durationTag(r90.s, r90.e), null);
  check("180 gets '3 שעות'", durationTag(r180.s, r180.e), "3 שעות");
  check("240 gets '4 שעות'", durationTag(r240.s, r240.e), "4 שעות");
  check("an off-list length is shown raw rather than hidden", durationTag(range(SUNDAY, 9, 11).s, range(SUNDAY, 9, 11).e), "120 דק׳");
  check("a malformed range gets no tag", durationTag("nope", r90.e), null);
  check("a zero-length range gets no tag", durationTag(r90.s, r90.s), null);
  check("an inverted range gets no tag", durationTag(r90.e, r90.s), null);
  check("durationFromRange is plain minutes", durationFromRange(r180.s, r180.e), 180);
  // DST is not a special case here: both instants come from israelInstant, so
  // the difference is measured in real elapsed time either way.
  check("across the spring DST change the arithmetic is still elapsed minutes", durationFromRange(
    israelInstant("2027-03-26", 9, 0).toISOString(),
    israelInstant("2027-03-26", 12, 0).toISOString()
  ), 180);
}

console.log("\n=== 6. the notification recipients (WHATSAPP_NOTIFY_NUMBERS) ===");
{
  check("two numbers", parseNotifyNumbers("972501234567,972542242526"), ["972501234567", "972542242526"]);
  check("whitespace around entries is trimmed", parseNotifyNumbers(" 972501234567 , 972542242526 "), ["972501234567", "972542242526"]);
  check("one number", parseNotifyNumbers("972542242526"), ["972542242526"]);
  check("order is preserved", parseNotifyNumbers("972542242526,972501234567")[0], "972542242526");
  check("duplicates collapse — nobody gets the same message twice", parseNotifyNumbers("972501234567,972501234567"), ["972501234567"]);
  check("empty entries are skipped", parseNotifyNumbers("972501234567,,972542242526"), ["972501234567", "972542242526"]);
  check("a trailing comma is harmless", parseNotifyNumbers("972501234567,"), ["972501234567"]);

  // 🔴 VALIDATED, NOT SANITISED — the whatsappNumberFrom rule
  check("a leading + is REFUSED, not stripped", parseNotifyNumbers("+972501234567"), []);
  check("dashes are refused", parseNotifyNumbers("050-123-4567"), []);
  check("letters are refused", parseNotifyNumbers("abc"), []);
  check("too short is refused", parseNotifyNumbers("12345"), []);
  check("a good entry survives a bad neighbour", parseNotifyNumbers("+972501234567,972542242526"), ["972542242526"]);
  check("and the bad one is reported so it can be logged", rejectedNotifyNumbers("+972501234567,972542242526"), ["+972501234567"]);
  check("nothing rejected when all are clean", rejectedNotifyNumbers("972501234567"), []);

  check("unset -> no recipients", parseNotifyNumbers(undefined), []);
  check("empty -> no recipients", parseNotifyNumbers(""), []);
  check("only commas -> no recipients", parseNotifyNumbers(",,,"), []);
}

console.log("\n=== 7. the notification rows (dry run records, never sends) ===");
{
  const FACTS: BookingFacts = {
    showName: "דעה לא פופולרית",
    dateIsrael: SUNDAY,
    startIsrael: "09:00",
    endIsrael: "13:00",
    studio: GIVON,
    durationTag: "4 שעות",
    guest: "דנה לוי",
  };

  check("the when-phrase", whenPhrase(FACTS), "יום א׳ 27.9, 09:00–13:00");
  const approved = approvedNoticeBody(FACTS);
  check("the approved notice names the show, the slot, the room and the length", [
    approved.includes("דעה לא פופולרית"),
    approved.includes("09:00–13:00"),
    approved.includes(GIVON),
    approved.includes("4 שעות"),
    approved.includes("דנה לוי"),
  ], [true, true, true, true, true]);
  check("🔴 and it says 'אוטומטית' — the owner must know nobody pressed anything", approved.includes("אוטומטית"), true);

  const pending = pendingNoticeBody(FACTS, "second-same-day");
  check("the pending notice carries the reason", pending.includes("הזמנה שנייה באותו יום"), true);
  check("the calendar-failure reason", pendingNoticeBody(FACTS, "calendar-failed").includes("הכתיבה ליומן נכשלה"), true);
  check("the slot-taken reason", pendingNoticeBody(FACTS, "slot-taken").includes("המשבצת נתפסה ביומן"), true);
  check("and it points at the screen", pending.includes("מסך הבקשות"), true);

  // a standard-length booking still fills the parameter — a template parameter
  // may not be blank
  const plain = approvedNoticeBody({ ...FACTS, durationTag: null, guest: null });
  check("a 90-minute notice says 'שעה וחצי' rather than leaving a gap", plain.includes("שעה וחצי"), true);
  check("and a guestless one says 'בלי אורח'", plain.includes("בלי אורח"), true);
  check("no empty parameter slot survives into the body", plain.includes(", ."), false);

  // the rows
  const rows = buildNotificationRows({
    kind: "booking-approved",
    subjectId: "b-1",
    recipients: ["972501234567", "972542242526"],
    templateName: "bizi_booking_approved",
    params: ["x"],
    variables: { showName: "x" },
    body: approved,
    status: "dry_run",
  });
  check("one row per recipient", rows.length, 2);
  check("direction is out", rows.map((r) => r.direction), ["out", "out"]);
  check("🔴 status is dry_run — nothing was sent", rows.map((r) => r.status), ["dry_run", "dry_run"]);
  check("the template name travels with the row", rows[0].template_name, "bizi_booking_approved");
  check("the body is the rendered sentence", rows[0].body, approved);
  check("the payload carries the subject, the template, the POSITIONAL params and the variables", JSON.stringify(rows[0].payload), JSON.stringify({
    kind: "booking-approved",
    subject_id: "b-1",
    template: "bizi_booking_approved",
    language: "he",
    params: ["x"],
    variables: { showName: "x" },
    dry_run: true,
  }));
  check("a non-dry-run row says queued, and its payload says so too", (() => {
    const q = buildNotificationRows({
      kind: "booking-pending", subjectId: "b-1", recipients: ["972501234567"],
      templateName: "t", params: [], variables: {}, body: "x", status: "queued",
    })[0];
    return [q.status, (q.payload as { dry_run: boolean }).dry_run];
  })(), ["queued", false]);

  // 🔴 the de-dup key: one notification per booking per kind per recipient
  check("the wamid is deterministic", notificationWamid("booking-approved", "b-1", "972501234567"), "local:booking-approved:b-1:972501234567");
  check("…so a repeat of the same notice collides and is ignored", rows[0].wamid, notificationWamid("booking-approved", "b-1", "972501234567"));
  check("two recipients get two DIFFERENT keys", rows[0].wamid === rows[1].wamid, false);
  check("a different kind for the same booking is a different key", notificationWamid("booking-pending", "b-1", "972501234567") === notificationWamid("booking-approved", "b-1", "972501234567"), false);
  check("a different booking is a different key", notificationWamid("booking-approved", "b-2", "972501234567") === rows[0].wamid, false);
  check("'local:' prefixed so it can never collide with a real Meta wamid", rows[0].wamid.startsWith("local:"), true);
  check("…and 0101's wa_id cap is respected", rows.every((r) => Array.from(r.wa_id).length <= 32), true);
  // 0101's pair CHECK demands that an OUTBOUND row's status is anything but
  // 'received'. Asserted as membership in the two values the type permits
  // rather than as `!== "received"` — the latter is a comparison the compiler
  // proves vacuous (TS2367), and an assertion the compiler can prove is an
  // assertion that is not testing the runtime.
  check(
    "…as is the pair CHECK: every outbound status is one of the two it allows",
    rows.every((r) => (["dry_run", "queued"] as string[]).includes(r.status)),
    true
  );
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
