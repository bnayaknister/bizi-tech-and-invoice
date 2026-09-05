"use client";

import { useEffect, useState } from "react";

// The client's correction notes from the round they last answered, and the one
// button that closes the loop: "קיבלתי, מטפל" (0071). Until this existed the
// only thing that could clear a production's red dot was the same client
// coming back through a live link and approving everything (links.ts:403) — a
// technician had no way to say the note had been received.
//
// Two endpoints, both scoped to one production: the GET shapes the round for
// display (api/productions/[id]/review-current), the POST records the ack
// against that exact round id (api/productions/[id]/review-ack). The link_id
// travels from one to the other unchanged, which is what lets the server
// refuse an ack aimed at a round that is no longer the latest.

type Round = {
  link_id: string;
  responded_at: string;
  scope: string;
  episode: { note: string } | null;
  reels: { reel: number | null; note: string }[];
};

// the client's own words, as they were typed — whitespace-pre-wrap because a
// multi-line note arrives with its line breaks intact and flattening them
// would rewrite what the client wrote
function NoteBox({ children }: { children: string }) {
  return (
    <div className="border border-rose-500/30 rounded-lg p-3 mb-3 text-sm whitespace-pre-wrap">
      {children}
    </div>
  );
}

export default function ClientNotesModal({
  productionId,
  showName,
  onClose,
  onAcked,
}: {
  productionId: string;
  showName?: string;
  onClose: () => void;
  onAcked?: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState<Round | null>(null);
  const [acking, setAcking] = useState(false);
  const [acked, setAcked] = useState(false);

  useEffect(() => {
    // a response that lands after the modal is gone has nothing to update
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/productions/${productionId}/review-current`);
      if (cancelled) return;
      if (!res.ok) {
        setError("שגיאה בטעינת ההערות");
        setLoading(false);
        return;
      }
      const d = await res.json();
      if (cancelled) return;
      setRound(d.round);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [productionId]);

  async function ack() {
    if (!round) return;
    setAcking(true);
    setError(null);
    try {
      const res = await fetch(`/api/productions/${productionId}/review-ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ link_id: round.link_id }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.already) {
        // someone already acknowledged this exact round — the same end state,
        // reached by someone else. Shown as acknowledged, not as an error.
        setAcked(true);
      } else if (res.ok) {
        setAcked(true);
        onAcked?.();
      } else if (res.status === 409) {
        setError("הגיע סבב הערות חדש יותר — סגור ופתח מחדש כדי לראות אותו");
      } else {
        setError(d.error ?? "שגיאה באישור");
      }
    } finally {
      setAcking(false);
    }
  }

  const hasDetail = !!round && (!!round.episode || round.reels.length > 0);

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 z-[60]"
      style={{ background: "rgba(3,2,10,0.66)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl max-h-[85vh] overflow-y-auto border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl"
        style={{ background: "rgba(15,13,28,0.95)", backdropFilter: "blur(24px)" }}
      >
        <h3 className="font-bold mb-1">הערות הלקוח</h3>
        <p className="text-xs text-[var(--dim)] mb-4">{showName}</p>
        {round && (
          <p className="text-[11px] text-[var(--faint)] mb-3">
            נענה:{" "}
            {new Date(round.responded_at).toLocaleString("he-IL", {
              day: "numeric",
              month: "numeric",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        )}

        {loading && <div className="text-sm text-[var(--dim)]">טוען הערות…</div>}

        {!loading && !round && (
          <div className="text-sm text-[var(--dim)]">אין הערות פתוחות מהלקוח.</div>
        )}

        {!loading && round && (
          <>
            {round.episode && (
              <>
                <div className="font-bold text-sm mb-1">📺 פרק</div>
                <NoteBox>{round.episode.note}</NoteBox>
              </>
            )}
            {round.reels.map((r, i) => (
              <div key={r.reel ?? `free-${i}`}>
                {/* reel is null for a track-mode note — one free-text comment
                    about the reels as a whole, with no per-reel prefix to
                    recover (links.ts:517) */}
                <div className="font-bold text-sm mb-1">
                  {r.reel !== null ? `🎬 ריל ${r.reel}` : "🎬 רילז"}
                </div>
                <NoteBox>{r.note}</NoteBox>
              </div>
            ))}
            {!hasDetail && (
              <div className="text-sm text-[var(--dim)]">אין פירוט הערות בסבב זה.</div>
            )}
          </>
        )}

        {error && <div className="text-[11px] text-[var(--peak)] mb-2">{error}</div>}

        {/* flex-wrap: four controls do not fit one line on a phone, and a
            footer that overflows hides the one button that matters */}
        <div className="flex flex-wrap items-center gap-2 mt-4">
          {round && !acked && (
            <button
              onClick={ack}
              disabled={acking}
              className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
              style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
            >
              {acking ? "מאשר…" : "קיבלתי, מטפל"}
            </button>
          )}
          {acked && (
            <div className="text-sm text-[var(--green)] font-bold">✓ אושר — ההפקה בטיפול</div>
          )}
          {/* the print sheet, in a tab of its own. ?print=1 opens the browser's
              print dialog on arrival — that dialog is where the PDF comes from,
              so there is no PDF dependency behind this button. Nothing to print
              without a round, so both are gated on it. */}
          {round && (
            <>
              <button
                onClick={() =>
                  window.open(
                    `/productions/${productionId}/review-notes/print?print=1`,
                    "_blank",
                    "noopener"
                  )
                }
                className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)] hover:bg-[var(--panel3)]"
              >
                ⬇️ הורד PDF
              </button>
              <button
                onClick={() =>
                  window.open(
                    `/productions/${productionId}/review-notes/print`,
                    "_blank",
                    "noopener"
                  )
                }
                className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)] hover:bg-[var(--panel3)]"
              >
                ↗️ פתח בטאב
              </button>
            </>
          )}
          <button
            onClick={onClose}
            className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)]"
          >
            סגור
          </button>
        </div>
      </div>
    </div>
  );
}
