"use client";

import { useState } from "react";

// The client-facing review UI. Mobile-first — it opens from WhatsApp. Two
// blocks (episode / reels), each independently approved or sent back with a
// note. An already-approved track shows locked ✓ and can't be reopened.

type Choice = "approved" | "revisions" | null;

export type ReviewAddon = { id: string; title: string; quantity: number; unit_price: number; total: number };

const NIS = new Intl.NumberFormat("he-IL");

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 14, marginBottom: 6 }}>
      <span style={{ color: "#c9c3e8" }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}

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
  addons,
  baseAmount,
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
  addons: ReviewAddon[];
  baseAmount: number | null;
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

  const episodePending = !episodeApproved;
  const reelsPending = reelsIncluded && !reelsApproved;
  const approvedAddonsTotal = addons
    .filter((a) => addonOk[a.id])
    .reduce((sum, a) => sum + a.total, 0);
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

      {/* full price summary — the client sees exactly what the invoice will
          say (owner decision 2026-07-21: total transparency, no hidden base). */}
      {(baseAmount != null || addons.length > 0) && (
        <div style={card}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>סיכום מחיר</div>
          {baseAmount != null && (
            <Row label="עריכת הפרק המלא" value={`₪${NIS.format(baseAmount)}`} />
          )}
          {addons
            .filter((a) => addonOk[a.id])
            .map((a) => (
              <Row key={a.id} label={`➕ ${a.title}`} value={`₪${NIS.format(a.total)}`} />
            ))}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid rgba(255,255,255,0.1)",
              fontSize: 16,
              fontWeight: 800,
            }}
          >
            <span>סה״כ</span>
            <span>
              ₪{NIS.format((baseAmount ?? 0) + approvedAddonsTotal)}
              <span style={{ fontSize: 12, fontWeight: 500, color: "#9a94b8" }}> + מע״מ</span>
            </span>
          </div>
        </div>
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
        {busy ? "שולח…" : willApproveAll ? "✓ מאשר את כל התוצרים" : "שלח תשובה"}
      </button>
    </div>
  );
}
