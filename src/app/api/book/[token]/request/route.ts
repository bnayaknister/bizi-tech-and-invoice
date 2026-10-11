import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { resolveBookingLink } from "@/lib/booking/links";
import { submitBookingRequest, type SubmitResult } from "@/lib/booking/submit";

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/book/[token]/request — PUBLIC. The token is the only credential.
// ═══════════════════════════════════════════════════════════════════════════
//
// The ONLY write a client can cause anywhere in this system, and it inserts
// exactly one row with `status = 'pending'`. It cannot approve, cannot touch
// the calendar, cannot reach any other table. Everything it decides lives in
// @/lib/booking/request as pure functions; this file authenticates the token,
// asks those functions, and forwards their answer.
//
// ⚠️ AVAILABILITY IS RECOMPUTED HERE, SERVER-SIDE, and the client's opinion of
// which slots are free is never consulted. The page fetched its grid some
// seconds or minutes ago; between then and now the owner may have approved
// somebody else. The end time likewise comes from the SLOT and not from the
// body — see matchSlot.
//
// ⚠️ EVERY SENTENCE BELOW IS APPROVED COPY, WORD FOR WORD (owner, 23.9). The
// generic failure is deliberately vague: a stranger holding a link must not be
// able to tell a rate limit from a database error from a bad token, because
// each distinction is a probe that tells them something about the studio.

export const dynamic = "force-dynamic";

const HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

const COPY = {
  taken: "המועד הזה נתפס בינתיים. בחרו מועד אחר.",
  tooMany: "יש כבר כמה בקשות שממתינות לאישור. נחזור אליכם עליהן קודם.",
  guestTooLong: "שם האורח ארוך מדי.",
  generic: "לא הצלחנו לשלוח את הבקשה. נסו שוב בעוד כמה דקות.",
} as const;

const fail = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status, headers: HEADERS });

export async function POST(request: Request, { params }: { params: { token: string } }) {
  const admin = createTypedAdminClient();

  const link = await resolveBookingLink(admin, params.token);
  // A dead token gets the GENERIC sentence, not a "link expired" one: the page
  // already renders the dead-link screen, and an API that distinguishes states
  // is a probe. Same reasoning as resolveBookingLink's single failure value.
  if (link.status !== "ok") return fail(COPY.generic, 404);

  const body = (await request.json().catch(() => ({}))) as {
    studio?: unknown;
    startIsrael?: unknown;
    endIsrael?: unknown;
    guest?: unknown;
    note?: unknown;
    durationMinutes?: unknown;
  };

  // 🔴 EVERYTHING FROM HERE ON IS @/lib/booking/submit (E9-4). The body that
  // used to live in this file moved there verbatim, because the WhatsApp bot's
  // booking conversation must take exactly the same path (owner decision 11.10,
  // rule 5). This route now authenticates the token, hands over the raw body,
  // and maps each outcome to its approved sentence and status — nothing else.
  const result = await submitBookingRequest(admin, {
    showId: link.link.show_id,
    linkId: link.link.id,
    // from the RESOLVED LINK, which already read it — not a second join
    showName: link.show.name,
    studio: body.studio,
    startIsrael: body.startIsrael,
    endIsrael: body.endIsrael,
    guest: body.guest,
    note: body.note,
    durationMinutes: body.durationMinutes,
  });

  if (!result.ok) return failFor(result.code);

  return NextResponse.json(
    { ok: true, duplicate: result.duplicate, request: result.request },
    { headers: HEADERS }
  );
}

/**
 * Each refusal -> the sentence and status this route has always answered with.
 * The generic sentence covers bad input, a feed failure and a database error
 * alike, on purpose — see the header on why a link-holder must not be able to
 * tell them apart.
 */
function failFor(code: Extract<SubmitResult, { ok: false }>["code"]) {
  switch (code) {
    case "bad-input":
      return fail(COPY.generic, 400);
    case "guest-too-long":
      return fail(COPY.guestTooLong, 400);
    case "feed-failed":
      return fail(COPY.generic, 502);
    case "taken":
      return fail(COPY.taken, 409);
    case "too-many":
      return fail(COPY.tooMany, 429);
    case "error":
      return fail(COPY.generic, 500);
  }
}
