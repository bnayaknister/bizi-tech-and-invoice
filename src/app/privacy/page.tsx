import type { Metadata } from "next";
import PrivacyBody from "./PrivacyBody";

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC privacy policy — the URL Meta's app settings point at (/privacy and
// /privacy#deletion). Auth-FREE, like /b/[token]: no session read, no
// database, so Meta's reviewer and a client get the same page. The wording
// lives in lib/legal/privacy.ts, not here.
// ═══════════════════════════════════════════════════════════════════════════

export const metadata: Metadata = {
  title: "Bizi Podclub — מדיניות פרטיות",
};

export default function PrivacyPage() {
  return <PrivacyBody />;
}
