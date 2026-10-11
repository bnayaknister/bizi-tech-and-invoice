/**
 * E17-4 — the registration page's server half: validation, the link, the
 * submission, the duplicate check, the pending row's name, the spam brakes and
 * the notice that is not sent while Meta has not approved it. Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_registration.ts
 *
 * ═══ F19 ═══
 * No database, no network, no WhatsApp, no Morning. The database is
 * scripts/_fake_db.ts — it filters and enforces 0001/0107's unique indexes, so
 * "the name is taken" and "single use" are exercised against a real refusal.
 * `global.fetch` throws. WHATSAPP_DRY_RUN is forced on.
 */
import { fakeDb, REGISTRATION_UNIQUES, type Row } from "./_fake_db";
import {
  FIELD_ERROR,
  lockedNumberTampered,
  normalizeEmail,
  normalizeTaxId,
  validateRegistration,
} from "../src/lib/registration/validate";
import {
  REGISTRATION_LINK_TTL_MS,
  ensureRegistrationLinkForWaId,
  isLinkLive,
  registrationUrl,
  resolveRegistrationLink,
} from "../src/lib/registration/links";
import { RATE_MAX_PER_IP, RATE_MAX_PER_LINK, clientIpFrom, hashIp, submitRegistration } from "../src/lib/registration/submit";
import {
  EXISTING_CLAIM_EXCERPT,
  NOT_GIVEN,
  REGISTRATION_EVENT_LABEL,
  TEMPLATE_CLIENT_REGISTRATION,
  TEMPLATE_CLIENT_REGISTRATION_TEXT,
  TEMPLATE_CLIENT_REGISTRATION_VARS,
  TEMPLATE_META_APPROVED,
  isTemplateApproved,
  notifyClientRegistration,
  templatePlaceholders,
} from "../src/lib/whatsapp/notify";
import { isRegistrationEnabled } from "../src/lib/registration/switch";
import { canCreateRegistrationLink } from "../src/lib/clients/access";
import { PRIVACY_UPDATED_AT } from "../src/lib/legal/privacy";
import type { Profile } from "../src/lib/profile";

process.env.WHATSAPP_DRY_RUN = "true";
process.env.WHATSAPP_NOTIFY_NUMBERS = "972500000001,972500000002";
delete process.env.REGISTRATION_ENABLED;
global.fetch = (() => {
  throw new Error("F19: this suite must not perform any fetch");
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

const NOW = new Date("2026-10-11T10:00:00Z");
const BOT_WA = "972501234567";
const TOK = (c: string) => c.repeat(43);

const GOOD: Record<string, unknown> = {
  legalName: "סטודיו גל אורן בע״מ",
  taxId: "514-000-001",
  emails: ["Gal@Example.com"],
  phone: "050-765-4321",
  contactName: "גל",
  address: "",
  podcastName: "הפודקאסט של גל",
  booking1Name: "גל",
  booking1Phone: "050-111-2222",
  booking2Name: "",
  booking2Phone: "",
  privacyAccepted: true,
  website: "",
};

function linkRow(over: Partial<Row> = {}): Row {
  return {
    id: crypto.randomUUID(),
    token: TOK("A"),
    wa_id: null,
    created_by: null,
    created_at: "2026-10-10T10:00:00Z",
    expires_at: "2026-10-17T10:00:00Z",
    used_at: null,
    revoked_at: null,
    ...over,
  };
}

function world(links: Row[], clients: Row[] = []) {
  return fakeDb(
    { registration_links: links, clients, client_registrations: [], events: [], wa_messages: [] },
    { unique: REGISTRATION_UNIQUES, now: () => NOW }
  );
}

async function main() {
  // ═══ 0. the switch ═══════════════════════════════════════════════════════
  section("0. the switch (rule 40)");
  check("unset = off", isRegistrationEnabled(), false);
  process.env.REGISTRATION_ENABLED = "TRUE";
  check("'TRUE' is not 'true' = off", isRegistrationEnabled(), false);
  process.env.REGISTRATION_ENABLED = "true";
  check("exactly 'true' = on", isRegistrationEnabled(), true);
  delete process.env.REGISTRATION_ENABLED;
  const p: Profile = {
    id: "u", name: "x", email: "x@x", role: "owner", approved: true, can_view_money: true, can_edit_money: true,
    can_view_stages: true, can_edit_stages: true, can_manage_users: true, can_import: true, studio_admin: true,
  };
  check("manual link: studio_admin + switch on", canCreateRegistrationLink(p, true), true);
  check("manual link: switch off -> no", canCreateRegistrationLink(p, false), false);
  check("manual link: not studio_admin -> no", canCreateRegistrationLink({ ...p, studio_admin: false }, true), false);

  // ═══ 1. validation, field by field ═══════════════════════════════════════
  section("1. validation — every field");
  const ok = validateRegistration(GOOD, null);
  check("a good body passes", ok.ok, true);
  if (ok.ok) {
    check("ח.פ: dashes stripped", ok.value.taxId, "514000001");
    check("email lower-cased", ok.value.emails, ["gal@example.com"]);
    check("phone -> wa_id", ok.value.phone, "972507654321");
    check("booking 1 -> wa_id", ok.value.booking1, { name: "גל", waId: "972501112222" });
    check("empty address -> null", ok.value.address, null);
    check("no second number -> null", ok.value.booking2, null);
  }
  const err = (over: Record<string, unknown>, lock: string | null = null) => {
    const r = validateRegistration({ ...GOOD, ...over }, lock);
    return r.ok ? {} : r.errors;
  };
  check("legal name: empty", err({ legalName: "  " }).legalName, FIELD_ERROR.legalName);
  check("legal name: 201 chars", err({ legalName: "א".repeat(201) }).legalName, FIELD_ERROR.legalName);
  check("legal name: 200 chars passes", err({ legalName: "א".repeat(200) }).legalName, undefined);
  check("tax id: 8 digits", err({ taxId: "12345678" }).taxId, FIELD_ERROR.taxId);
  check("tax id: letters", err({ taxId: "51400000a" }).taxId, FIELD_ERROR.taxId);
  check("tax id: spaces stripped", normalizeTaxId(" 514 000 001 "), "514000001");
  check("tax id: a number (not a string) refused", normalizeTaxId(514000001), null);
  check("emails: none", err({ emails: [] }).emails, FIELD_ERROR.emailRequired);
  check("emails: only blanks", err({ emails: ["", " "] }).emails, FIELD_ERROR.emailRequired);
  check("emails: malformed", err({ emails: ["gal@"] }).emails, FIELD_ERROR.email);
  check("emails: a comma inside (0107 CHECK splits on it)", normalizeEmail("a,b@c.de"), null);
  check("emails: duplicate after lower-casing", err({ emails: ["a@b.co", "A@B.CO"] }).emails, FIELD_ERROR.emailDuplicate);
  check("emails: four", err({ emails: ["a@b.co", "c@d.co", "e@f.co", "g@h.co"] }).emails, FIELD_ERROR.tooManyEmails);
  check("emails: three pass", err({ emails: ["a@b.co", "c@d.co", "e@f.co"] }).emails, undefined);
  check("phone: missing", err({ phone: "" }).phone, "חסר מספר טלפון.");
  check("phone: too short", err({ phone: "0501" }).phone !== undefined, true);
  check("contact name: optional", err({ contactName: "" }).contactName, undefined);
  check("contact name: 121 chars", err({ contactName: "א".repeat(121) }).contactName, FIELD_ERROR.contactName);
  check("address: 301 chars", err({ address: "א".repeat(301) }).address, FIELD_ERROR.address);
  check("podcast: empty", err({ podcastName: "" }).podcastName, FIELD_ERROR.podcastName);
  check("booking 1: no name", err({ booking1Name: "" }).booking1Name, FIELD_ERROR.bookingName);
  check("booking 1: no phone (manual link)", err({ booking1Phone: "" }).booking1Phone, "חסר מספר טלפון.");
  check("booking 2: name without phone", err({ booking2Name: "דנה" }).booking2Phone, FIELD_ERROR.bookingPair);
  check("booking 2: phone without name", err({ booking2Phone: "0502223333" }).booking2Phone, FIELD_ERROR.bookingPair);
  check("booking 2: same as booking 1", err({ booking2Name: "דנה", booking2Phone: "050-111-2222" }).booking2Phone, FIELD_ERROR.bookingSame);
  check("privacy: not ticked", err({ privacyAccepted: false }).privacy, FIELD_ERROR.privacy);
  check("privacy: the STRING 'true' is not a tick", err({ privacyAccepted: "true" }).privacy, FIELD_ERROR.privacy);
  {
    const r = validateRegistration({ ...GOOD, booking1Phone: undefined }, BOT_WA);
    check("bot link: booking 1 IS the link's number", r.ok && r.value.booking1.waId, BOT_WA);
    check("bot link: booking 2 equal to the locked number refused", err({ booking2Name: "x", booking2Phone: "0501234567" }, BOT_WA).booking2Phone, FIELD_ERROR.bookingSame);
    check("tamper: no number sent = fine", lockedNumberTampered({}, BOT_WA), false);
    check("tamper: the same number in another format = fine", lockedNumberTampered({ booking1Phone: "050-123-4567" }, BOT_WA), false);
    check("tamper: another number = tampered", lockedNumberTampered({ booking1Phone: "0509999999" }, BOT_WA), true);
  }

  // ═══ 2. the link ═════════════════════════════════════════════════════════
  section("2. the link — every dead state is the same answer");
  check("live", isLinkLive({ used_at: null, revoked_at: null, expires_at: "2026-10-12T00:00:00Z" }, NOW), true);
  check("url shape", registrationUrl("https://x.app/", TOK("A")), `https://x.app/join/${TOK("A")}`);
  {
    const states = {
      ok: linkRow({ token: TOK("A") }),
      expired: linkRow({ token: TOK("B"), expires_at: "2026-10-11T09:59:59Z" }),
      used: linkRow({ token: TOK("C"), used_at: "2026-10-11T09:00:00Z" }),
      revoked: linkRow({ token: TOK("D"), revoked_at: "2026-10-11T09:00:00Z" }),
    };
    const { client } = world(Object.values(states));
    const r = async (t: string) => (await resolveRegistrationLink(client, t, NOW)).status;
    check("live token -> ok", await r(TOK("A")), "ok");
    check("expired -> invalid", await r(TOK("B")), "invalid");
    check("used -> invalid", await r(TOK("C")), "invalid");
    check("revoked -> invalid", await r(TOK("D")), "invalid");
    check("never existed -> invalid", await r(TOK("Z")), "invalid");
    check("malformed -> invalid", await r("short!"), "invalid");
  }
  {
    const { client, store } = world([]);
    const a = await ensureRegistrationLinkForWaId(client, BOT_WA, NOW);
    const b = await ensureRegistrationLinkForWaId(client, BOT_WA, NOW);
    check("bot: the first call mints", a.ok && a.created, true);
    check("bot: the second returns THE SAME link", b.ok && !b.created && a.ok && b.token === a.token, true);
    check("bot: one row for the number", store.registration_links.length, 1);
    const row = store.registration_links[0];
    check("bot: 7 days", new Date(row.expires_at as string).getTime() - NOW.getTime(), REGISTRATION_LINK_TTL_MS);
    // once used, the number gets a fresh one
    row.used_at = NOW.toISOString();
    const c = await ensureRegistrationLinkForWaId(client, BOT_WA, NOW);
    check("bot: a used link is not handed back", c.ok && c.created && a.ok && c.token !== a.token, true);
  }

  // ═══ 3. submission ═══════════════════════════════════════════════════════
  section("3. submission — token states all land on 'dead'");
  for (const [name, over] of [
    ["expired", { expires_at: "2026-10-11T09:00:00Z" }],
    ["used", { used_at: "2026-10-11T09:00:00Z" }],
    ["revoked", { revoked_at: "2026-10-11T09:00:00Z" }],
  ] as const) {
    const { client, store } = world([linkRow(over)]);
    const out = await submitRegistration(client, { token: TOK("A"), body: GOOD, ip: "1.1.1.1", now: NOW });
    check(`${name} -> dead`, out, { kind: "dead" });
    check(`${name}: nothing written`, [store.clients.length, store.client_registrations.length], [0, 0]);
  }
  {
    const { client } = world([linkRow()]);
    check("unknown token -> dead", await submitRegistration(client, { token: TOK("Q"), body: GOOD, ip: null, now: NOW }), { kind: "dead" });
  }
  {
    const { client, store } = world([linkRow({ wa_id: BOT_WA })]);
    const out = await submitRegistration(client, { token: TOK("A"), body: { ...GOOD, booking1Phone: "0509999999" }, ip: null, now: NOW });
    check("a bot link with ANOTHER number -> dead (same screen)", out, { kind: "dead" });
    check("…and nothing written", store.client_registrations.length, 0);
  }

  section("3b. a new registration");
  {
    const link = linkRow({ wa_id: BOT_WA });
    const { client, store } = world([link]);
    const out = await submitRegistration(client, { token: TOK("A"), body: { ...GOOD, booking1Phone: undefined }, ip: "1.1.1.1", now: NOW });
    check("thanks", out, { kind: "thanks" });
    const c = store.clients[0];
    const reg = store.client_registrations[0];
    check("one pending client", [store.clients.length, c?.status], [1, "pending"]);
    check("its name is exactly what was typed", c?.name, GOOD.legalName);
    check("its normalized_name is the pending marker", c?.normalized_name, `pending:${reg?.id}`);
    check("no ח.פ on the pending client (written on approval)", c?.tax_id ?? null, null);
    check("registration: pending, pointing at that client", [reg?.status, reg?.client_id], ["pending", c?.id]);
    check("registration: source bot, number verified", [reg?.source, reg?.booking_wa_id_1, reg?.booking_wa_id_1_verified], ["bot", BOT_WA, true]);
    check("registration: privacy version + time", [reg?.privacy_version, reg?.privacy_accepted_at], [PRIVACY_UPDATED_AT, NOW.toISOString()]);
    check("the token is burnt", link.used_at, NOW.toISOString());
    const ev = store.events.map((e) => e.event_type);
    check("events: attempt, created, notice skipped (template not approved)", ev, [
      "registration_submit_attempt",
      "client_registration_created",
      "notification_skipped_template_unapproved",
    ]);
    check("🔴 template not approved -> NO WhatsApp row at all", store.wa_messages.length, 0);
    const again = await submitRegistration(client, { token: TOK("A"), body: GOOD, ip: "1.1.1.1", now: NOW });
    check("the same link again -> dead", again, { kind: "dead" });
  }
  {
    const { client, store } = world([linkRow()]);
    await submitRegistration(client, { token: TOK("A"), body: GOOD, ip: null, now: NOW });
    const reg = store.client_registrations[0];
    check("manual link: source web, number NOT verified", [reg?.source, reg?.booking_wa_id_1_verified], ["web", false]);
  }

  section("3c. 🔴 the name is taken — the registration still goes in");
  {
    const existing = { id: "c-old", name: "סטודיו גל אורן בע״מ", normalized_name: "סטודיו גל אורן בע״מ", status: "active", tax_id: null };
    const { client, store } = world([linkRow(), linkRow({ token: TOK("B") })], [existing]);
    const a = await submitRegistration(client, { token: TOK("A"), body: GOOD, ip: null, now: NOW });
    const b = await submitRegistration(client, { token: TOK("B"), body: { ...GOOD, taxId: "514000009" }, ip: null, now: NOW });
    check("same name as an active client -> thanks", a, { kind: "thanks" });
    check("and a second registration of that name too", b, { kind: "thanks" });
    check("three rows with that name, no unique violation", store.clients.filter((c) => c.name === existing.name).length, 3);
    check("the active client untouched", store.clients[0], existing);
  }

  section("3d. duplicate by ח.פ");
  {
    const card = { id: "c-card", name: "גל אורן", normalized_name: "גל אורן", status: "active", tax_id: "514000001" };
    const { client, store } = world([linkRow()], [card]);
    const out = await submitRegistration(client, { token: TOK("A"), body: GOOD, ip: null, now: NOW });
    check("SAME screen as a new one", out, { kind: "thanks" });
    check("no client created", store.clients.length, 1);
    const reg = store.client_registrations[0];
    check("registration: duplicate -> the card", [reg?.status, reg?.duplicate_of_client_id, reg?.client_id], ["duplicate", "c-card", null]);
    check("the token is burnt", store.registration_links[0].used_at, NOW.toISOString());
    const skipped = store.events.find((e) => e.event_type === "notification_skipped_template_unapproved");
    check("the skipped notice names the duplicate event", (skipped?.payload as { event?: string })?.event, "duplicate");
  }
  {
    const pendingSame = { id: "c-p", name: "x", normalized_name: "pending:x", status: "pending", tax_id: "514000001" };
    const { client, store } = world([linkRow()], [pendingSame]);
    await submitRegistration(client, { token: TOK("A"), body: GOOD, ip: null, now: NOW });
    check("a PENDING client with that ח.פ is not a match (active only)", store.client_registrations[0]?.status, "pending");
  }

  section("3e. honeypot and rate limits");
  {
    const { client, store } = world([linkRow()]);
    const out = await submitRegistration(client, { token: TOK("A"), body: { ...GOOD, website: "http://spam" }, ip: "9.9.9.9", now: NOW });
    check("honeypot -> the same thanks", out, { kind: "thanks" });
    check("…nothing kept", [store.clients.length, store.client_registrations.length], [0, 0]);
    check("…token NOT burnt (a person can still use it)", store.registration_links[0].used_at, null);
    check("…and logged", store.events.map((e) => e.event_type).includes("registration_honeypot"), true);
  }
  {
    const link = linkRow();
    const prior: Row[] = Array.from({ length: RATE_MAX_PER_IP }, (_, i) => ({
      id: `e${i}`, entity_type: "registration_link", entity_id: `other-${i}`, event_type: "registration_submit_attempt",
      payload: { ip_hash: hashIp("5.5.5.5") }, created_at: "2026-10-11T09:55:00Z",
    }));
    const { client, store } = fakeDb(
      { registration_links: [link], clients: [], client_registrations: [], events: prior, wa_messages: [] },
      { unique: REGISTRATION_UNIQUES, now: () => NOW }
    );
    check(`${RATE_MAX_PER_IP} attempts from one IP -> slow`, await submitRegistration(client, { token: TOK("A"), body: GOOD, ip: "5.5.5.5", now: NOW }), { kind: "slow" });
    check("another IP is not slowed", await submitRegistration(client, { token: TOK("A"), body: GOOD, ip: "6.6.6.6", now: NOW }), { kind: "thanks" });
    check("nothing written for the slowed one", store.client_registrations.length, 1);
  }
  {
    const link = linkRow();
    const prior: Row[] = Array.from({ length: RATE_MAX_PER_LINK }, (_, i) => ({
      id: `e${i}`, entity_type: "registration_link", entity_id: link.id, event_type: "registration_submit_attempt",
      payload: { ip_hash: hashIp(`7.7.7.${i}`) }, created_at: "2026-10-11T09:55:00Z",
    }));
    const { client } = fakeDb(
      { registration_links: [link], clients: [], client_registrations: [], events: prior, wa_messages: [] },
      { unique: REGISTRATION_UNIQUES, now: () => NOW }
    );
    check(`${RATE_MAX_PER_LINK} attempts on one link -> slow`, await submitRegistration(client, { token: TOK("A"), body: GOOD, ip: "8.8.8.8", now: NOW }), { kind: "slow" });
  }
  {
    const old: Row[] = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`, entity_type: "registration_link", entity_id: "x", event_type: "registration_submit_attempt",
      payload: { ip_hash: hashIp("5.5.5.5") }, created_at: "2026-10-11T09:00:00Z",
    }));
    const { client } = fakeDb(
      { registration_links: [linkRow()], clients: [], client_registrations: [], events: old, wa_messages: [] },
      { unique: REGISTRATION_UNIQUES, now: () => NOW }
    );
    check("attempts older than the window do not count", await submitRegistration(client, { token: TOK("A"), body: GOOD, ip: "5.5.5.5", now: NOW }), { kind: "thanks" });
  }
  {
    const { client } = fakeDb(
      { registration_links: [linkRow()], clients: [], client_registrations: [], events: [], wa_messages: [] },
      { unique: REGISTRATION_UNIQUES, now: () => NOW, failOn: { events: ["select"] } }
    );
    check("a failed rate count is a refusal, not a pass", await submitRegistration(client, { token: TOK("A"), body: GOOD, ip: null, now: NOW }), { kind: "error" });
  }
  {
    const { client, store } = world([linkRow()]);
    const out = await submitRegistration(client, { token: TOK("A"), body: { ...GOOD, taxId: "1" }, ip: null, now: NOW });
    check("field errors come back for a live link", out.kind === "invalid" && out.errors.taxId, FIELD_ERROR.taxId);
    check("…and the token is NOT burnt", store.registration_links[0].used_at, null);
  }
  {
    // the registration insert fails: no half-state
    const { client, store } = fakeDb(
      { registration_links: [linkRow()], clients: [], client_registrations: [], events: [], wa_messages: [] },
      { unique: REGISTRATION_UNIQUES, now: () => NOW, failOn: { client_registrations: ["insert"] } }
    );
    const out = await submitRegistration(client, { token: TOK("A"), body: GOOD, ip: null, now: NOW });
    check("registration insert fails -> error", out, { kind: "error" });
    check("…and the pending client is removed again", store.clients.length, 0);
    check("…and the token is not burnt", store.registration_links[0].used_at, null);
  }
  check("ip: first x-forwarded-for hop", clientIpFrom(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" })), "1.2.3.4");
  check("ip: x-real-ip fallback", clientIpFrom(new Headers({ "x-real-ip": "5.6.7.8" })), "5.6.7.8");
  check("ip: never stored raw", hashIp("1.2.3.4").includes("1.2.3.4"), false);

  // ═══ 4. the template and its approval gate ═══════════════════════════════
  section("4. bizi_client_registration — text, variables, approval gate");
  check("placeholders 1..5 in order", templatePlaceholders(TEMPLATE_CLIENT_REGISTRATION_TEXT), [1, 2, 3, 4, 5]);
  check("five named variables", TEMPLATE_CLIENT_REGISTRATION_VARS.length, 5);
  check("does not start or end with a variable", [TEMPLATE_CLIENT_REGISTRATION_TEXT.startsWith("{{"), TEMPLATE_CLIENT_REGISTRATION_TEXT.endsWith("}}")], [false, false]);
  check("the three event labels match the submitted doc", Object.values(REGISTRATION_EVENT_LABEL), [
    "נרשם לקוח חדש והוא ממתין לאישור",
    "הרשמה חדשה הותאמה לכרטיס קיים",
    "מספר לא משויך כתב בבוט שהוא כבר לקוח",
  ]);
  check("NOT approved by default", isTemplateApproved(TEMPLATE_CLIENT_REGISTRATION), false);
  check("an unlisted template is not approved", isTemplateApproved("bizi_anything_new"), false);
  check("the four live templates keep sending", ["bizi_booking_approved", "bizi_booking_pending", "bizi_unknown_contact", "bizi_booking_change"].map(isTemplateApproved), [true, true, true, true]);
  {
    const { client, store } = world([]);
    const r = await notifyClientRegistration(client, {
      event: "existing-claim", subjectId: "existing-claim:x:2026-10-11", registrationId: null, name: null, podcast: null, waId: BOT_WA, details: "d",
    });
    check("existing-claim, unapproved -> falls back to bizi_unknown_contact", r.fallback, "unknown-contact");
    check("…ONE row, to the owner only", store.wa_messages.map((m) => [m.template_name, m.wa_id]), [["bizi_unknown_contact", "972500000001"]]);
    check("…saying what happened", (store.wa_messages[0]?.payload as { params?: string[] })?.params?.[1], EXISTING_CLAIM_EXCERPT);
  }
  {
    TEMPLATE_META_APPROVED.bizi_client_registration = true;
    const { client, store } = world([]);
    const input = {
      event: "existing-claim" as const, subjectId: "existing-claim:x:2026-10-11", registrationId: null, name: null, podcast: null, waId: BOT_WA, details: "d",
    };
    await notifyClientRegistration(client, input);
    await notifyClientRegistration(client, input);
    check("approved -> the registration template, to BOTH", store.wa_messages.map((m) => m.template_name), [TEMPLATE_CLIENT_REGISTRATION, TEMPLATE_CLIENT_REGISTRATION]);
    check("…a second call for the same subject sends nothing more", store.wa_messages.length, 2);
    const params = (store.wa_messages[0]?.payload as { params?: string[] })?.params;
    check("…empty name/podcast become 'לא נמסר', phone displayed", params?.slice(1, 4), [NOT_GIVEN, NOT_GIVEN, "050-123-4567"]);
    TEMPLATE_META_APPROVED.bizi_client_registration = false;
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
