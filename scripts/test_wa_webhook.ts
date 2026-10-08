/**
 * Pure WhatsApp webhook suite — E9-1.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_wa_webhook.ts
 *
 * SYNTHETIC FIXTURES ONLY. No user is created, no row is written, no route is
 * called, no dev server is started, and NOTHING reaches Meta — F19 is open and
 * every function under test here is pure by construction, which is why they
 * were written that way (`src/lib/whatsapp/webhook.ts` reads no env and makes
 * no call; the route passes the secrets in).
 *
 * Every assertion COUNTS (rule 56). "The signature check works" is not an
 * assertion — "this exact body with this exact key yields ok, and flipping one
 * character yields bad-signature" is.
 *
 * 🔴 THE KEY AND THE BODY BELOW ARE FIXTURES, not secrets. The real app secret
 * lives only in WHATSAPP_APP_SECRET on Vercel and is never read by this file.
 */
import { createHmac } from "node:crypto";
import {
  BODY_MAX_CHARS,
  messageBody,
  normalizeWaId,
  parseInboundMessages,
  toWaMessageRows,
  verifyHandshake,
  verifyWebhookSignature,
} from "../src/lib/whatsapp/webhook";
import { isWhatsappDryRun } from "../src/lib/whatsapp/client";

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

const SECRET = "fixture-app-secret-not-a-real-one";
const VERIFY = "fixture-verify-token";

/** The signature Meta would send for this body under this key. */
function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`;
}

function qs(pairs: Record<string, string>): URLSearchParams {
  return new URLSearchParams(pairs);
}

/** One realistic Cloud API delivery, shaped exactly as Meta documents it. */
function delivery(messages: unknown[], field = "messages"): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field,
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "972500000000", phone_number_id: "PNID" },
              contacts: [{ profile: { name: "דנה לוי" }, wa_id: "972501234567" }],
              messages,
            },
          },
        ],
      },
    ],
  };
}

function textMessage(id: string, body: string, from = "972501234567"): unknown {
  return { from, id, timestamp: "1760000000", type: "text", text: { body } };
}

console.log("\n=== 1. the GET handshake ===");
{
  check(
    "the happy path echoes the challenge",
    verifyHandshake(qs({ "hub.mode": "subscribe", "hub.verify_token": VERIFY, "hub.challenge": "1158201444" }), VERIFY),
    { ok: true, challenge: "1158201444" }
  );
  check(
    "a wrong token is refused",
    verifyHandshake(qs({ "hub.mode": "subscribe", "hub.verify_token": "nope-wrong-length-x", "hub.challenge": "1" }), VERIFY),
    { ok: false, reason: "bad-token" }
  );
  check(
    "a token of the SAME LENGTH but different bytes is refused — the length guard is not the check",
    verifyHandshake(
      qs({ "hub.mode": "subscribe", "hub.verify_token": "X".repeat(VERIFY.length), "hub.challenge": "1" }),
      VERIFY
    ),
    { ok: false, reason: "bad-token" }
  );
  check(
    "a missing token parameter is refused",
    verifyHandshake(qs({ "hub.mode": "subscribe", "hub.challenge": "1" }), VERIFY),
    { ok: false, reason: "bad-token" }
  );
  check(
    "the wrong mode is refused even with the right token",
    verifyHandshake(qs({ "hub.mode": "unsubscribe", "hub.verify_token": VERIFY, "hub.challenge": "1" }), VERIFY),
    { ok: false, reason: "wrong-mode" }
  );
  check(
    "a right token with no challenge is refused rather than echoed empty",
    verifyHandshake(qs({ "hub.mode": "subscribe", "hub.verify_token": VERIFY }), VERIFY),
    { ok: false, reason: "no-challenge" }
  );
  // 🔴 the configuration failure, in the only safe direction
  check(
    "an UNSET verify token refuses everything — it never accepts whoever asks first",
    verifyHandshake(qs({ "hub.mode": "subscribe", "hub.verify_token": VERIFY, "hub.challenge": "1" }), undefined),
    { ok: false, reason: "no-token" }
  );
  check(
    "an empty verify token is the same refusal",
    verifyHandshake(qs({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" }), "   "),
    { ok: false, reason: "no-token" }
  );
}

console.log("\n=== 2. the POST signature ===");
{
  const body = JSON.stringify(delivery([textMessage("wamid.AAA", "שלום")]));

  check("a correct signature verifies", verifyWebhookSignature(body, sign(body), SECRET), { ok: true });
  check(
    "upper-case hex from Meta still verifies",
    verifyWebhookSignature(body, sign(body).toUpperCase().replace("SHA256=", "sha256="), SECRET),
    { ok: true }
  );

  // the body is what is signed — one character anywhere breaks it
  check(
    "a body changed by ONE character is refused",
    verifyWebhookSignature(body.replace("שלום", "שלומ"), sign(body), SECRET),
    { ok: false, reason: "bad-signature" }
  );
  check(
    "a body with the same characters RE-SERIALIZED (key order changed) is refused — why the route must use request.text()",
    verifyWebhookSignature(JSON.stringify(JSON.parse(body)), sign('{"b":1,"a":2}'), SECRET),
    { ok: false, reason: "bad-signature" }
  );
  check(
    "the right body under the WRONG key is refused",
    verifyWebhookSignature(body, sign(body, "some-other-secret"), SECRET),
    { ok: false, reason: "bad-signature" }
  );

  // shape failures, each with its own reason so a log says which
  check("a missing header is 'missing'", verifyWebhookSignature(body, null, SECRET), {
    ok: false,
    reason: "missing",
  });
  check("an empty header is 'missing'", verifyWebhookSignature(body, "   ", SECRET), {
    ok: false,
    reason: "missing",
  });
  check(
    "a bare hex digest with no sha256= prefix is 'malformed'",
    verifyWebhookSignature(body, sign(body).slice("sha256=".length), SECRET),
    { ok: false, reason: "malformed" }
  );
  check("the wrong algorithm prefix is 'malformed'", verifyWebhookSignature(body, "sha1=abc", SECRET), {
    ok: false,
    reason: "malformed",
  });

  // 🔴 THE LENGTH CASES. timingSafeEqual THROWS on a length mismatch, so these
  // are the inputs that would crash the route if the guard were removed.
  check(
    "a SHORT digest is refused, not thrown",
    verifyWebhookSignature(body, "sha256=abcd", SECRET),
    { ok: false, reason: "malformed" }
  );
  check(
    "a LONG digest is refused, not thrown",
    verifyWebhookSignature(body, `sha256=${"a".repeat(128)}`, SECRET),
    { ok: false, reason: "malformed" }
  );
  check(
    "non-hex characters are refused as malformed rather than silently becoming an empty buffer",
    verifyWebhookSignature(body, `sha256=${"z".repeat(64)}`, SECRET),
    { ok: false, reason: "malformed" }
  );
  check(
    "a digest one nibble short is malformed",
    verifyWebhookSignature(body, `sha256=${"a".repeat(63)}`, SECRET),
    { ok: false, reason: "malformed" }
  );

  // 🔴 the configuration failure. No degraded mode.
  check(
    "an UNSET app secret refuses a perfectly valid-looking delivery",
    verifyWebhookSignature(body, sign(body), undefined),
    { ok: false, reason: "no-secret" }
  );
  check("an empty app secret is the same refusal", verifyWebhookSignature(body, sign(body), "  "), {
    ok: false,
    reason: "no-secret",
  });

  // non-ASCII must survive the string -> Buffer round trip the route relies on
  const hebrew = JSON.stringify(delivery([textMessage("wamid.HEB", "אפשר לקבוע הקלטה ל-יום ג׳? 🙂")]));
  check("a Hebrew + emoji body verifies — the utf8 round trip is byte-identical", verifyWebhookSignature(hebrew, sign(hebrew), SECRET), {
    ok: true,
  });
}

console.log("\n=== 3. wa_id normalization ===");
{
  check("plain digits", normalizeWaId("972501234567"), "972501234567");
  check("a leading + is tolerated on the way in", normalizeWaId("+972501234567"), "972501234567");
  check("whitespace is trimmed", normalizeWaId("  972501234567 "), "972501234567");
  check("dashes are refused", normalizeWaId("972-50-1234567"), null);
  check("a local Israeli format with a leading zero is still digits, and kept as-is", normalizeWaId("0501234567"), "0501234567");
  check("letters are refused", normalizeWaId("972abc"), null);
  check("too short", normalizeWaId("12345"), null);
  check("too long", normalizeWaId("9".repeat(21)), null);
  check("empty", normalizeWaId("   "), null);
  check("a non-string", normalizeWaId(972501234567), null);
  check("null", normalizeWaId(null), null);
}

console.log("\n=== 4. message body, by type ===");
{
  check("text", messageBody({ type: "text", text: { body: "היי" } }), "היי");
  check("a template quick-reply press reads its button title", messageBody({ type: "button", button: { text: "אשר", payload: "approve:123" } }), "אשר");
  check(
    "an interactive reply button",
    messageBody({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "a", title: "אשר ביטול" } } }),
    "אשר ביטול"
  );
  check(
    "an interactive list pick",
    messageBody({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "s1", title: "דעה לא פופולרית" } } }),
    "דעה לא פופולרית"
  );
  check("an image caption", messageBody({ type: "image", image: { caption: "הנה התמונה", id: "m" } }), "הנה התמונה");
  check("an image with no caption is null, not empty string", messageBody({ type: "image", image: { id: "m" } }), null);
  check("a reaction reads its emoji", messageBody({ type: "reaction", reaction: { emoji: "👍", message_id: "x" } }), "👍");
  check("a type with no readable content is null", messageBody({ type: "location", location: { latitude: 32, longitude: 34 } }), null);
  // 🔴 the rule stage 1 exists for: an unknown type is LOGGED, never refused
  check("a type Meta adds next year is null and does NOT throw", messageBody({ type: "hologram", hologram: {} }), null);
  check("a missing type is null", messageBody({}), null);
  check("an empty text body collapses to null rather than an empty string", messageBody({ type: "text", text: { body: "   " } }), null);
}

console.log("\n=== 5. parsing a Meta delivery ===");
{
  const one = parseInboundMessages(delivery([textMessage("wamid.AAA", "היי, רוצה לקבוע")]));
  check("one message in, one out", one.length, 1);
  check("wamid", one[0]?.wamid, "wamid.AAA");
  check("wa_id is normalized", one[0]?.waId, "972501234567");
  check("the raw sender is kept alongside", one[0]?.rawFrom, "972501234567");
  check("type", one[0]?.type, "text");
  check("body", one[0]?.body, "היי, רוצה לקבוע");

  const three = parseInboundMessages(
    delivery([textMessage("wamid.1", "א"), textMessage("wamid.2", "ב"), textMessage("wamid.3", "ג")])
  );
  check("three messages in one delivery, in arrival order", three.map((m) => m.wamid), ["wamid.1", "wamid.2", "wamid.3"]);

  // 🔴 statuses share the `messages` field and must NOT become log rows
  const statusesOnly = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "PNID" },
              statuses: [{ id: "wamid.OUT", status: "delivered", recipient_id: "972501234567" }],
            },
          },
        ],
      },
    ],
  };
  check("a delivery carrying only statuses yields nothing", parseInboundMessages(statusesOnly).length, 0);

  // a non-message field on the same subscription
  check(
    "a non-'messages' field is skipped entirely",
    parseInboundMessages(delivery([textMessage("wamid.X", "x")], "message_template_status_update")).length,
    0
  );

  // the one thing that gets a message dropped
  check(
    "a message with no id is dropped — it cannot be de-duplicated",
    parseInboundMessages(delivery([{ from: "972501234567", type: "text", text: { body: "אין לי id" } }])).length,
    0
  );
  check(
    "and it does not take its neighbours with it",
    parseInboundMessages(
      delivery([{ from: "972501234567", type: "text", text: { body: "אין id" } }, textMessage("wamid.OK", "יש")])
    ).map((m) => m.wamid),
    ["wamid.OK"]
  );

  // an unnormalizable sender is KEPT — that is the whole point of the loose CHECK
  const weird = parseInboundMessages(delivery([textMessage("wamid.W", "שלום", "not-a-number")]));
  check("an unnormalizable sender still produces a row", weird.length, 1);
  check("waId is null", weird[0]?.waId, null);
  check("and the raw value survives for the fallback", weird[0]?.rawFrom, "not-a-number");

  // garbage at every level, none of it throwing
  check("null payload", parseInboundMessages(null).length, 0);
  check("a string payload", parseInboundMessages("nope").length, 0);
  check("an empty object", parseInboundMessages({}).length, 0);
  check("entry is not an array", parseInboundMessages({ entry: "x" }).length, 0);
  check("changes is not an array", parseInboundMessages({ entry: [{ changes: 7 }] }).length, 0);
  check("messages is not an array", parseInboundMessages({ entry: [{ changes: [{ field: "messages", value: { messages: 3 } }] }] }).length, 0);
  check("a null message inside the array", parseInboundMessages(delivery([null, textMessage("wamid.S", "ok")])).map((m) => m.wamid), ["wamid.S"]);

  // the body cap, enforced before the insert because 0101's CHECK would refuse the row
  const long = "א".repeat(BODY_MAX_CHARS + 500);
  const capped = parseInboundMessages(delivery([textMessage("wamid.LONG", long)]));
  check("an over-long body is truncated, not dropped", Array.from(capped[0]?.body ?? "").length, BODY_MAX_CHARS);
  check("the cap matches 0101's CHECK", BODY_MAX_CHARS, 8000);
}

console.log("\n=== 6. de-dup: the rows handed to the database ===");
{
  // The de-dup itself is the UNIQUE index (0101) and is proven by
  // supabase/verify/0101_dryrun.sql against a real table. What is assertable
  // HERE is that the key the index needs is present, identical across a
  // re-delivery, and unique within one delivery.
  const payload = delivery([textMessage("wamid.AAA", "היי")]);
  const first = toWaMessageRows(parseInboundMessages(payload));
  const redelivered = toWaMessageRows(parseInboundMessages(payload));

  check("one row", first.length, 1);
  check("the de-dup key is carried", first[0]?.wamid, "wamid.AAA");
  check(
    "Meta re-delivering the SAME payload produces the SAME key — which is what makes the retry a no-op",
    redelivered[0]?.wamid,
    first[0]?.wamid
  );
  check("the whole row is identical on re-delivery", JSON.stringify(redelivered[0]), JSON.stringify(first[0]));

  const many = toWaMessageRows(
    parseInboundMessages(delivery([textMessage("wamid.1", "א"), textMessage("wamid.2", "ב"), textMessage("wamid.1", "א")]))
  );
  check("a delivery that repeats a wamid within itself still yields 3 rows...", many.length, 3);
  check("...but only 2 distinct keys, so the index collapses them to 2", new Set(many.map((r) => r.wamid)).size, 2);

  // the shape 0101's CHECKs demand of an inbound row
  check("direction is 'in'", first[0]?.direction, "in");
  check("status is 'received' — the pair CHECK requires exactly this for an inbound row", first[0]?.status, "received");
  check("template_name is null — there is no template on a message a client sent", first[0]?.template_name, null);
  check("the payload is the message object itself", JSON.stringify(first[0]?.payload), JSON.stringify(parseInboundMessages(payload)[0]?.raw));

  // the wa_id fallback, and its 32-char cap (0101's wa_id CHECK)
  const fallback = toWaMessageRows(parseInboundMessages(delivery([textMessage("wamid.W", "x", "not-a-number")])));
  check("an unnormalizable sender falls back to the raw value", fallback[0]?.wa_id, "not-a-number");
  const huge = toWaMessageRows(parseInboundMessages(delivery([textMessage("wamid.H", "x", "9".repeat(60))])));
  check("a 60-char sender is capped to 32 so the CHECK cannot refuse the row", Array.from(huge[0]?.wa_id ?? "").length, 32);
  const empty = toWaMessageRows(parseInboundMessages(delivery([{ id: "wamid.E", type: "text", text: { body: "x" } }])));
  check("a sender that is missing entirely becomes 'unknown', never an empty string", empty[0]?.wa_id, "unknown");
}

console.log("\n=== 7. the DRY_RUN switch (rule 40) ===");
{
  const original = process.env.WHATSAPP_DRY_RUN;
  try {
    delete process.env.WHATSAPP_DRY_RUN;
    check("UNSET means dry run — the default is on", isWhatsappDryRun(), true);
    process.env.WHATSAPP_DRY_RUN = "false";
    check("the exact string 'false' is the only thing that sends", isWhatsappDryRun(), false);
    process.env.WHATSAPP_DRY_RUN = "true";
    check("'true' is a dry run", isWhatsappDryRun(), true);
    process.env.WHATSAPP_DRY_RUN = "fasle";
    check("🔴 a TYPO stays a dry run — this is why the comparison is !== 'false'", isWhatsappDryRun(), true);
    process.env.WHATSAPP_DRY_RUN = "False";
    check("capitalised 'False' is a dry run", isWhatsappDryRun(), true);
    process.env.WHATSAPP_DRY_RUN = " false ";
    check("a padded 'false' is a dry run — no trimming, no guessing", isWhatsappDryRun(), true);
    process.env.WHATSAPP_DRY_RUN = "";
    check("an empty value is a dry run", isWhatsappDryRun(), true);
  } finally {
    if (original === undefined) delete process.env.WHATSAPP_DRY_RUN;
    else process.env.WHATSAPP_DRY_RUN = original;
  }
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
