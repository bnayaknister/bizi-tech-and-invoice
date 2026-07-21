import { createAdminClient } from "@/lib/supabase/admin";
import { resolveLink } from "@/lib/review/links";
import ReviewClient from "./ReviewClient";

// PUBLIC, account-less review page (screens-spec §9a). It is outside the app
// shell and the auth wall (see middleware). It exposes ONLY the show name,
// episode, and date — never money, never anything else about the system.
export const dynamic = "force-dynamic";

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
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 28, opacity: 0.9 }}>
        <span style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em" }}>ביזי</span>
        <span style={{ fontSize: 12, color: "#9a94b8" }}>סטודיו</span>
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
  const admin = createAdminClient();
  const state = await resolveLink(admin, params.token);

  if (state.status === "responded") {
    return <Notice title="התקבל, תודה!" sub="התשובה שלך נקלטה. אפשר לסגור את החלון." />;
  }
  if (state.status !== "ok") {
    return <Notice title="הלינק אינו זמין" sub="ייתכן שפג תוקפו או שנשלח קישור עדכני יותר. פנה לביזי סטודיו." />;
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
        reelsIncluded={p.review_reels_required && state.link.reels_included}
        episodeApproved={p.review_episode_approved}
        reelsApproved={p.review_reels_approved}
        episodeLink={state.link.episode_link}
        reelsLink={state.link.reels_link}
        addons={state.addons}
      />
    </Shell>
  );
}
