/**
 * E17-4 — the bot's half: an unassociated number gets the two buttons, each
 * button does its one thing, the switch off changes nothing, and the owner is
 * never paged twice for one moment. Runs the REAL `replyToInbound`.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_registration_bot.ts
 *
 * ═══ F19 ═══
 * WHATSAPP_DRY_RUN is forced on: every reply and every notice is RECORDED in
 * the fake `wa_messages` and nothing is sent — that recording is exactly what
 * is asserted. `global.fetch` throws, so a send that slipped through would
 * fail the suite rather than reach Meta. The database is scripts/_fake_db.ts.
 */
import { fakeDb, REGISTRATION_UNIQUES, type Row } from "./_fake_db";
import { JOIN_EXISTING_ID, JOIN_NEW_ID, planUnknownReply, replyToInbound } from "../src/lib/whatsapp/reply";
import { COPY } from "../src/lib/whatsapp/flow/copy";
import { TEMPLATE_META_APPROVED } from "../src/lib/whatsapp/notify";
import { REJECTED_BLOCK_DAYS, rejectedBlockCutoff } from "../src/lib/registration/rejected";
import type { InboundMessage } from "../src/lib/whatsapp/webhook";

process.env.WHATSAPP_DRY_RUN = "true";
process.env.WHATSAPP_NOTIFY_NUMBERS = "972500000001,972500000002";
process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
delete process.env.WHATSAPP_BOOKING_FLOW;
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

const WA = "972541112233";
const OWNER = "972500000001";
const REQ = new Request("https://app.example/api/wa/webhook");
let n = 0;

function text(body: string): InboundMessage {
  n++;
  return { wamid: `wamid.T${n}`, waId: WA, rawFrom: WA, type: "text", body, raw: { type: "text", text: { body } } as never };
}
function tap(id: string, title: string): InboundMessage {
  n++;
  return {
    wamid: `wamid.B${n}`,
    waId: WA,
    rawFrom: WA,
    type: "interactive",
    body: title,
    raw: { type: "interactive", interactive: { type: "button_reply", button_reply: { id, title } } } as never,
  };
}

function world(lang: "he" | "en" | null) {
  return fakeDb(
    {
      booking_contacts: [],
      wa_messages: [],
      wa_contact_prefs: lang ? [{ wa_id: WA, lang }] : [],
      registration_links: [],
      events: [],
    },
    { unique: REGISTRATION_UNIQUES }
  );
}

type Msg = Row & { wa_id: string; template_name: string | null; body: string; payload: Record<string, unknown> };
const outbound = (store: Record<string, Row[]>) => store.wa_messages as Msg[];
const notices = (store: Record<string, Row[]>) => outbound(store).filter((m) => m.template_name);
const replies = (store: Record<string, Row[]>) => outbound(store).filter((m) => !m.template_name);

async function main() {
  section("0. the plan (pure)");
  check("anything typed -> offer", planUnknownReply(null), "offer");
  check("a foreign button id -> offer", planUnknownReply("f:go"), "offer");
  check("new -> link", planUnknownReply(JOIN_NEW_ID), "link");
  check("existing -> existing", planUnknownReply(JOIN_EXISTING_ID), "existing");

  // ═══ switch OFF: exactly as before E17-4 ═══════════════════════════════════
  section("1. switch OFF — the bot is unchanged");
  delete process.env.REGISTRATION_ENABLED;
  for (const lang of ["he", "en"] as const) {
    process.env.WHATSAPP_BILINGUAL = "true";
    const { client, store } = world(lang);
    await replyToInbound(client, REQ, text("היי"));
    check(`${lang}: the neutral sentence, word for word`, replies(store).map((m) => m.body), [COPY[lang].REPLY.neutral]);
    check(`${lang}: the owner's bizi_unknown_contact, to the owner only`, notices(store).map((m) => [m.template_name, m.wa_id]), [["bizi_unknown_contact", OWNER]]);
    check(`${lang}: no link minted`, store.registration_links.length, 0);
    // a crafted join tap with the switch off is just a message
    await replyToInbound(client, REQ, tap(JOIN_NEW_ID, "x"));
    check(`${lang}: a join tap with the switch off mints nothing`, store.registration_links.length, 0);
  }
  {
    // no saved language, bilingual on: the question goes out AND (switch off) the notice, as before
    const { client, store } = world(null);
    await replyToInbound(client, REQ, text("hello"));
    check("no language yet: question + owner notice (unchanged)", [replies(store).length, notices(store).length], [1, 1]);
  }
  delete process.env.WHATSAPP_BILINGUAL;

  // ═══ switch ON ════════════════════════════════════════════════════════════
  process.env.REGISTRATION_ENABLED = "true";
  process.env.WHATSAPP_BILINGUAL = "true";
  for (const lang of ["he", "en"] as const) {
    section(`2. switch ON — ${lang}`);
    const C = COPY[lang].JOIN;
    const { client, store } = world(lang);
    const kinds = () => notices(store).map((m) => `${m.template_name}>${m.wa_id}`);

    await replyToInbound(client, REQ, text("hi"));
    const offer = replies(store)[0];
    check("writes -> the offer body", offer?.body, C.offerBody);
    check("…as an interactive message", offer?.type, "interactive");
    check("🔴 …AND bizi_unknown_contact to the owner (nothing gets lost)", kinds(), [`bizi_unknown_contact>${OWNER}`]);

    await replyToInbound(client, REQ, text("עוד הודעה"));
    check("writes again the same day -> the offer again, NO second notice", [replies(store)[1]?.body, notices(store).length], [C.offerBody, 1]);

    await replyToInbound(client, REQ, tap(JOIN_NEW_ID, C.newClient));
    const linkReply = replies(store)[2];
    const url = /https:\/\/app\.example\/join\/([A-Za-z0-9_-]{43})/.exec(linkReply?.body ?? "");
    check("'new' -> the link reply, with a /join/<token> url", !!url && linkReply.body === C.link(url[0]), true);
    check("…one link row, bound to this number", store.registration_links.map((l) => l.wa_id), [WA]);
    check("…no notice for 'new' (the form will notify)", notices(store).length, 1);

    await replyToInbound(client, REQ, tap(JOIN_NEW_ID, C.newClient));
    check("'new' again -> THE SAME link", !!url && replies(store)[3]?.body === C.link(url[0]), true);
    check("…still one link row", store.registration_links.length, 1);

    await replyToInbound(client, REQ, tap(JOIN_EXISTING_ID, C.existingClient));
    check("'existing' -> the neutral answer to the client", replies(store)[4]?.body, C.existingReply);
    check("…its OWN notice: bizi_client_registration to both", kinds().slice(1), [
      "bizi_client_registration>972500000001",
      "bizi_client_registration>972500000002",
    ]);

    await replyToInbound(client, REQ, tap(JOIN_EXISTING_ID, C.existingClient));
    check("'existing' tapped AGAIN the same day -> no further notice", notices(store).length, 3);
    check("…but the client is answered again", replies(store).length, 6);
  }

  section("3. switch ON, registration template NOT approved — 'existing' falls back");
  {
    TEMPLATE_META_APPROVED.bizi_client_registration = false;
    const { client, store } = world("he");
    await replyToInbound(client, REQ, tap(JOIN_EXISTING_ID, "x"));
    check("existing -> bizi_unknown_contact to the owner, nothing else", notices(store).map((m) => [m.template_name, m.wa_id]), [["bizi_unknown_contact", OWNER]]);
    TEMPLATE_META_APPROVED.bizi_client_registration = true;
  }

  section("4. switch ON, no language yet — the question carries the daily notice");
  {
    const { client, store } = world(null);
    const first = text("hello");
    // the webhook route records every inbound message before replying; the
    // language tap resumes it from there
    store.wa_messages.push({ wamid: first.wamid, direction: "in", wa_id: WA, type: "text", body: "hello", payload: null });
    await replyToInbound(client, REQ, first);
    check("the language question goes out", replies(store).filter((m) => m.direction === "out").length, 1);
    check("🔴 the owner is told now, once", notices(store).map((m) => m.template_name), ["bizi_unknown_contact"]);
    n++;
    const pick: InboundMessage = {
      wamid: `wamid.L${n}`, waId: WA, rawFrom: WA, type: "interactive", body: "עברית",
      raw: { type: "interactive", interactive: { type: "button_reply", button_reply: { id: `lang:he:${first.wamid}`, title: "עברית" } } } as never,
    };
    await replyToInbound(client, REQ, pick);
    const out = replies(store).filter((m) => m.direction === "out");
    check("after the pick: the held message is answered with the offer", out[1]?.body, COPY.he.JOIN.offerBody);
    check("…and the owner is NOT told a second time", notices(store).length, 1);
  }

  section("5. a link that cannot be minted is not silence");
  {
    const { client, store } = fakeDb(
      { booking_contacts: [], wa_messages: [], wa_contact_prefs: [{ wa_id: WA, lang: "he" }], registration_links: [], events: [] },
      { unique: REGISTRATION_UNIQUES, failOn: { registration_links: ["insert"] } }
    );
    await replyToInbound(client, REQ, tap(JOIN_NEW_ID, "x"));
    check("the client is told", replies(store)[0]?.body, COPY.he.JOIN.linkFailed);
    check("the owner is told", notices(store).map((m) => m.template_name), ["bizi_unknown_contact"]);
  }

  section("6. a KNOWN number is untouched by all of this");
  {
    const { client, store } = fakeDb(
      {
        booking_contacts: [{ wa_id: WA, show_id: "s1", name: "x", shows: { id: "s1", name: "הפודקאסט", default_studio: null } }],
        booking_links: [],
        shows: [],
        wa_messages: [],
        wa_contact_prefs: [{ wa_id: WA, lang: "he" }],
        registration_links: [],
        events: [],
      },
      { unique: REGISTRATION_UNIQUES }
    );
    await replyToInbound(client, REQ, text("היי"));
    check("no offer to a known number", replies(store).some((m) => m.body === COPY.he.JOIN.offerBody), false);
    check("no link minted for a known number", store.registration_links.length, 0);
  }

  section("7. a rejected registration — 30 days without the buttons (owner decision 11.10)");
  {
    const DAY = 24 * 60 * 60 * 1000;
    const rejected = (daysAgo: number, verified: boolean, status = "rejected"): Row => ({
      id: `r-${daysAgo}-${verified}`, status, booking_wa_id_1: WA, booking_wa_id_1_verified: verified,
      booking_wa_id_2: null, booking_wa_id_2_verified: false,
      rejected_at: status === "rejected" ? new Date(Date.now() - daysAgo * DAY).toISOString() : null,
    });
    const withRegs = (regs: Row[], failOn?: Record<string, string[]>) => fakeDb(
      { booking_contacts: [], wa_messages: [], wa_contact_prefs: [{ wa_id: WA, lang: "he" }], registration_links: [], events: [], client_registrations: regs },
      { unique: REGISTRATION_UNIQUES, failOn }
    );
    check("the block is 30 days", REJECTED_BLOCK_DAYS, 30);
    check("cutoff = now - 30 days", rejectedBlockCutoff(new Date("2026-10-31T12:00:00Z")), "2026-10-01T12:00:00.000Z");

    {
      const { client, store } = withRegs([rejected(3, true)]);
      await replyToInbound(client, REQ, text("שוב אני"));
      check("verified + rejected 3 days ago: the NEUTRAL sentence, no buttons", [replies(store)[0]?.body, replies(store)[0]?.type], [COPY.he.REPLY.neutral, "text"]);
      check("…and the owner gets bizi_unknown_contact", notices(store).map((m) => [m.template_name, m.wa_id]), [["bizi_unknown_contact", OWNER]]);
      await replyToInbound(client, REQ, tap(JOIN_NEW_ID, "x"));
      check("…an old 'new client' button mints NO link", [store.registration_links.length, replies(store)[1]?.body], [0, COPY.he.REPLY.neutral]);
      check("…and the owner is paged once a day, not per message", notices(store).length, 1);
    }
    {
      const { client, store } = withRegs([rejected(29, true)]);
      await replyToInbound(client, REQ, text("hi"));
      check("verified + rejected 29 days ago: still blocked", replies(store)[0]?.body, COPY.he.REPLY.neutral);
    }
    {
      const { client, store } = withRegs([rejected(3, false)]);
      await replyToInbound(client, REQ, text("hi"));
      check("🔴 number TYPED in a manual link, rejected: NOT blocked — the buttons", [replies(store)[0]?.body, replies(store)[0]?.type], [COPY.he.JOIN.offerBody, "interactive"]);
    }
    {
      const { client, store } = withRegs([rejected(31, true)]);
      await replyToInbound(client, REQ, text("hi"));
      check("verified, rejected 31 days ago: an ordinary unknown number — the buttons again", replies(store)[0]?.body, COPY.he.JOIN.offerBody);
    }
    {
      const { client, store } = withRegs([rejected(0, true, "pending")]);
      await replyToInbound(client, REQ, text("hi"));
      check("a PENDING registration is not a rejection: the buttons", replies(store)[0]?.body, COPY.he.JOIN.offerBody);
    }
    {
      const { client, store } = withRegs([], { client_registrations: ["select"] });
      await replyToInbound(client, REQ, text("hi"));
      check("read failure: neutral + the owner is still told", [replies(store)[0]?.body, notices(store).length], [COPY.he.REPLY.neutral, 1]);
    }
  }

  delete process.env.REGISTRATION_ENABLED;
  delete process.env.WHATSAPP_BILINGUAL;
  console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
