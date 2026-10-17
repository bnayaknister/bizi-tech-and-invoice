import { cache } from "react";
import type { Metadata } from "next";
import { createAdminClient, createTypedAdminClient } from "@/lib/supabase/admin";
import { loadClientVersions, type ClientVersion } from "@/lib/review/clientVersions";
import { loadClientComments, type ClientComment } from "@/lib/review/itemComments";
import { resolveLink } from "@/lib/review/links";
import { displayDate } from "@/lib/dates";
import ReviewClient from "./ReviewClient";

// PUBLIC, account-less review page (screens-spec §9a). It is outside the app
// shell and the auth wall (see middleware). It exposes ONLY the show name,
// episode, and date — never money, never anything else about the system.
export const dynamic = "force-dynamic";

// generateMetadata and the page body run in the same request — React cache()
// dedupes the token resolution so the DB is hit once, without touching
// resolveLink itself.
const getLinkState = cache(async (token: string) => resolveLink(createAdminClient(), token));

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
  // Full year here, unlike the two dense lists: this string lands in a
  // WhatsApp preview card that stays in the client's history for months, and
  // it is the one date on it. Nothing else in the card says which year.
  const date = displayDate(p.record_date);
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

  // E13-7: an answered link no longer stops here — it resolves "ok" in
  // post_response mode (view + download, responding locked) until a newer
  // overlapping link replaces it, and then it lands on the notice below.
  if (state.status === "superseded") {
    return <Notice title="יש קישור חדש יותר" sub="נשלח קישור עדכני יותר להפקה זו. פנו ל-Bizi Podclub." />;
  }
  if (state.status === "expired") {
    return <Notice title="הלינק אינו זמין" sub="תוקף הקישור פג. פנו ל-Bizi Podclub." />;
  }
  if (state.status !== "ok") {
    return <Notice title="הלינק אינו זמין" sub="ייתכן שפג תוקפו או שנשלח קישור עדכני יותר. פנו ל-Bizi Podclub." />;
  }

  // E13-6: the versions each item may show. Rule 38: any failure here (a read,
  // a signing key) leaves the page exactly as it was before E13-6 — today's
  // Drive view — and never breaks it.
  let versionsByItem: Record<string, ClientVersion[]> = {};
  try {
    versionsByItem = await loadClientVersions(createTypedAdminClient(), state.items.map((i) => i.id));
  } catch (e) {
    console.warn(JSON.stringify({ tag: "review_page_versions_failed", link_id: state.link.id, error: e instanceof Error ? e.message : String(e) }));
  }

  // E13-8b: the client's comments, re-approvable items, each item's current
  // version. Same rule 38: a failure leaves the page as E13-7 left it — no
  // comment box (it would have no version to name), no re-approve.
  let commentsByItem: Record<string, ClientComment[]> = {};
  let reapprovable: Record<string, boolean> = {};
  let currentVersion: Record<string, string | null> = {};
  let commentsReady = false;
  try {
    const c = await loadClientComments(createTypedAdminClient(), state.items, state.link.id);
    commentsByItem = c.comments;
    reapprovable = c.reapprovable;
    currentVersion = c.currentVersion;
    commentsReady = true;
  } catch (e) {
    console.warn(JSON.stringify({ tag: "review_page_comments_failed", link_id: state.link.id, error: e instanceof Error ? e.message : String(e) }));
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
        transcript={state.transcript}
        audioLink={state.link.audio_link}
        versionsByItem={versionsByItem}
        respondedAt={state.mode === "post_response" ? state.link.responded_at : null}
        comments={commentsByItem}
        reapprovable={reapprovable}
        currentVersion={commentsReady ? currentVersion : undefined}
      />
    </Shell>
  );
}
