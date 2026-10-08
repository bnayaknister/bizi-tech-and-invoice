import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  parseInboundMessages,
  toWaMessageRows,
  verifyHandshake,
  verifyWebhookSignature,
} from "@/lib/whatsapp/webhook";

// ═══════════════════════════════════════════════════════════════════════════
// /api/wa/webhook — WhatsApp Cloud API. E9-1.
// ═══════════════════════════════════════════════════════════════════════════
//
// 🔴 THE FIRST INBOUND WEBHOOK IN THIS APPLICATION. Nothing else here is
// reachable from outside without either a session cookie, a token in the URL
// (`/r/`, `/b/`) or `CRON_SECRET`. This route is reachable by anyone who knows
// the address, so the signature IS the gate — and the gate is the whole of the
// first stage's work.
//
// ⛔ AND IT SENDS NOTHING. Not a reply, not an acknowledgement, not an error
// message. E9-1 records; E9-2 is the first stage that speaks. There is no send
// function in lib/whatsapp/client.ts to call even by accident.
//
// Every DECISION lives in @/lib/whatsapp/webhook as pure functions with a
// suite that runs with no database and no network (F19). This file reads the
// environment, reads the body, asks those functions, and writes rows.
//
// ═══ GET vs POST ═══
//   GET  — Meta's subscription handshake. Echoes `hub.challenge` as plain
//          text, or 403. Called once per webhook configuration, and again
//          whenever the owner edits it in the dashboard.
//   POST — one delivery, carrying zero or more messages.
//
// ═══ 🔴 THE STATUS CODES ARE PART OF THE DESIGN ═══
// Meta RETRIES a delivery that does not get a 2xx, and our de-dup is what
// makes that useful rather than dangerous:
//
//   403  signature missing, malformed, wrong, or no app secret configured.
//        A forged delivery is refused; Meta's own deliveries are signed, so a
//        403 here never costs us a real message.
//   200  verified but there is nothing to store — an unparseable body, a
//        delivery that carries only `statuses`, a field we do not handle, zero
//        messages. Nothing a retry could improve, so the retry is declined.
//   500  verified, parsed, and the WRITE FAILED. This is the one case where a
//        retry is the correct outcome: `wa_messages.wamid` is UNIQUE and the
//        insert is `ignoreDuplicates`, so Meta re-delivering the same payload
//        can only ever store the rows that are still missing. A 200 here would
//        trade a recoverable failure for a permanently lost message — which is
//        precisely the thing stage 1 exists to prevent.
//
// ⚠️ NO MESSAGE CONTENT IN ANY RESPONSE BODY, and no reason strings either.
// The caller is either Meta (which ignores the body) or somebody probing the
// address, and "bad-signature" vs "no-secret" tells a prober which of the two
// env vars is missing. Reasons go to the server log, where they are for us.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const verdict = verifyHandshake(params, process.env.WHATSAPP_VERIFY_TOKEN);

  if (!verdict.ok) {
    // Logged with its reason, because `no-token` is a configuration mistake the
    // owner has to hear about and the other three are just noise from the
    // internet. The CRON_SECRET week (api/calendar/sync/route.ts:45-46) is the
    // precedent: a secret that was never set produced silent refusals for days.
    console.error("wa/webhook: handshake נדחה —", verdict.reason);
    return new NextResponse("forbidden", { status: 403, headers: NO_STORE });
  }

  // VERBATIM, as text/plain. Meta compares the body to the challenge it sent;
  // a JSON-wrapped copy, a trailing newline or a quoted string all read as a
  // failed handshake, and the dashboard says only "unable to verify".
  return new NextResponse(verdict.challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE },
  });
}

export async function POST(request: Request) {
  // 🔴 RAW, AND BEFORE ANYTHING ELSE. `request.text()` and never
  // `request.json()`: the signature covers the bytes Meta sent, and a
  // parse-then-re-serialize round trip changes key order and whitespace, so
  // every re-serialized body fails verification — looking exactly like an
  // attack. The body is read once; `request` has no second read.
  const raw = await request.text();

  const verdict = verifyWebhookSignature(
    raw,
    request.headers.get("x-hub-signature-256"),
    process.env.WHATSAPP_APP_SECRET
  );
  if (!verdict.ok) {
    console.error("wa/webhook: חתימה נדחתה —", verdict.reason);
    return NextResponse.json({ ok: false }, { status: 403, headers: NO_STORE });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Signed by Meta and still not JSON: there is nothing here to store and
    // nothing a retry would fix. 200, and the body length is logged rather
    // than the body — a payload we could not parse is not a payload we should
    // be copying into our logs.
    console.error("wa/webhook: גוף חתום שאינו JSON, bytes=", raw.length);
    return NextResponse.json({ ok: true, stored: 0 }, { status: 200, headers: NO_STORE });
  }

  const messages = parseInboundMessages(payload);
  if (messages.length === 0) {
    // The common case once E9-2 is live: a delivery carrying only delivery
    // receipts. Not an error, and not worth a log line per webhook.
    return NextResponse.json({ ok: true, received: 0, stored: 0 }, { status: 200, headers: NO_STORE });
  }

  // ⚠️ THE UNTYPED CLIENT, DELIBERATELY. `wa_messages` is created by 0101,
  // which the owner applies by hand, and `database.types.ts` is regenerated
  // only after that (supabase/migrations/README.md, step 3) — committing a
  // types entry for a table that does not exist yet would make
  // scripts/check-schema-drift.mjs fail the build on the dangerous "-" side
  // (a type vouching for something absent). Same choice, and the same
  // sentence, as api/bookings/[id]/retry-calendar/route.ts before 0099 was
  // applied.
  const admin = createAdminClient();

  const rows = toWaMessageRows(messages);
  const { data, error } = await admin
    .from("wa_messages")
    // 🔴 THE DE-DUP, AND IT IS THE DATABASE'S UNIQUE INDEX THAT ENFORCES IT —
    // not a select-then-insert, which is the shape that loses a race against
    // Meta's own retry arriving while the first delivery is still being
    // written. `ignoreDuplicates` turns the second delivery into a no-op, and
    // `.select` then returns ONLY the rows that were actually inserted, so
    // `stored` is a true count rather than a hopeful one.
    .upsert(rows, { onConflict: "wamid", ignoreDuplicates: true })
    .select("wamid");

  if (error) {
    // 500 on purpose — see the header. The unique index makes Meta's retry
    // safe, so a retry is strictly better than dropping the message.
    console.error("wa/webhook: רישום ההודעות נכשל", error);
    return NextResponse.json({ ok: false }, { status: 500, headers: NO_STORE });
  }

  return NextResponse.json(
    { ok: true, received: rows.length, stored: (data ?? []).length },
    { status: 200, headers: NO_STORE }
  );
}
