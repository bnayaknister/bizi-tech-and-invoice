import { cache } from "react";
import type { Metadata } from "next";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { resolveBookingLink } from "@/lib/booking/links";
import { bookableRoomForDefault } from "@/lib/calendar/rooms";
import { STUDIOS } from "@/lib/calendar/studios";
import { israelDateOf, israelInstant } from "@/lib/calendar/availability";
import { myRequests, whatsappNumberFrom, type RequestRow } from "@/lib/booking/publicView";
import BookClient from "./BookClient";
import DeadLink from "./DeadLink";

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC booking page. The token is the only credential — no account, no
// session, no profile.
// ═══════════════════════════════════════════════════════════════════════════
//
// 🔴 THIS PAGE NEVER CALLS getSessionAndProfile. It is not "auth optional", it
// is auth-FREE: a signed-in owner and a stranger get byte-for-byte the same
// screen. Reading a profile here would be the first step towards a page that
// behaves differently for the two, and the owner would then be previewing
// something no client can see — which is exactly what /calendar/availability
// exists to avoid.
//
// The shape is /r/[token]'s, deliberately: React cache() around the token
// resolution so generateMetadata and the body share ONE database round trip,
// and a single generic notice for every dead-token state.

export const dynamic = "force-dynamic";

const getLinkState = cache(async (token: string) => resolveBookingLink(createTypedAdminClient(), token));

/**
 * ⚠️ NOINDEX AND NO-REFERRER, ON EVERY OUTCOME INCLUDING THE DEAD ONE.
 *
 * noindex/nofollow: the URL contains the credential. A crawler that reaches a
 * link pasted into a public place must not put it in an index where anyone can
 * find it later.
 *
 * referrer: "no-referrer": without it, every outbound click — the WhatsApp
 * button most of all — sends the full URL, token included, in a Referer header
 * to a third party. The metadata emits the meta tag for the document; the two
 * API routes set the header themselves, because a meta tag does not cover a
 * fetch.
 *
 * ⚠️ The title is generic and carries NO show name. A dead or guessed token
 * must not confirm which podcast it belonged to, and a live one lands in a
 * browser tab and a shared-link preview that other people see.
 */
export const metadata: Metadata = {
  title: "Bizi Podclub — הזמנת הקלטה",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function BookPage({ params }: { params: { token: string } }) {
  const state = await getLinkState(params.token);

  // ONE screen for unknown, revoked and malformed alike. A visitor probing
  // tokens learns nothing from the difference, because there is none.
  if (state.status !== "ok") return <DeadLink />;

  const admin = createTypedAdminClient();
  const todayIsrael = israelDateOf(new Date());

  // This show's requests from today onward. Filtered in SQL so old rows never
  // leave the database, and filtered AGAIN by myRequests — the assertable copy
  // is the one that decides what renders.
  const { data: rows } = await admin
    .from("booking_requests")
    .select("id,studio,start_at,guest,status")
    .eq("show_id", state.link.show_id)
    .gte("start_at", israelInstant(todayIsrael, 0, 0).toISOString())
    .order("start_at", { ascending: true });

  return (
    <BookClient
      token={params.token}
      showName={state.show.name}
      defaultRoom={bookableRoomForDefault(state.show.default_studio, STUDIOS)}
      initialRequests={myRequests((rows ?? []) as RequestRow[], todayIsrael)}
      // Resolved on the SERVER and passed as a finished number: the env var is
      // server-only, and an unset one must yield no button rather than a
      // client-side check against a value that never reached the browser.
      whatsappNumber={whatsappNumberFrom(process.env.STUDIO_WHATSAPP_NUMBER)}
    />
  );
}
