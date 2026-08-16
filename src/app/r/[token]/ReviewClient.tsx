"use client";

import { useState } from "react";
import { classifyDriveLink } from "@/lib/review/drive";

// The client-facing review UI. Mobile-first — it opens from WhatsApp. Two
// blocks (episode / reels), each independently approved or sent back with a
// note. An already-approved track shows locked ✓ and can't be reopened.

type Choice = "approved" | "revisions" | null;

export type ReviewAddon = { id: string; title: string; quantity: number; unit_price: number; total: number };

// mirrors ReviewItem from lib/review/links (redeclared locally like
// ReviewAddon — this is a client component)
export type ReviewItemView = {
  id: string;
  kind: "episode" | "reel";
  reel_index: number | null;
  media_link: string | null;
};

const NIS = new Intl.NumberFormat("he-IL");

const card: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 18,
  padding: 18,
  background: "rgba(255,255,255,0.035)",
  marginBottom: 14,
};

// stage-0 media rendering, shared by the track blocks and the per-item boxes:
// a Drive FILE link gets the embedded player (/preview), anything else keeps
// the plain button
function MediaView({ link }: { link: string }) {
  const media = classifyDriveLink(link);
  if (media.type !== "file") {
    return (
      <a
        href={media.url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "block",
          textAlign: "center",
          border: "1px solid rgba(255,255,255,0.14)",
          borderRadius: 12,
          padding: "10px",
          fontSize: 14,
          color: "#c9c3e8",
          marginBottom: 12,
          textDecoration: "none",
        }}
      >
        ▶ צפייה
      </a>
    );
  }
  return (
    <div style={{ marginBottom: 12 }}>
      <iframe
        src={media.embedUrl}
        allow="autoplay; fullscreen"
        allowFullScreen
        style={{
          width: "100%",
          aspectRatio: "16 / 9",
          border: "1px solid rgba(255,255,255,0.14)",
          borderRadius: 12,
          background: "rgba(0,0,0,0.25)",
        }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          marginTop: 6,
        }}
      >
        <span style={{ fontSize: 11, color: "#9a94b8" }}>
          אם הסרטון לא מוצג — פתחו בטאב חדש
        </span>
        <a
          href={media.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 12, color: "#c9c3e8", textDecoration: "none", whiteSpace: "nowrap" }}
        >
          פתח בטאב חדש ↗
        </a>
      </div>
    </div>
  );
}

export default function ReviewClient({
  token,
  showName,
  episodeLabel,
  recordDate,
  episodeIncluded,
  reelsIncluded,
  episodeApproved,
  reelsApproved,
  episodeLink,
  reelsLink,
  addons,
  items = [],
}: {
  token: string;
  showName: string;
  episodeLabel: string;
  recordDate: string | null;
  episodeIncluded: boolean;
  reelsIncluded: boolean;
  episodeApproved: boolean;
  reelsApproved: boolean;
  episodeLink: string | null;
  reelsLink: string | null;
  addons: ReviewAddon[];
  // per-deliverable items (0057). Empty → the production predates the items
  // model and the page renders the original track-level layout unchanged.
  items?: ReviewItemView[];
}) {
  const [epChoice, setEpChoice] = useState<Choice>(null);
  const [epNote, setEpNote] = useState("");
  const [reChoice, setReChoice] = useState<Choice>(null);
  const [reNote, setReNote] = useState("");
  // each quoted upsell starts checked — a quote the client accepts by default
  // and unchecks to decline (owner spec 2026-07-21)
  const [addonOk, setAddonOk] = useState<Record<string, boolean>>(
    () => Object.fromEntries(addons.map((a) => [a.id, true]))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | "approved" | "revisions">(null);

  const episodePending = episodeIncluded && !episodeApproved;
  const reelsPending = reelsIncluded && !reelsApproved;
  // the submit becomes the big "approve everything" action once every
  // pending track is set to approved and none to revisions
  const willApproveAll =
    (!episodePending || epChoice === "approved") &&
    (!reelsPending || reChoice === "approved") &&
    epChoice !== "revisions" &&
    reChoice !== "revisions";

  async function submit() {
    setError(null);
    if (episodePending && !epChoice && !(reelsPending && reChoice)) {
      setError("בחר אישור או תיקונים");
      return;
    }
    if (episodePending && epChoice === "revisions" && !epNote.trim()) {
      setError("נא לפרט מה לתקן בפרק");
      return;
    }
    if (reelsPending && reChoice === "revisions" && !reNote.trim()) {
      setError("נא לפרט מה לתקן ברילז");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/r/${token}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          episode: episodePending ? epChoice ?? undefined : undefined,
          episode_note: epNote,
          reels: reelsPending ? reChoice ?? undefined : undefined,
          reels_note: reNote,
          addons: Object.fromEntries(addons.map((a) => [a.id, addonOk[a.id] ? "approved" : "rejected"])),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "שליחה נכשלה");
        return;
      }
      setDone(body.approved_all ? "approved" : "revisions");
    } catch {
      setError("שגיאת רשת");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div style={{ ...card, textAlign: "center", padding: 32 }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>{done === "approved" ? "✅" : "📝"}</div>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
          {done === "approved" ? "אושר — תודה!" : "התקבל, תודה!"}
        </h2>
        <p style={{ fontSize: 14, color: "#9a94b8" }}>
          {done === "approved" ? "העברנו את האישור לצוות." : "העברנו את ההערות לצוות והם יחזרו אליך."}
        </p>
      </div>
    );
  }

  const Block = ({
    emoji,
    title,
    approved,
    pending,
    link,
    choice,
    setChoice,
    note,
    setNote,
    notePlaceholder,
  }: {
    emoji: string;
    title: string;
    approved: boolean;
    pending: boolean;
    link: string | null;
    choice: Choice;
    setChoice: (c: Choice) => void;
    note: string;
    setNote: (s: string) => void;
    notePlaceholder: string;
  }) => (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 22 }}>{emoji}</span>
        <span style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>{title}</span>
        {approved && <span style={{ color: "#4ade80", fontSize: 13, fontWeight: 700 }}>✓ אושר</span>}
      </div>
      {link && <MediaView link={link} />}
      {pending && (
        <>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => setChoice("approved")}
              style={{
                flex: 1,
                padding: "10px",
                borderRadius: 12,
                fontSize: 14,
                fontWeight: 700,
                border: choice === "approved" ? "1px solid #4ade80" : "1px solid rgba(255,255,255,0.14)",
                background: choice === "approved" ? "rgba(74,222,128,0.15)" : "transparent",
                color: choice === "approved" ? "#4ade80" : "#ece9f5",
              }}
            >
              ✓ מאשר
            </button>
            <button
              onClick={() => setChoice("revisions")}
              style={{
                flex: 1,
                padding: "10px",
                borderRadius: 12,
                fontSize: 14,
                fontWeight: 700,
                border: choice === "revisions" ? "1px solid #fbbf24" : "1px solid rgba(255,255,255,0.14)",
                background: choice === "revisions" ? "rgba(251,191,36,0.15)" : "transparent",
                color: choice === "revisions" ? "#fbbf24" : "#ece9f5",
              }}
            >
              ✎ תיקונים
            </button>
          </div>
          {choice === "revisions" && (
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={notePlaceholder}
              rows={3}
              style={{
                width: "100%",
                marginTop: 10,
                background: "rgba(0,0,0,0.25)",
                border: "1px solid rgba(255,255,255,0.14)",
                borderRadius: 12,
                padding: 10,
                color: "#ece9f5",
                fontSize: 14,
                fontFamily: "inherit",
                resize: "vertical",
              }}
            />
          )}
        </>
      )}
    </div>
  );

  return (
    <div style={{ width: "100%", maxWidth: 420 }}>
      <div style={{ textAlign: "center", marginBottom: 18 }}>
        <h1 style={{ fontSize: 20, fontWeight: 800 }}>{showName}</h1>
        <p style={{ fontSize: 13, color: "#9a94b8", marginTop: 4 }}>
          {episodeLabel}
          {recordDate ? ` · ${recordDate}` : ""}
        </p>
      </div>

      {(() => {
        // item-based layout (0057): a box per deliverable, each with its own
        // player. The APPROVAL controls stay exactly as before — one decision
        // for the episode (on its box), one decision covering all the reels
        // (on a single controls box after them). A production without items
        // renders the original track-level layout.
        const episodeItem = items.find((i) => i.kind === "episode") ?? null;
        const reelItems = items.filter((i) => i.kind === "reel");
        const hasItems = items.length > 0;

        if (!hasItems) {
          return (
            <>
              {episodeIncluded && (
                <Block
                  emoji="🎬"
                  title="הפרק המלא"
                  approved={episodeApproved}
                  pending={episodePending}
                  link={episodeLink}
                  choice={epChoice}
                  setChoice={setEpChoice}
                  note={epNote}
                  setNote={setEpNote}
                  notePlaceholder="מה לתקן בפרק?"
                />
              )}
              {reelsIncluded && (
                <Block
                  emoji="📱"
                  title="רילז"
                  approved={reelsApproved}
                  pending={reelsPending}
                  link={reelsLink}
                  choice={reChoice}
                  setChoice={setReChoice}
                  note={reNote}
                  setNote={setReNote}
                  notePlaceholder="מה לתקן ברילז?"
                />
              )}
            </>
          );
        }

        return (
          <>
            {episodeIncluded && (
              <Block
                emoji="🎬"
                title="פרק מלא"
                approved={episodeApproved}
                pending={episodePending}
                link={episodeItem?.media_link || episodeLink}
                choice={epChoice}
                setChoice={setEpChoice}
                note={epNote}
                setNote={setEpNote}
                notePlaceholder="מה לתקן בפרק?"
              />
            )}
            {reelsIncluded &&
              reelItems.map((it) => {
                // an item with no link of its own falls back to the round's
                // shared reels link (legacy mints fill only that)
                const mediaLink = it.media_link || reelsLink;
                return (
                  <div key={it.id} style={card}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      <span style={{ fontSize: 22 }}>📱</span>
                      <span style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>{`ריל ${it.reel_index}`}</span>
                    </div>
                    {mediaLink && <MediaView link={mediaLink} />}
                  </div>
                );
              })}
            {reelsIncluded && reelItems.length > 0 && (
              <Block
                emoji="📱"
                title="רילז — אישור לכולם"
                approved={reelsApproved}
                pending={reelsPending}
                link={null}
                choice={reChoice}
                setChoice={setReChoice}
                note={reNote}
                setNote={setReNote}
                notePlaceholder="מה לתקן ברילז?"
              />
            )}
            {reelsIncluded && reelItems.length === 0 && (
              <Block
                emoji="📱"
                title="רילז"
                approved={reelsApproved}
                pending={reelsPending}
                link={reelsLink}
                choice={reChoice}
                setChoice={setReChoice}
                note={reNote}
                setNote={setReNote}
                notePlaceholder="מה לתקן ברילז?"
              />
            )}
          </>
        );
      })()}

      {addons.length > 0 && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 22 }}>➕</span>
            <span style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>תוספות</span>
          </div>
          <p style={{ fontSize: 12, color: "#9a94b8", marginBottom: 12 }}>
            סמן את התוספות שברצונך לאשר. הסרת סימון = לא מאשר.
          </p>
          {addons.map((a) => {
            const on = addonOk[a.id];
            return (
              <button
                key={a.id}
                onClick={() => setAddonOk((prev) => ({ ...prev, [a.id]: !prev[a.id] }))}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  textAlign: "right",
                  padding: "10px 12px",
                  marginBottom: 8,
                  borderRadius: 12,
                  border: on ? "1px solid #4ade80" : "1px solid rgba(255,255,255,0.14)",
                  background: on ? "rgba(74,222,128,0.12)" : "transparent",
                  color: "#ece9f5",
                  cursor: "pointer",
                }}
              >
                <span style={{ fontSize: 16, color: on ? "#4ade80" : "#6b6685" }}>{on ? "☑" : "☐"}</span>
                <span style={{ flex: 1 }}>
                  <span style={{ display: "block", fontSize: 14, fontWeight: 600 }}>{a.title}</span>
                  <span style={{ display: "block", fontSize: 12, color: "#9a94b8", marginTop: 2 }}>
                    {a.quantity} × ₪{NIS.format(a.unit_price)}
                  </span>
                </span>
                <span style={{ fontSize: 14, fontWeight: 700 }}>₪{NIS.format(a.total)}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* the price summary card (base episode amount + total) is deliberately
          gone — the client sees no episode price here (Q1, owner 2026-08-16).
          Add-on prices above stay: the client is approving those quotes. */}

      {error && (
        <div style={{ color: "#fb7185", fontSize: 13, textAlign: "center", marginBottom: 10 }}>{error}</div>
      )}

      <button
        onClick={submit}
        disabled={busy}
        style={{
          width: "100%",
          maxWidth: 420,
          padding: "14px",
          borderRadius: 14,
          fontSize: 16,
          fontWeight: 800,
          border: "none",
          background: "linear-gradient(135deg, #8b5cf6, #6d28d9)",
          color: "white",
          opacity: busy ? 0.5 : 1,
          boxShadow: "0 6px 20px rgba(139,92,246,0.35)",
        }}
      >
        {busy ? "שולח…" : willApproveAll ? "✓ מאשר את כל התוצרים" : "שלח תשובה"}
      </button>
    </div>
  );
}
