"use client";

import { useState } from "react";

// "שאל אותי כל דבר על העסק" — the AI business-question assistant, on the
// hub (owner spec 2026-07-21). This widget has NO permission logic of its
// own — it just posts the question and renders whatever /api/assistant
// returns. The permission boundary lives entirely server-side (the user's
// own session client + RLS, see src/lib/assistant/tools.ts): a technician
// gets exactly the same widget as the owner, and simply receives an "אין לך
// הרשאה" answer for a money question instead of the widget hiding anything.

export default function AssistantBar() {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setError(null);
    setAnswer(null);
    setOpen(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "שגיאה");
      } else {
        setAnswer(data.answer || "לא התקבלה תשובה.");
      }
    } catch {
      setError("שגיאת רשת");
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="mb-6">
      <form onSubmit={ask} className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="שאל אותי כל דבר על העסק — למשל: מה החוב לגבייה?"
          className="flex-1 border border-[var(--rule)] rounded-xl px-4 py-2.5 text-sm outline-none focus:border-[var(--violet-light)] transition-colors"
          style={{ background: "rgba(255,255,255,0.04)", backdropFilter: "blur(8px)" }}
        />
        <button
          type="submit"
          disabled={asking || !question.trim()}
          className="text-white font-bold rounded-xl px-4 py-2.5 text-sm disabled:opacity-50 shrink-0"
          style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 14px rgba(139,92,246,0.3)" }}
        >
          {asking ? "חושב…" : "שאל"}
        </button>
      </form>

      {open && (
        <div
          className="mt-2 rounded-xl border border-[var(--rule)] px-4 py-3 text-sm"
          style={{ background: "rgba(255,255,255,0.03)", backdropFilter: "blur(8px)" }}
        >
          {asking ? (
            <span className="text-[var(--faint)]">חושב…</span>
          ) : error ? (
            <span className="text-[var(--peak)]">{error}</span>
          ) : (
            <span className="whitespace-pre-wrap">{answer}</span>
          )}
        </div>
      )}
    </div>
  );
}
