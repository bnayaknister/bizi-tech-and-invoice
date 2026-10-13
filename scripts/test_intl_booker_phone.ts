/**
 * B27 — a booker with an international number, and the one phone rule.
 *
 * The case that opened it: LEAH (+1 904 240 6207, USA), booker on "פודקאסט אילון
 * לוי", wrote to the bot on 13.10 and the owner was told "unknown number".
 * Diagnosis: her row was stored correctly (19042406207) — it was ADDED four
 * minutes AFTER she wrote (14:05:36 message, 14:09:53 booking_contact_added).
 * This suite pins the rule so that stays true: wa_id = digits only, country
 * code first, no `+`; `+`/`00` = the country is already written; a lone 0 =
 * Israel; 8..15 digits.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_intl_booker_phone.ts
 *
 * ═══ F19 ═══
 * No database, no network. The database is scripts/_fake_db.ts; `global.fetch`
 * throws; WHATSAPP_DRY_RUN is forced on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDb, REGISTRATION_UNIQUES, type Row } from "./_fake_db";
import { toWaId, isWaId, waIdFromProvider, displayWaId, PHONE_ERROR } from "../src/lib/whatsapp/phone";
import { normalizeWaId, parseInboundMessages } from "../src/lib/whatsapp/webhook";
import { validateBooker } from "../src/lib/booking/bookers";
import { validateRegistration } from "../src/lib/registration/validate";
import { showsForNumber } from "../src/lib/booking/contacts";
import { replyToInbound } from "../src/lib/whatsapp/reply";

process.env.WHATSAPP_DRY_RUN = "true";
process.env.WHATSAPP_NOTIFY_NUMBERS = "972500000001";
process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
delete process.env.WHATSAPP_BOOKING_FLOW;
delete process.env.WHATSAPP_BILINGUAL;
delete process.env.REGISTRATION_ENABLED;
global.fetch = (async (url: string) => {
  throw new Error("F19: this suite must not perform any fetch: " + url);
}) as unknown as typeof fetch;

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
const section = (t: string) => console.log(`\n── ${t}`);

const US = "19042406207";
const IL = "972506616162";

async function main() {
  section("1. the owner's inputs (B27 step 1c)");
  check("+19042406207", toWaId("+19042406207"), { ok: true, waId: US });
  check("19042406207 (already a wa_id)", toWaId("19042406207"), { ok: true, waId: US });
  check("001-904-240-6207 (00 prefix)", toWaId("001-904-240-6207"), { ok: true, waId: US });
  check("050-6616162", toWaId("050-6616162"), { ok: true, waId: IL });
  check("+972506616162", toWaId("+972506616162"), { ok: true, waId: IL });
  check("972506616162", toWaId("972506616162"), { ok: true, waId: IL });
  check("0506616162", toWaId("0506616162"), { ok: true, waId: IL });

  section("2. more shapes");
  check("UK +447700900123", toWaId("+447700900123"), { ok: true, waId: "447700900123" });
  check("UK with spaces +44 7700 900123", toWaId("+44 7700 900123"), { ok: true, waId: "447700900123" });
  check("US as a contact card writes it: +1 (904) 240-6207", toWaId("+1 (904) 240-6207"), { ok: true, waId: US });
  check("an international number is never prefixed with 972", toWaId("+19042406207").ok && !(toWaId("+19042406207") as { waId: string }).waId.startsWith("972"), true);
  check("+972 (0)50-661-6162: the trunk zero after 972 is dropped", toWaId("+972 (0)50-661-6162"), { ok: true, waId: IL });
  check("9720506616162 likewise", toWaId("9720506616162"), { ok: true, waId: IL });
  check("a landline 03-1234567 is unchanged (Israeli rule as before)", toWaId("03-1234567"), { ok: true, waId: "97231234567" });

  section("3. refusals");
  check("+0501234567: a 0 after + is not Israeli, it is malformed", toWaId("+0501234567"), { ok: false, reason: "not-a-number" });
  check("000501234567 likewise", toWaId("000501234567"), { ok: false, reason: "not-a-number" });
  check("7 digits (was accepted before B27) -> too short", toWaId("1234567"), { ok: false, reason: "too-short" });
  check("+1234567 -> too short", toWaId("+1234567"), { ok: false, reason: "too-short" });
  check("8 digits is the floor", toWaId("12345678"), { ok: true, waId: "12345678" });
  check("15 digits is the ceiling", toWaId("+123456789012345"), { ok: true, waId: "123456789012345" });
  check("16 digits -> too long", toWaId("+1234567890123456"), { ok: false, reason: "too-long" });
  check("letters -> not-digits", toWaId("+1 904 CALL ME"), { ok: false, reason: "not-digits" });
  check("a + alone", toWaId("+"), { ok: false, reason: "not-a-number" });
  check("Israeli: too short as before", toWaId("05012"), { ok: false, reason: "too-short" });
  check("the refusal sentence now names the international form", PHONE_ERROR["not-a-number"].includes("+"), true);

  section("4. display round trip (what the editor shows re-converts to the same row)");
  for (const input of ["+19042406207", "+447700900123", "050-6616162"]) {
    const a = toWaId(input);
    const b = a.ok ? toWaId(displayWaId(a.waId)) : null;
    check(`round trip ${input}`, a.ok && b?.ok && b.waId === a.waId, true);
  }
  check("US displays with +", displayWaId(US), "+19042406207");

  section("5. the provider gate (what Meta sends) shares the rule");
  check("normalizeWaId IS waIdFromProvider (one definition)", normalizeWaId === waIdFromProvider, true);
  check("Meta's US wa_id", normalizeWaId(US), US);
  check("with a + tolerated", normalizeWaId("+" + US), US);
  check("a leading 0 is not a wa_id", normalizeWaId("0501234567"), null);
  check("isWaId refuses 7 digits", isWaId("1234567"), false);
  check("isWaId accepts the US number", isWaId(US), true);

  section("6. every editor stores the same value (show screen, client card, /join)");
  const booker = validateBooker({ name: "LEAH", phone: "+19042406207", email: "" });
  check("show screen bookers editor: +19042406207 -> 19042406207", booker, { ok: true, value: { name: "LEAH", waId: US, email: null } });
  const reg = validateRegistration({ phone: "+1 904 240 6207", booking1Phone: "001-904-240-6207", booking2Phone: "+447700900123", booking2Name: "x" }, null);
  const errs = (reg as { errors?: Record<string, string> }).errors ?? {};
  check("/join: no phone error on any of the three international fields", [errs.phone, errs.booking1Phone, errs.booking2Phone], [undefined, undefined, undefined]);
  // the client card route has no pure validator of its own: it must call toWaId
  const routeSrc = readFileSync(join(__dirname, "../src/app/api/clients/[id]/booking-contacts/route.ts"), "utf8");
  check("client card route normalises with toWaId (static)", /toWaId\(body\.phone\)/.test(routeSrc), true);

  section("7. the bot recognises a US booker stored from +19042406207");
  const parsed = parseInboundMessages({
    object: "whatsapp_business_account",
    entry: [{ id: "W", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "972500000000", phone_number_id: "P" },
      contacts: [{ profile: { name: "LEAH" }, wa_id: US }],
      messages: [{ from: US, id: "wamid.B27", timestamp: "1760000000", type: "text", text: { body: "Hi, availability on the 21st?" } }],
    } }] }],
  });
  check("Meta's message parses to the US wa_id", parsed.map((m) => m.waId), [US]);

  const SHOW = { id: "s-eilon", name: "פודקאסט אילון לוי", aliases: ["אילון לוי"], client_id: "c1", default_studio: "גבעון", billing_mode: "per_episode" };
  const stored = (booker as { value: { waId: string } }).value.waId;
  const world = () =>
    fakeDb(
      {
        shows: [{ ...SHOW }],
        clients: [{ id: "c1", status: "active", morning_client_id: "m1" }],
        booking_contacts: [
          { id: "bc-leah", show_id: SHOW.id, name: "LEAH", wa_id: stored, email: null, shows: SHOW },
          { id: "bc-eilon", show_id: SHOW.id, name: "אילון", wa_id: IL, email: null, shows: SHOW },
        ],
        booking_links: [],
        client_registrations: [],
        wa_messages: [],
        wa_contact_prefs: [{ wa_id: US, lang: "en" }],
        registration_links: [],
        events: [],
      } as Record<string, Row[]>,
      { unique: REGISTRATION_UNIQUES }
    );
  {
    const { client } = world();
    check("showsForNumber(US) finds her show", (await showsForNumber(client as never, parsed[0].waId!)).map((s) => s.showName), [SHOW.name]);
  }
  {
    const { client, store } = world();
    await replyToInbound(client as never, new Request("https://app.example/api/wa/webhook"), parsed[0]);
    const msgs = store.wa_messages as (Row & { wa_id: string; template_name: string | null; body: string })[];
    check("no 'unknown number' notice to the owner", msgs.filter((m) => m.template_name === "bizi_unknown_contact").length, 0);
    check("she gets the booking link", /https:\/\/app\.example\/b\/[A-Za-z0-9_-]{20,}/.test(msgs.find((m) => m.wa_id === US)?.body ?? ""), true);
  }
  {
    // the 13.10 sequence: she writes BEFORE the row exists -> unknown is correct
    const { client, store } = world();
    store.booking_contacts = store.booking_contacts.filter((r) => r.id !== "bc-leah");
    await replyToInbound(client as never, new Request("https://app.example/api/wa/webhook"), { ...parsed[0], wamid: "wamid.B27b" });
    const msgs = store.wa_messages as (Row & { template_name: string | null })[];
    check("before she is added: the owner IS told (what happened on 13.10)", msgs.some((m) => m.template_name === "bizi_unknown_contact"), true);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
