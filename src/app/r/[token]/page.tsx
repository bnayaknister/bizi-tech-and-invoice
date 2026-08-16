import { cache } from "react";
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveLink } from "@/lib/review/links";
import ReviewClient from "./ReviewClient";

// PUBLIC, account-less review page (screens-spec §9a). It is outside the app
// shell and the auth wall (see middleware). It exposes ONLY the show name,
// episode, and date — never money, never anything else about the system.
export const dynamic = "force-dynamic";

// generateMetadata and the page body run in the same request — React cache()
// dedupes the token resolution so the DB is hit once, without touching
// resolveLink itself.
const getLinkState = cache(async (token: string) => resolveLink(createAdminClient(), token));

// "2026-08-11" -> "11.08" — the share-preview date format
function shortDate(recordDate: string | null): string | null {
  const m = recordDate?.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}.${m[1]}` : null;
}

export async function generateMetadata({ params }: { params: { token: string } }): Promise<Metadata> {
  const state = await getLinkState(params.token);

  // any non-ok state gets the generic card — a dead link's preview must not
  // leak the production name (same privacy rule as the page body: no money,
  // and nothing at all through an invalid token)
  if (state.status !== "ok") {
    return {
      title: "Bizi Podclub — לינק צפייה",
      openGraph: { siteName: "Bizi Podclub", title: "Bizi Podclub — לינק צפייה" },
    };
  }

  const p = state.production;
  const episodeIncluded = state.link.scope === "episode" || state.link.scope === "all";
  const reelsIncluded = (state.link.scope === "reels" || state.link.scope === "all") && p.review_reels_required;
  const reelCount = state.items.filter((i) => i.kind === "reel").length;

  const parts: string[] = [];
  if (episodeIncluded) parts.push("פרק מלא");
  if (reelsIncluded) parts.push(reelCount === 1 ? "ריל אחד" : reelCount > 1 ? `${reelCount} רילז` : "רילז");
  const date = shortDate(p.record_date);
  const description = [parts.join(" + "), date].filter(Boolean).join(" · ") || "לצפייה ואישור";

  const title = `${p.podcast_name ?? "הפקה"} — לאישור`;
  return {
    title,
    description,
    openGraph: { siteName: "Bizi Podclub", title, description },
  };
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      dir="rtl"
      style={{
        minHeight: "100vh",
        background: "radial-gradient(120% 100% at 50% 0%, #1a1830 0%, #0b0a16 60%)",
        color: "#ece9f5",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "24px 16px 40px",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', Arial, sans-serif",
      }}
    >
      {/* dir=ltr: the page is RTL, and an RTL flex row would render the Latin
          wordmark reversed ("Podclub Bizi") */}
      <div dir="ltr" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 28, opacity: 0.9 }}>
        <span style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em" }}>Bizi</span>
        <span style={{ fontSize: 12, color: "#9a94b8" }}>Podclub</span>
      </div>
      {children}
    </div>
  );
}

function Notice({ title, sub }: { title: string; sub: string }) {
  return (
    <Shell>
      <div
        style={{
          maxWidth: 380,
          width: "100%",
          textAlign: "center",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 20,
          padding: "40px 24px",
          background: "rgba(255,255,255,0.03)",
        }}
      >
        <div style={{ fontSize: 40, marginBottom: 12 }}>🎬</div>
        <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{title}</h1>
        <p style={{ fontSize: 14, color: "#9a94b8" }}>{sub}</p>
      </div>
    </Shell>
  );
}

export default async function ReviewPage({ params }: { params: { token: string } }) {
  const state = await getLinkState(params.token);

  if (state.status === "responded") {
    return <Notice title="התקבל, תודה!" sub="התשובה שלך נקלטה. אפשר לסגור את החלון." />;
  }
  if (state.status === "superseded") {
    return <Notice title="הלינק אינו זמין" sub="נשלח קישור עדכני יותר להפקה זו. פנו ל-Bizi Podclub." />;
  }
  if (state.status === "expired") {
    return <Notice title="הלינק אינו זמין" sub="תוקף הקישור פג. פנו ל-Bizi Podclub." />;
  }
  if (state.status !== "ok") {
    return <Notice title="הלינק אינו זמין" sub="ייתכן שפג תוקפו או שנשלח קישור עדכני יותר. פנו ל-Bizi Podclub." />;
  }

  const p = state.production;
  const episodeLabel =
    p.split_count && p.split_count > 1 ? `פרק ${p.split_index} מתוך ${p.split_count}` : "הפרק המלא";

  return (
    <Shell>
      <ReviewClient
        token={params.token}
        showName={p.podcast_name ?? "הפקה"}
        episodeLabel={episodeLabel}
        recordDate={p.record_date}
        episodeIncluded={state.link.scope === "episode" || state.link.scope === "all"}
        reelsIncluded={(state.link.scope === "reels" || state.link.scope === "all") && p.review_reels_required}
        episodeApproved={p.review_episode_approved}
        reelsApproved={p.review_reels_approved}
        episodeLink={state.link.episode_link}
        reelsLink={state.link.reels_link}
        addons={state.addons}
        items={state.items}
      />
    </Shell>
  );
}
