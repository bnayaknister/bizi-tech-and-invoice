"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import BookingsBody, { type ApprovedPanel } from "./BookingsBody";
import type { QueueView } from "@/lib/booking/queue";

/**
 * The container: owns the two dialogs, the two requests, and the refresh. Every
 * sentence and every cell lives in BookingsBody, which is pure.
 *
 * `waiting` and `history` arrive as props from the server page, which read and
 * split them — this component queries nothing and computes nothing about time.
 */

const GENERIC = "משהו נכשל. נסו שוב.";

export default function BookingsClient({
  waiting,
  history,
}: {
  waiting: QueueView[];
  history: QueueView[];
}) {
  const router = useRouter();

  const [approveFor, setApproveFor] = useState<QueueView | null>(null);
  const [declineFor, setDeclineFor] = useState<QueueView | null>(null);
  const [approved, setApproved] = useState<ApprovedPanel | null>(null);
  const [declined, setDeclined] = useState<QueueView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedTitleId, setCopiedTitleId] = useState<string | null>(null);

  const onConfirmApprove = useCallback(
    async (v: QueueView) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/bookings/${v.id}/approve`, { method: "POST", cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          request?: { title: string; showName: string };
        };
        if (!res.ok || !body.ok || !body.request) {
          // The server's sentence verbatim: the two 409s and the feed failure
          // each have approved copy that says what to do next.
          setError(body.error ?? GENERIC);
          return;
        }
        // ⚠️ THE TITLE COMES FROM THE SERVER, which built it from the STORED
        // row through eventTitle. The screen never assembles a calendar title
        // out of its own state — that is the string the sync will read back,
        // and it must not be able to disagree with the database.
        setApproved({ view: v, title: body.request.title, googleUrl: v.googleUrl });
        setDeclineFor(null);
        // Re-read the lists: this row leaves "ממתינות", and every other pending
        // request in the same room may have just become unapprovable.
        router.refresh();
      } catch {
        setError(GENERIC);
      } finally {
        setBusy(false);
        setApproveFor(null);
      }
    },
    [busy, router]
  );

  const onConfirmDecline = useCallback(
    async (v: QueueView) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/bookings/${v.id}/decline`, { method: "POST", cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !body.ok) {
          setError(body.error ?? GENERIC);
          return;
        }
        setDeclined(v);
        setApproved(null);
        router.refresh();
      } catch {
        setError(GENERIC);
      } finally {
        setBusy(false);
        setDeclineFor(null);
      }
    },
    [busy, router]
  );

  /**
   * The title to the clipboard.
   *
   * The write is INSIDE the try: navigator.clipboard rejects on an insecure
   * origin and is absent entirely in some contexts, and a silent failure would
   * leave the owner pasting whatever was there before — possibly another
   * recording's title.
   */
  const onCopyTitle = useCallback(async (v: QueueView, title: string) => {
    setError(null);
    try {
      await navigator.clipboard.writeText(title);
      setCopiedTitleId(v.id);
    } catch {
      setError("לא הצלחתי להעתיק את הכותרת");
    }
  }, []);

  return (
    <BookingsBody
      waiting={waiting}
      history={history}
      approveFor={approveFor}
      declineFor={declineFor}
      approved={approved}
      declined={declined}
      busy={busy}
      error={error}
      copiedTitleId={copiedTitleId}
      onAskApprove={(v) => {
        setApproveFor(v);
        setError(null);
      }}
      onAskDecline={(v) => {
        setDeclineFor(v);
        setError(null);
      }}
      onConfirmApprove={(v) => void onConfirmApprove(v)}
      onConfirmDecline={(v) => void onConfirmDecline(v)}
      onCancelDialog={() => {
        setApproveFor(null);
        setDeclineFor(null);
      }}
      onCopyTitle={(v, title) => void onCopyTitle(v, title)}
    />
  );
}
