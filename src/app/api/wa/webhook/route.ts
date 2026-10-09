import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import {
  parseInboundMessages,
  parseStatusUpdates,
  toWaMessageRows,
  verifyHandshake,
  verifyWebhookSignature,
} from "@/lib/whatsapp/webhook";
import { applyStatusUpdate } from "@/lib/whatsapp/notify";
import { replyToInbound } from "@/lib/whatsapp/reply";

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
// ═══ E9-3: IT NOW SPEAKS, AND IT NOW LISTENS TO STATUSES ═══
// E9-1's header said "it sends nothing". That is no longer true, and the three
// things it does are in a deliberate order:
//   1. RECORD every inbound message (unchanged — the de-dup is the gate)
//   2. apply every delivery-status update to the row it belongs to
//   3. REPLY, but **only to messages step 1 actually inserted**
//
// 🔴 STEP 3's CONDITION IS THE "DO NOT ANSWER TWICE" LOCK. Meta re-delivers any
// webhook that did not get a 200, so the same client message arrives more than
// once as a matter of course. `upsert … ignoreDuplicates` returns ONLY the rows
// it inserted, so a re-delivery yields an empty list and the bot stays silent.
// `replyWamid` (reply.ts) is the second lock behind the same unique index.
//
// ⚠️ AND THE REPLY IS AWAITED, NOT FIRED AND FORGOTTEN. Vercel kills work that
// outlives the response, so a floating promise here is a reply that sometimes
// does not happen — and "sometimes" is the worst possible failure mode for a
// client waiting on their booking link. The cost is a slower 200, which Meta
// tolerates; a dropped reply it does not report at all.
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

  // The TYPED client, again. 0102 (`provider_wamid`, `error`, `status_at`) was
  // applied on 2026-10-09 and `database.types.ts` regenerated against it, so
  // every column the status path and the reply path touch is vouched for by
  // the drift check. Like 0101 before it, the untyped client lasted exactly
  // the window between writing the migration and the owner applying it.
  const admin = createTypedAdminClient();

  // ── step 2: delivery statuses ─────────────────────────────────
  // Before the messages, because a delivery can carry both and a status about
  // a notification we sent is independent of any inbound message in the same
  // payload. Each one is matched on `provider_wamid` — never on our own
  // `wamid`, which Meta has never seen (0102's header).
  const statuses = parseStatusUpdates(payload);
  let statusesApplied = 0;
  for (const st of statuses) {
    const outcome = await applyStatusUpdate(admin, st);
    if (outcome === "applied") statusesApplied++;
  }

  const messages = parseInboundMessages(payload);
  if (messages.length === 0) {
    // The common case now that E9-3 sends: a delivery carrying only receipts.
    return NextResponse.json(
      { ok: true, received: 0, stored: 0, statuses: statuses.length, statusesApplied },
      { status: 200, headers: NO_STORE }
    );
  }

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

  // ── step 3: reply, ONLY to what we just inserted ───────────────────
  const storedIds = new Set((data ?? []).map((d) => d.wamid));
  let replied = 0;
  for (const m of messages) {
    if (!storedIds.has(m.wamid)) continue; // a re-delivery. Already answered.
    const outcome = await replyToInbound(admin, request, m);
    if (outcome.sent) replied++;
  }

  return NextResponse.json(
    {
      ok: true,
      received: rows.length,
      stored: storedIds.size,
      statuses: statuses.length,
      statusesApplied,
      replied,
    },
    { status: 200, headers: NO_STORE }
  );
}
