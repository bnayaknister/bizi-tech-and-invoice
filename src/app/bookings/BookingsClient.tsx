"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import BookingsBody, { type ApprovedPanel, type CancelledPanel } from "./BookingsBody";
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
  const [retryingId, setRetryingId] = useState<string | null>(null);
  // E9-3: cancelling an approved recording
  const [cancelFor, setCancelFor] = useState<QueueView | null>(null);
  const [cancelled, setCancelled] = useState<CancelledPanel | null>(null);

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
          request?: {
            title: string;
            showName: string;
            calendarWriteStatus: "created" | "failed" | null;
            calendarWriteError: string | null;
            calendarHtmlLink: string | null;
            calendarDryRun: boolean;
          };
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
        setApproved({
          view: v,
          title: body.request.title,
          googleUrl: v.googleUrl,
          // the FRESH write result — never derived from `v`, which predates
          // the approve call entirely
          calendar: {
            status: body.request.calendarWriteStatus,
            error: body.request.calendarWriteError,
            htmlLink: body.request.calendarHtmlLink,
            dryRun: body.request.calendarDryRun,
          },
        });
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
   * Retry a failed (or never-attempted) calendar write — 0099, E8. No change
   * to the approval itself, and no production: only the calendar columns.
   * `retryingId` gates the ONE button that was clicked, not
   * `busy` — approve/decline stay enabled while a retry is in flight,
   * because they act on a different row.
   */
  const onRetryCalendar = useCallback(
    async (v: QueueView) => {
      if (retryingId) return;
      setRetryingId(v.id);
      setError(null);
      try {
        const res = await fetch(`/api/bookings/${v.id}/retry-calendar`, { method: "POST", cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          request?: {
            calendarWriteStatus: "created" | "failed" | null;
            calendarWriteError: string | null;
            calendarHtmlLink: string | null;
            calendarDryRun: boolean;
          };
        };
        if (!res.ok || !body.ok || !body.request) {
          setError(body.error ?? GENERIC);
          return;
        }
        // The ephemeral panel, if it's the row that was just retried, carries
        // the fresh result forward — a reloaded history row picks it up
        // through `router.refresh()` and `calendarStateFromView` instead.
        setApproved((prev) =>
          prev && prev.view.id === v.id
            ? {
                ...prev,
                calendar: {
                  status: body.request!.calendarWriteStatus,
                  error: body.request!.calendarWriteError,
                  htmlLink: body.request!.calendarHtmlLink,
                  dryRun: body.request!.calendarDryRun,
                },
              }
            : prev
        );
        router.refresh();
      } catch {
        setError(GENERIC);
      } finally {
        setRetryingId(null);
      }
    },
    [retryingId, router]
  );

  /**
   * Cancel an APPROVED recording — E9-3, owner decision 8.10.
   *
   * ⚠️ THE RESPONSE IS WHAT DECIDES WHAT THE SCREEN SAYS, not this file:
   * `calendarEventExisted` comes from the stored row's own
   * `calendar_write_status`, because only the server knows whether an event
   * was ever written. Guessing here would tell the owner to go and delete
   * something that never existed.
   */
  const onConfirmCancel = useCallback(
    async (v: QueueView) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/bookings/${v.id}/cancel`, { method: "POST", cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          request?: { calendarEventExisted: boolean; calendarDayUrl: string };
        };
        if (!res.ok || !body.ok || !body.request) {
          setError(body.error ?? GENERIC);
          return;
        }
        setCancelled({
          view: v,
          calendarEventExisted: body.request.calendarEventExisted,
          calendarDayUrl: body.request.calendarDayUrl,
        });
        // the two other ephemeral panels describe a row that is no longer in
        // the state they describe
        setApproved(null);
        setDeclined(null);
        router.refresh();
      } catch {
        setError(GENERIC);
      } finally {
        setBusy(false);
        setCancelFor(null);
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
      retryingId={retryingId}
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
        // ⚠️ the cancel dialog shares this one dismiss handler. Leaving it out
        // would make Escape close two of the three dialogs and silently leave
        // the third one open.
        setCancelFor(null);
      }}
      onCopyTitle={(v, title) => void onCopyTitle(v, title)}
      onRetryCalendar={(v) => void onRetryCalendar(v)}
      cancelFor={cancelFor}
      cancelled={cancelled}
      onAskCancel={(v) => {
        setCancelFor(v);
        setError(null);
      }}
      onConfirmCancel={(v) => void onConfirmCancel(v)}
    />
  );
}
