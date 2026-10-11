import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { isRegistrationEnabled } from "@/lib/registration/switch";
import { resolveRegistrationLink } from "@/lib/registration/links";
import { displayWaId } from "@/lib/whatsapp/phone";
import { whatsappNumberFrom } from "@/lib/booking/publicView";
import JoinForm from "./JoinForm";
import { JoinDeadLink } from "./JoinScreens";

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC registration page (E17-4). The token is the only credential — no
// account, no session, and never getSessionAndProfile (same rule as /b).
// ═══════════════════════════════════════════════════════════════════════════
//
// 🔴 SWITCH OFF = 404. Not a "closed" screen: with REGISTRATION_ENABLED off
// the route does not exist as far as anyone outside can tell.

export const dynamic = "force-dynamic";

/** noindex + no-referrer: the URL carries the credential (same as /b). Generic title. */
export const metadata: Metadata = {
  title: "Bizi Podclub — פתיחת לקוח",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function JoinPage({ params }: { params: { token: string } }) {
  if (!isRegistrationEnabled()) notFound();

  const whatsappNumber = whatsappNumberFrom(process.env.STUDIO_WHATSAPP_NUMBER);
  const state = await resolveRegistrationLink(createTypedAdminClient(), params.token, new Date());
  if (state.status !== "ok") return <JoinDeadLink whatsappNumber={whatsappNumber} />;

  return (
    <JoinForm
      token={params.token}
      lockedNumber={state.link.wa_id ? displayWaId(state.link.wa_id) : null}
      whatsappNumber={whatsappNumber}
    />
  );
}
