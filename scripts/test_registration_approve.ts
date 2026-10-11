/**
 * E17-5 — approving, attaching and rejecting registrations, the purge, the
 * first-booking flag, and who may do any of it. Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_registration_approve.ts
 *
 * ═══ F19 ═══
 * No database, no network, no Morning, no WhatsApp. The database is
 * scripts/_fake_db.ts; the 0108 functions are stood in for by fakes that do
 * what the SQL does (the SQL itself was proved by 0108_dryrun on a local
 * Postgres and by the owner's dryrun on production). Morning is a fake port
 * that COUNTS its calls — "no duplicate in Morning" is asserted as a count.
 * `global.fetch` throws. WHATSAPP_DRY_RUN is on.
 *
 * ═══ THE ORDER UNDER TEST (approve.ts header) ═══
 *   checks -> Morning id (saved row | chosen link | found by ח.פ | create)
 *   -> id persisted on the pending row -> the transaction -> the message.
 * Each step is failed in turn, then retried, and Morning's create count must
 * stay at one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDb, REGISTRATION_UNIQUES, type Row } from "./_fake_db";
import {
  approveRegistration,
  attachRegistration,
  e17Code,
  morningFieldOf,
  rejectRegistration,
  runRegistrationPurge,
  validateApprovalInput,
  type MorningPort,
} from "../src/lib/registration/approve";
import { autoApproveNewRequest, autoApproveVerdict, lowerFirstBookingFlag } from "../src/lib/booking/decide";
import { PENDING_REASON_LABEL, TEMPLATE_META_APPROVED } from "../src/lib/whatsapp/notify";
import { TEMPLATE_EN_APPROVED } from "../src/lib/whatsapp/lang";
import { POPUP_RECHECK_MS, nextPopupState, popupTitle, shouldRecheck } from "../src/components/RegistrationsPopup";
import { RATE_REQUIRED_ERROR, perEpisodeRateError } from "../src/lib/registration/rate";
import { registrationsBadge } from "../src/modules/clients";
import { normalizeClientName } from "../src/lib/clients/match";

process.env.WHATSAPP_DRY_RUN = "true";
process.env.WHATSAPP_NOTIFY_NUMBERS = "972500000001,972500000002";
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

// ─── the fake Morning ───────────────────────────────────────────────────────
function fakeMorning(opts: { dryRun?: boolean; existing?: { id: string; name: string; taxId: string }[]; createFails?: string; listFails?: boolean } = {}) {
  const state = { creates: 0, lists: 0, clients: [...(opts.existing ?? [])], createFails: opts.createFails ?? null, dryRun: !!opts.dryRun, listFails: !!opts.listFails };
  const port: MorningPort = {
    isDryRun: () => state.dryRun,
    listClients: async () => {
      state.lists++;
      if (state.listFails) throw new Error("Morning unreachable");
      return state.clients.map((c) => ({ ...c }));
    },
    createClient: async (f) => {
      if (state.dryRun) return { id: `dry-client-${state.creates}`, dryRun: true };
      state.creates++;
      if (state.createFails) throw new Error(state.createFails);
      const id = `m-${state.creates}`;
      state.clients.push({ id, name: f.name, taxId: f.taxId });
      return { id, dryRun: false };
    },
  };
  return { port, state };
}

// ─── stand-ins for 0108 — what the SQL does ────────────────────────────────
let failApproveTx = false;
const RPC = {
  approve_client_registration: (a: Record<string, unknown>, st: Record<string, Row[]>) => {
    if (failApproveTx) return { error: { message: "connection reset" } };
    const r = st.client_registrations.find((x) => x.id === a.p_registration_id);
    if (!r) return { error: { message: "E17:not_found" } };
    if (r.status === "approved") return { data: { already: true, client_id: r.client_id, show_id: null } };
    if (r.status !== "pending") return { error: { message: "E17:not_pending" } };
    const c = st.clients.find((x) => x.id === r.client_id)!;
    if (!c.morning_client_id || String(c.morning_client_id).startsWith("dry-")) return { error: { message: "E17:no_morning_id" } };
    if (st.clients.some((x) => x !== c && x.normalized_name === a.p_normalized_name)) return { error: { message: "E17:name_taken" } };
    if (st.clients.some((x) => x !== c && x.tax_id === a.p_tax_id)) return { error: { message: "E17:tax_id_taken" } };
    Object.assign(c, { name: a.p_client_name, normalized_name: a.p_normalized_name, tax_id: a.p_tax_id, status: "active" });
    const show = a.p_show as Record<string, unknown>;
    const showRow = { id: `show-${st.shows.length + 1}`, client_id: c.id, name: show.name, aliases: show.aliases, first_booking_needs_approval: true, default_rate: show.default_rate, hourly_rate: show.hourly_rate };
    st.shows.push(showRow);
    for (const ct of a.p_contacts as { name: string; wa_id: string }[]) {
      st.booking_contacts.push({ show_id: showRow.id, name: ct.name, wa_id: ct.wa_id, registration_id: r.id });
    }
    Object.assign(r, { status: "approved", decided_by: a.p_actor, decided_at: "now" });
    return { data: { already: false, client_id: c.id, show_id: showRow.id } };
  },
  attach_client_registration: (a: Record<string, unknown>, st: Record<string, Row[]>) => {
    const r = st.client_registrations.find((x) => x.id === a.p_registration_id);
    if (!r) return { error: { message: "E17:not_found" } };
    if (r.status === "approved") return { data: { already: true, client_id: r.client_id } };
    if (r.status !== "duplicate") return { error: { message: "E17:not_duplicate" } };
    let showId = a.p_show_id as string | null;
    if (showId) {
      const s = st.shows.find((x) => x.id === showId);
      if (!s || s.client_id !== r.duplicate_of_client_id) return { error: { message: "E17:show_not_of_client" } };
    } else {
      showId = `show-${st.shows.length + 1}`;
      st.shows.push({ id: showId, client_id: r.duplicate_of_client_id, name: (a.p_show as Row).name, first_booking_needs_approval: true });
    }
    for (const ct of a.p_contacts as { name: string; wa_id: string }[]) st.booking_contacts.push({ show_id: showId, wa_id: ct.wa_id, registration_id: r.id });
    Object.assign(r, { status: "approved", client_id: r.duplicate_of_client_id, decided_at: "now" });
    return { data: { already: false, show_id: showId } };
  },
  reject_client_registration: (a: Record<string, unknown>, st: Record<string, Row[]>) => {
    const r = st.client_registrations.find((x) => x.id === a.p_registration_id);
    if (!r) return { error: { message: "E17:not_found" } };
    if (r.status === "rejected") return { data: { already: true } };
    if (r.status === "approved") return { error: { message: "E17:already_approved" } };
    Object.assign(r, { status: "rejected", rejected_at: "now", reject_reason: a.p_reason || null });
    const c = st.clients.find((x) => x.id === r.client_id && x.status === "pending");
    if (c) c.status = "rejected";
    return { data: { already: false } };
  },
  purge_rejected_registrations: (a: Record<string, unknown>) => {
    purgeCutoff = a.p_cutoff as string;
    return { data: { registrations: 2, clients: 1, kept_with_links: 1 } };
  },
};
let purgeCutoff = "";

const REG = "reg-1";
const PC = "pc-1";
const GOOD = {
  clientName: "סטודיו גל",
  taxId: "514-000-001",
  emails: ["Gal@Example.com"],
  phone: "050-765-4321",
  address: "",
  show: { name: "הפודקאסט של גל", alias: "גל", billingMode: "per_episode", pricingModel: "per_episode", rate: "900", defaultStudio: "גבעון" },
  contacts: [{ name: "גל", phone: "050-111-2222" }, { name: "", phone: "" }],
};

function world(over: { clients?: Row[]; regs?: Row[]; prefs?: Row[] } = {}) {
  return fakeDb(
    {
      clients: over.clients ?? [{ id: PC, name: "סטודיו גל", normalized_name: `pending:${REG}`, status: "pending", morning_client_id: null, tax_id: null }],
      client_registrations: over.regs ?? [{ id: REG, status: "pending", client_id: PC }],
      shows: [],
      booking_contacts: [],
      events: [],
      wa_messages: [],
      wa_contact_prefs: over.prefs ?? [],
    },
    { unique: REGISTRATION_UNIQUES, rpc: RPC }
  );
}
const evs = (st: Record<string, Row[]>) => st.events.map((e) => e.event_type);

async function main() {
  section("0. the form (pure)");
  {
    const v = validateApprovalInput(GOOD);
    check("a good form passes", v.ok, true);
    if (v.ok) {
      check("ח.פ cleaned, email lower-cased, phones -> wa_id", [v.value.taxId, v.value.emails, v.value.phone, v.value.contacts], [
        "514000001", ["gal@example.com"], "972507654321", [{ name: "גל", waId: "972501112222" }],
      ]);
    }
    const bad = validateApprovalInput({ ...GOOD, show: { ...GOOD.show, alias: " " } });
    check("🔴 alias is required", !bad.ok && bad.errors.alias, "כינוי לפודקאסט הוא שדה חובה.");
    const noContacts = validateApprovalInput({ ...GOOD, contacts: [] });
    check("at least one booking number", !noContacts.ok && !!noContacts.errors.contact1Phone, true);
    const same = validateApprovalInput({ ...GOOD, contacts: [{ name: "a", phone: "0501112222" }, { name: "b", phone: "050-111-2222" }] });
    check("two equal numbers refused", !same.ok && !!same.errors.contact2Phone, true);
    // owner 11.10: per-episode billing needs a price above 0
    const NOT_A_NUMBER = "התעריף צריך להיות מספר חיובי.";
    for (const [rate, want] of [["", RATE_REQUIRED_ERROR], ["0", RATE_REQUIRED_ERROR], ["-5", NOT_A_NUMBER], ["abc", NOT_A_NUMBER]] as const) {
      const v2 = validateApprovalInput({ ...GOOD, show: { ...GOOD.show, rate } });
      check(`🔴 per_episode, price "${rate}" -> refused on the price field`, !v2.ok && v2.errors.rate, want);
    }
    check("per_episode, price 900 -> fine", validateApprovalInput(GOOD).ok, true);
    check("per_episode priced per hour still needs the price", !validateApprovalInput({ ...GOOD, show: { ...GOOD.show, pricingModel: "per_hour", rate: "" } }).ok, true);
    check("contract / none: no price needed", [
      validateApprovalInput({ ...GOOD, show: { ...GOOD.show, billingMode: "contract", rate: "" } }).ok,
      validateApprovalInput({ ...GOOD, show: { ...GOOD.show, billingMode: "none", rate: "" } }).ok,
    ], [true, true]);
    check("the form's own check (UI) says the same", [
      perEpisodeRateError("per_episode", ""), perEpisodeRateError("per_episode", "0"), perEpisodeRateError("per_episode", "350"), perEpisodeRateError("contract", ""),
    ], [RATE_REQUIRED_ERROR, RATE_REQUIRED_ERROR, null, null]);
    const ui = readFileSync(join(__dirname, "..", "src/components/RegistrationReview.tsx"), "utf8");
    check("UI: approve checks the price before the request", ui.includes("if (!form || busy || rateBlocked()) return;"), true);
    check("UI: 'new podcast' checks it too", ui.includes('if (!form || busy || (mode === "new" && rateBlocked())) return;'), true);
    check("UI: the error is drawn beside the price field", ui.includes("error={errors.pricingModel || errors.rate}"), true);
    check("E17 code parsed", [e17Code("ERROR: E17:name_taken"), e17Code("boom")], ["name_taken", null]);
    check("Morning field guessed", [morningFieldOf("taxId is invalid"), morningFieldOf("Invalid email"), morningFieldOf("???")], ["taxId", "emails", null]);
  }

  section("1. the happy path — create in Morning, then ONE transaction");
  {
    const { client, store, calls } = world();
    const m = fakeMorning();
    const out = await approveRegistration(client, m.port, { registrationId: REG, actorId: "admin-1", raw: GOOD });
    check("approved", [out.kind, out.kind === "approved" && out.already], ["approved", false]);
    check("Morning: one create", m.state.creates, 1);
    const c = store.clients[0];
    check("client active, real name + normalized + ח.פ + Morning id", [c.status, c.name, c.normalized_name, c.tax_id, c.morning_client_id], [
      "active", "סטודיו גל", normalizeClientName("סטודיו גל"), "514000001", "m-1",
    ]);
    const persistIdx = calls.findIndex((x) => x.table === "clients" && x.op === "update");
    const txIdx = calls.findIndex((x) => x.table === "rpc:approve_client_registration");
    check("🔴 the Morning id was saved on the pending row BEFORE the transaction", persistIdx >= 0 && persistIdx < txIdx, true);
    check("podcast: flag on, alias, rate on the per-episode column", [store.shows[0].first_booking_needs_approval, store.shows[0].aliases, store.shows[0].default_rate, store.shows[0].hourly_rate], [true, ["גל"], "900", ""]);
    check("contacts carry the registration id", store.booking_contacts.map((b) => [b.wa_id, b.registration_id]), [["972501112222", REG]]);
    check("template not approved -> skipped, evented, NO WhatsApp row", [out.kind === "approved" && out.notice, store.wa_messages.length, evs(store).includes("notification_skipped_template_unapproved")], ["skipped-template", 0, true]);
    check("'the message goes to' = the first authorised number", out.kind === "approved" && out.noticeTo, "972501112222");
    const again = await approveRegistration(client, m.port, { registrationId: REG, actorId: "admin-1", raw: GOOD });
    check("pressing again -> already, nothing more", [again.kind === "approved" && again.already, m.state.creates, store.shows.length], [true, 1, 1]);
  }

  section("2. Morning refuses -> stays pending, error + field, retry");
  {
    const { client, store } = world();
    const m = fakeMorning({ createFails: "taxId is not valid" });
    const out = await approveRegistration(client, m.port, { registrationId: REG, actorId: "a", raw: GOOD });
    check("morning-failed with the field", out.kind === "morning-failed" && [out.error, out.field], ["taxId is not valid", "taxId"]);
    check("registration still pending, client still pending, no id saved", [store.client_registrations[0].status, store.clients[0].status, store.clients[0].morning_client_id], ["pending", "pending", null]);
    check("the failure is evented (the screen re-reads it)", evs(store).includes("registration_morning_failed"), true);
    m.state.createFails = null;
    const retry = await approveRegistration(client, m.port, { registrationId: REG, actorId: "a", raw: GOOD });
    check("retry after fixing -> approved", retry.kind, "approved");
    check("Morning creates: the failed try + the good one, no more", m.state.creates, 2);
    check("exactly one Morning client with that ח.פ", m.state.clients.filter((x) => x.taxId === "514000001").length, 1);
  }

  section("3. 🔴 saving the id fails AFTER Morning created -> retry finds it by ח.פ, no duplicate");
  {
    const { client, store } = fakeDb(
      { clients: [{ id: PC, name: "x", normalized_name: `pending:${REG}`, status: "pending", morning_client_id: null }], client_registrations: [{ id: REG, status: "pending", client_id: PC }], shows: [], booking_contacts: [], events: [], wa_messages: [], wa_contact_prefs: [] },
      { unique: REGISTRATION_UNIQUES, rpc: RPC, failOn: { clients: ["update"] } }
    );
    const m = fakeMorning();
    const out = await approveRegistration(client, m.port, { registrationId: REG, actorId: "a", raw: GOOD });
    check("persist failed -> error at that step", out.kind === "error" && out.step, "persist-morning-id");
    check("Morning created once", m.state.creates, 1);
    check("our client untouched", [store.clients[0].status, store.clients[0].morning_client_id], ["pending", null]);
    // the database is back; the admin presses "נסה שוב"
    const w2 = world();
    const retry = await approveRegistration(w2.client, m.port, { registrationId: REG, actorId: "a", raw: GOOD });
    check("retry -> 'exists in Morning', offered to link (NOT created again)", retry.kind === "morning-exists" && retry.morningClient.id, "m-1");
    check("still one create", m.state.creates, 1);
    const linked = await approveRegistration(w2.client, m.port, { registrationId: REG, actorId: "a", raw: GOOD, linkMorningId: "m-1" });
    check("linking -> approved with that id", [linked.kind, w2.store.clients[0].morning_client_id], ["approved", "m-1"]);
    check("still one create, one Morning client with that ח.פ", [m.state.creates, m.state.clients.length], [1, 1]);
  }

  section("4. 🔴 the transaction fails -> retry skips Morning entirely");
  {
    const { client, store } = world();
    const m = fakeMorning();
    failApproveTx = true;
    const out = await approveRegistration(client, m.port, { registrationId: REG, actorId: "a", raw: GOOD });
    failApproveTx = false;
    check("transaction failed -> error", out.kind === "error" && out.step, "transaction");
    check("the id IS on the pending row; the client is NOT active", [store.clients[0].morning_client_id, store.clients[0].status], ["m-1", "pending"]);
    check("no podcast, no contacts", [store.shows.length, store.booking_contacts.length], [0, 0]);
    const listsBefore = m.state.lists;
    const retry = await approveRegistration(client, m.port, { registrationId: REG, actorId: "a", raw: GOOD });
    check("retry -> approved", retry.kind, "approved");
    check("…without calling Morning at all (no list, no create)", [m.state.lists - listsBefore, m.state.creates], [0, 1]);
  }

  section("5. dry run (B23) — nothing saved, not activated");
  {
    const { client, store } = world();
    const m = fakeMorning({ dryRun: true });
    const out = await approveRegistration(client, m.port, { registrationId: REG, actorId: "a", raw: GOOD });
    check("dry-run outcome", out, { kind: "dry-run", wouldCreate: true });
    check("no id saved, still pending, no transaction", [store.clients[0].morning_client_id, store.clients[0].status, store.shows.length], [null, "pending", 0]);
    const linkTry = await approveRegistration(client, fakeMorning({ dryRun: true, existing: [{ id: "m-9", name: "x", taxId: "514000001" }] }).port, { registrationId: REG, actorId: "a", raw: GOOD, linkMorningId: "m-9" });
    check("dry run + link -> still a rehearsal, nothing saved", [linkTry.kind, store.clients[0].morning_client_id], ["dry-run", null]);
    // a lying port: a synthetic id with dryRun:false is still never saved
    const liar: MorningPort = { isDryRun: () => false, listClients: async () => [], createClient: async () => ({ id: "dry-client-x", dryRun: false }) };
    const lie = await approveRegistration(client, liar, { registrationId: REG, actorId: "a", raw: GOOD });
    check("a synthetic id is never saved, whatever the flag says", [lie.kind, store.clients[0].morning_client_id], ["dry-run", null]);
  }

  section("6. the checks");
  {
    const w = world({
      clients: [
        { id: PC, name: "x", normalized_name: `pending:${REG}`, status: "pending", morning_client_id: null },
        { id: "card", name: "כרטיס", normalized_name: "כרטיס", status: "active", tax_id: "514000001" },
      ],
    });
    const out = await approveRegistration(w.client, fakeMorning().port, { registrationId: REG, actorId: "a", raw: GOOD });
    check("ח.פ of an ACTIVE client -> blocked, with the card", out, { kind: "tax-id-active", clientId: "card", clientName: "כרטיס" });
  }
  {
    const w = world({
      clients: [
        { id: PC, name: "x", normalized_name: `pending:${REG}`, status: "pending", morning_client_id: null },
        { id: "other", name: "סטודיו גל", normalized_name: normalizeClientName("סטודיו גל"), status: "active" },
      ],
    });
    const m = fakeMorning();
    const out = await approveRegistration(w.client, m.port, { registrationId: REG, actorId: "a", raw: GOOD });
    check("name taken -> asked to change, Morning not touched", [out.kind, m.state.creates, m.state.lists], ["name-taken", 0, 0]);
  }
  {
    const w = world();
    const m = fakeMorning({ existing: [{ id: "m-old", name: "גל ישן", taxId: "514-000-001" }] });
    const out = await approveRegistration(w.client, m.port, { registrationId: REG, actorId: "a", raw: GOOD });
    check("ח.פ known to Morning -> offer to link, nothing created", [out.kind === "morning-exists" && out.morningClient.id, m.state.creates], ["m-old", 0]);
    const bogus = await approveRegistration(w.client, m.port, { registrationId: REG, actorId: "a", raw: GOOD, linkMorningId: "m-nope" });
    check("linking an id Morning does not have -> refused", bogus.kind, "morning-link-unknown");
  }
  {
    const w = world();
    const out = await approveRegistration(w.client, fakeMorning({ listFails: true }).port, { registrationId: REG, actorId: "a", raw: GOOD });
    check("Morning unreadable -> morning-failed, nothing written", [out.kind, w.store.clients[0].morning_client_id], ["morning-failed", null]);
  }
  {
    const w = world({ regs: [{ id: REG, status: "rejected", client_id: PC }] });
    const out = await approveRegistration(w.client, fakeMorning().port, { registrationId: REG, actorId: "a", raw: GOOD });
    check("a rejected registration cannot be approved", out.kind === "refused" && out.code, "not_pending");
  }

  section("7. the approval message — language and the template switch");
  {
    TEMPLATE_META_APPROVED.bizi_client_approved = true;
    const he = world();
    const o1 = await approveRegistration(he.client, fakeMorning().port, { registrationId: REG, actorId: "a", raw: GOOD });
    const row = he.store.wa_messages[0];
    check("approved template -> ONE row, to the client's first number", [he.store.wa_messages.length, row?.wa_id, row?.template_name], [1, "972501112222", "bizi_client_approved"]);
    check("…Hebrew by default", (row?.payload as { language?: string })?.language, "he");
    check("…outcome says it (dry run)", o1.kind === "approved" && o1.notice, "dry-run");
    const en = world({ prefs: [{ wa_id: "972501112222", lang: "en" }] });
    await approveRegistration(en.client, fakeMorning().port, { registrationId: REG, actorId: "a", raw: GOOD });
    check("an English chooser gets HEBREW while the English version is not marked approved (E19 seam)", (en.store.wa_messages[0]?.payload as { language?: string })?.language, "he");
    TEMPLATE_EN_APPROVED.bizi_client_approved = true;
    const en2 = world({ prefs: [{ wa_id: "972501112222", lang: "en" }] });
    await approveRegistration(en2.client, fakeMorning().port, { registrationId: REG, actorId: "a", raw: GOOD });
    check("…and English once it is", (en2.store.wa_messages[0]?.payload as { language?: string })?.language, "en");
    delete TEMPLATE_EN_APPROVED.bizi_client_approved;
    TEMPLATE_META_APPROVED.bizi_client_approved = false;
  }

  section("8. a registration matched to an existing card — three actions");
  {
    const base = () =>
      fakeDb(
        {
          clients: [{ id: "card", name: "כרטיס", status: "active" }, { id: "other", name: "אחר", status: "active" }],
          client_registrations: [{ id: REG, status: "duplicate", client_id: null, duplicate_of_client_id: "card" }],
          shows: [{ id: "s-card", client_id: "card", name: "קיים", first_booking_needs_approval: false }, { id: "s-other", client_id: "other", name: "זר" }],
          booking_contacts: [],
          events: [],
        },
        { unique: REGISTRATION_UNIQUES, rpc: RPC }
      );
    const contacts = [{ name: "גל", phone: "0501112222" }];
    let w = base();
    let o = await attachRegistration(w.client, { registrationId: REG, actorId: "a", raw: { mode: "existing", showId: "s-card", contacts } });
    check("connect to an existing podcast -> done, no new podcast, flag untouched", [o.kind, w.store.shows.length, w.store.shows[0].first_booking_needs_approval], ["done", 2, false]);
    check("…the registration approved under the card", [w.store.client_registrations[0].status, w.store.client_registrations[0].client_id], ["approved", "card"]);
    check("…no new client", w.store.clients.length, 2);
    w = base();
    o = await attachRegistration(w.client, { registrationId: REG, actorId: "a", raw: { mode: "existing", showId: "s-other", contacts } });
    check("another client's podcast -> refused", o.kind === "refused" && o.code, "show_not_of_client");
    w = base();
    o = await attachRegistration(w.client, { registrationId: REG, actorId: "a", raw: { mode: "new", show: GOOD.show, contacts } });
    check("open a new podcast under the card -> flag on", [o.kind, w.store.shows.length, w.store.shows[2]?.client_id, w.store.shows[2]?.first_booking_needs_approval], ["done", 3, "card", true]);
    w = base();
    o = await attachRegistration(w.client, { registrationId: REG, actorId: "a", raw: { mode: "new", show: { ...GOOD.show, alias: "" }, contacts } });
    check("new podcast without an alias -> invalid, nothing called", [o.kind, w.calls.some((c) => c.op === "rpc")], ["invalid", false]);
    w = base();
    o = await attachRegistration(w.client, { registrationId: REG, actorId: "a", raw: { mode: "new", show: { ...GOOD.show, rate: "" }, contacts } });
    check("🔴 new podcast, per episode, no price -> invalid on the price, nothing called", [o.kind, o.kind === "invalid" && o.errors.rate, w.calls.some((c) => c.op === "rpc")], ["invalid", RATE_REQUIRED_ERROR, false]);
    w = base();
    o = await attachRegistration(w.client, { registrationId: REG, actorId: "a", raw: { mode: "existing", showId: "s-card", contacts } });
    check("connecting to an EXISTING podcast asks no price", o.kind, "done");
    w = base();
    o = await rejectRegistration(w.client, { registrationId: REG, actorId: "a", reason: "לא רלוונטי" });
    check("reject a matched one -> done, the card untouched", [o.kind, w.store.client_registrations[0].status, w.store.clients[0].status], ["done", "rejected", "active"]);
  }

  section("9. rejection — nothing to the client, nothing in Morning");
  {
    const w = world();
    const m = fakeMorning();
    const o = await rejectRegistration(w.client, { registrationId: REG, actorId: "a", reason: "" });
    check("rejected, the pending client rejected", [o.kind, w.store.client_registrations[0].status, w.store.clients[0].status], ["done", "rejected", "rejected"]);
    check("no WhatsApp row, no Morning call", [w.store.wa_messages.length, m.state.lists + m.state.creates], [0, 0]);
    const again = await rejectRegistration(w.client, { registrationId: REG, actorId: "a", reason: "" });
    check("again -> already", again.kind === "done" && again.already, true);
    const long = await rejectRegistration(w.client, { registrationId: REG, actorId: "a", reason: "x".repeat(501) });
    check("a reason over 500 chars -> invalid", long.kind, "invalid");
  }

  section("10. the 30-day purge");
  {
    const w = fakeDb({ events: [] }, { rpc: RPC });
    const now = new Date("2026-11-20T02:30:00Z");
    const out = await runRegistrationPurge(w.client, now);
    check("the cutoff is exactly 30 days back", purgeCutoff, "2026-10-21T02:30:00.000Z");
    check("counts returned", out, { ok: true, registrations: 2, clients: 1, keptWithLinks: 1 });
    const ev = w.store.events[0];
    check("one event, counts ONLY — no name, number or id of anything deleted", [ev?.event_type, Object.keys(ev?.payload as object).sort()], [
      "registrations_purged",
      ["clients", "cutoff", "keptWithLinks", "registrations"],
    ]);
  }

  section("11. the first booking (decide.ts)");
  {
    check("flag -> pending 'first-booking', even with auto-approve ON", autoApproveVerdict({ switchOn: true, approvedSameDay: 0, firstBookingNeedsApproval: true }), { auto: false, reason: "first-booking" });
    check("flag wins over switch-off too", autoApproveVerdict({ switchOn: false, approvedSameDay: 0, firstBookingNeedsApproval: true }), { auto: false, reason: "first-booking" });
    check("no flag -> unchanged rules", autoApproveVerdict({ switchOn: true, approvedSameDay: 0 }), { auto: true });
    check("the {{5}} label", PENDING_REASON_LABEL["first-booking"], "הזמנה ראשונה של לקוח חדש");

    process.env.BOOKING_AUTO_APPROVE = "true";
    const w = fakeDb({ shows: [{ id: "s1", first_booking_needs_approval: true }], booking_requests: [], wa_messages: [], events: [] }, { unique: REGISTRATION_UNIQUES });
    const req = (id: string) => ({ bookingId: id, showId: "s1", showName: "פוד", dateIsrael: "2026-10-20", startIsrael: "10:00", endIsrael: "11:30", studio: "גבעון", guest: null, durationTag: null });
    const r1 = await autoApproveNewRequest(w.client, req("b1"));
    const r2 = await autoApproveNewRequest(w.client, req("b2"));
    check("two requests before any approval -> both stay pending", [r1, r2], [{ approved: false, reason: "first-booking" }, { approved: false, reason: "first-booking" }]);
    const n = w.store.wa_messages.filter((m) => m.template_name === "bizi_booking_pending");
    check("…each told to both, with the first-booking reason", [n.length, (n[0]?.payload as { params?: string[] })?.params?.[4]], [4, "הזמנה ראשונה של לקוח חדש"]);
    delete process.env.BOOKING_AUTO_APPROVE;

    const lowered = await lowerFirstBookingFlag(w.client, { showId: "s1", requestId: "b1", actorId: "admin" });
    check("approving the first lowers the flag, evented", [lowered, w.store.shows[0].first_booking_needs_approval, w.store.events.map((e) => e.event_type)], [true, false, ["first_booking_flag_lowered"]]);
    check("lowering again is a no-op", await lowerFirstBookingFlag(w.client, { showId: "s1", requestId: "b2", actorId: "admin" }), false);
    const src = readFileSync(join(__dirname, "..", "src/lib/booking/decide.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function approveBookingRequest"));
    const flip = fn.indexOf('.eq("status", "pending");');
    const lower = fn.indexOf("await lowerFirstBookingFlag(");
    check("approveBookingRequest lowers the flag only AFTER the flip succeeded", flip > 0 && lower > flip, true);
    check("…and nothing approves the waiting second request (no other write of booking_requests status in the lowering)", /booking_requests/.test(src.slice(src.indexOf("export async function lowerFirstBookingFlag"), src.indexOf("export async function lowerFirstBookingFlag") + 1500)), false);
  }

  section("12. who may — every route asks studio_admin first; the popup and the badge");
  {
    const routes = [
      "src/app/api/registrations/pending-count/route.ts",
      "src/app/api/registrations/[id]/route.ts",
      "src/app/api/registrations/[id]/approve/route.ts",
      "src/app/api/registrations/[id]/attach/route.ts",
      "src/app/api/registrations/[id]/reject/route.ts",
    ];
    for (const r of routes) {
      const s = readFileSync(join(__dirname, "..", r), "utf8");
      const handler = s.slice(s.search(/export async function (GET|POST)/));
      const firstAwait = handler.indexOf("await ");
      check(`${r.replace("src/app/api/", "")}: the first await is requireStudioAdmin()`, handler.slice(firstAwait, firstAwait + 26), "await requireStudioAdmin()");
    }
    const gate = readFileSync(join(__dirname, "..", "src/lib/registration/gate.ts"), "utf8");
    check("the gate is isStudioAdmin", gate.includes("if (!isStudioAdmin(profile))"), true);
    const cron = readFileSync(join(__dirname, "..", "src/app/api/cron/purge-registrations/route.ts"), "utf8");
    check("the cron checks CRON_SECRET before anything", cron.indexOf("CRON_SECRET") < cron.indexOf("runRegistrationPurge(createTypedAdminClient"), true);
    const vercel = JSON.parse(readFileSync(join(__dirname, "..", "vercel.json"), "utf8")) as { crons: { path: string }[] };
    check("the cron is scheduled", vercel.crons.some((c) => c.path === "/api/cron/purge-registrations"), true);
    const header = readFileSync(join(__dirname, "..", "src/components/AppHeader.tsx"), "utf8");
    check("the popup is mounted for studio_admin only", header.includes("{isStudioAdmin(profile) && <RegistrationsPopup />}"), true);
    // owner 11.10 (revised): first check of the session opens on > 0; after
    // that ONLY when the count rose since the last check
    check("popup: first check, 2 waiting -> opens", nextPopupState(null, 2), { show: true, seen: 2 });
    check("popup: first check, none waiting -> closed", nextPopupState(null, 0), { show: false, seen: 0 });
    check("popup: same count on the next screen -> NOT again", nextPopupState(2, 2), { show: false, seen: 2 });
    check("popup: count fell (some approved) -> NOT again, remembers the lower", nextPopupState(3, 1), { show: false, seen: 1 });
    check("🔴 popup: count rose 2 -> 3 mid-session -> opens again", nextPopupState(2, 3), { show: true, seen: 3 });
    check("popup: 0 -> 1 mid-session -> opens", nextPopupState(0, 1), { show: true, seen: 1 });
    {
      // a session walked through: 2, 2, 2, 1 (approved one), 2 (a new one), 2
      let seen: number | null = null;
      const shown: boolean[] = [];
      for (const n of [2, 2, 2, 1, 2, 2]) {
        const r = nextPopupState(seen, n);
        shown.push(r.show);
        seen = r.seen;
      }
      check("popup: a session 2,2,2,1,2,2 opens on the first and on the new arrival only", shown, [true, false, false, false, true, false]);
    }
    check("popup: re-check at most once a minute", [POPUP_RECHECK_MS, shouldRecheck(null, 0), shouldRecheck(1_000, 30_000), shouldRecheck(1_000, 61_000)], [60_000, true, false, true]);
    const popupSrc = readFileSync(join(__dirname, "..", "src/components/RegistrationsPopup.tsx"), "utf8");
    check("popup: no polling timer (screen change + tab back in view only)", /setInterval|setTimeout/.test(popupSrc), false);
    check("popup: re-checks on a screen change and on visibilitychange", [popupSrc.includes("}, [pathname]);"), popupSrc.includes('"visibilitychange"')], [true, true]);
    check("popup title", [popupTitle(1), popupTitle(3)], ["יש הרשמה אחת שממתינה לאישור", "יש 3 הרשמות שממתינות לאישור"]);
    check("badge", registrationsBadge(2), "2 ממתינות לאישור");
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
