"use client";

import { useState } from "react";

// The client-facing review UI. Mobile-first — it opens from WhatsApp. Two
// blocks (episode / reels), each independently approved or sent back with a
// note. An already-approved track shows locked ✓ and can't be reopened.

type Choice = "approved" | "revisions" | null;

const card: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 18,
  padding: 18,
  background: "rgba(255,255,255,0.035)",
  marginBottom: 14,
};

export default function ReviewClient({
  token,
  showName,
  episodeLabel,
  recordDate,
  reelsIncluded,
  episodeApproved,
  reelsApproved,
  episodeLink,
  reelsLink,
}: {
  token: string;
  showName: string;
  episodeLabel: string;
  recordDate: string | null;
  reelsIncluded: boolean;
  episodeApproved: boolean;
  reelsApproved: boolean;
  episodeLink: string | null;
  reelsLink: string | null;
}) {
  const [epChoice, setEpChoice] = useState<Choice>(null);
  const [epNote, setEpNote] = useState("");
  const [reChoice, setReChoice] = useState<Choice>(null);
  const [reNote, setReNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | "approved" | "revisions">(null);

  const episodePending = !episodeApproved;
  const reelsPending = reelsIncluded && !reelsApproved;

  async function submit() {
    setError(null);
    if (episodePending && !epChoice && !(reelsPending && reChoice)) {
      setError("בחר אישור או תיקונים");
      return;
    }
    if (epChoice === "revisions" && !epNote.trim()) {
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
      {link && (
        <a
          href={link}
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
      )}
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
        {busy ? "שולח…" : "שלח תשובה"}
      </button>
    </div>
  );
}
