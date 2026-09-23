"use client";

import { useCallback, useEffect, useState } from "react";
import AvailabilityBody, {
  type Refused,
  type Show,
  type Skipped,
  type UnknownBlock,
} from "./AvailabilityBody";
import { monthOf, monthsInWindow, sameMonth, type FreeSlot, type Month } from "./booking";

/**
 * The container: owns the fetch and all six selections, and nothing else.
 * AvailabilityBody holds every sentence and every cell and is pure.
 *
 * `shows` arrives as a prop from the server page, which read it — this component
 * never queries anything but the availability route.
 */

type Payload = {
  fromIsrael: string;
  toIsrael: string;
  step: number;
  fetchedAt: string;
  rooms: string[];
  free: FreeSlot[];
  unknownRoomBlocks: UnknownBlock[];
  roomsRefused: Refused[];
  skipped: Skipped[];
};

export default function AvailabilityClient({ shows }: { shows: Show[] }) {
  const [step, setStep] = useState<30 | 90>(30);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showId, setShowId] = useState<string | null>(shows[0]?.id ?? null);
  const [room, setRoom] = useState<string | null>(shows[0]?.defaultRoom ?? null);
  const [date, setDate] = useState<string | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [month, setMonth] = useState<Month | null>(null);
  const [warningsOpen, setWarningsOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [copyError, setCopyError] = useState<string | null>(null);

  const load = useCallback(async (s: 30 | 90) => {
    setLoading(true);
    setError(null);
    // The previous answer is DROPPED before the new request, never kept as a
    // placeholder: a 30-minute grid left on screen while the 90-minute one loads
    // is wrong, and slots left visible after a failed reload are worse.
    setData(null);
    try {
      const res = await fetch(`/api/calendar/availability?step=${s}`, { cache: "no-store" });
      if (!res.ok) {
        setError("failed");
        return;
      }
      setData((await res.json()) as Payload);
    } catch {
      setError("failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(step);
  }, [step, load]);

  // The visible month follows the window, not the wall clock: `from` is
  // tomorrow, so the window's first month is the only sensible opening view.
  // Re-clamped when the payload changes so a month left over from a previous
  // step can never sit outside the new window.
  useEffect(() => {
    if (!data) return;
    const months = monthsInWindow(data.fromIsrael, data.toIsrael);
    setMonth((current) => (current && months.some((m) => sameMonth(m, current)) ? current : monthOf(data.fromIsrael)));
  }, [data]);

  /** Changing the show re-applies ITS default room, and clears the picks. */
  const onShowChange = useCallback(
    (id: string) => {
      setShowId(id);
      setRoom(shows.find((s) => s.id === id)?.defaultRoom ?? null);
      setDate(null);
      setStart(null);
      // The message belongs to the show it was produced for. Leaving
      // "הקישור הועתק" on screen after switching shows would claim the
      // clipboard holds THIS show's link when it holds the previous one's.
      setCopyState("idle");
      setCopyError(null);
    },
    [shows]
  );

  /**
   * Ask the server for this show's link and put it on the clipboard.
   *
   * ⚠️ THE URL IS NEVER PUT ON SCREEN — see the button's note in
   * AvailabilityBody. It goes from the response straight to the clipboard and
   * is not held in state, so a React devtools panel does not show it either.
   *
   * The clipboard write is INSIDE the try: navigator.clipboard rejects on an
   * insecure origin and throws where it does not exist at all, and a silent
   * failure there would leave the owner pasting whatever was there before —
   * possibly another show's link.
   */
  const onCopyLink = useCallback(async () => {
    if (!showId) return;
    setCopyState("idle");
    setCopyError(null);
    try {
      const res = await fetch("/api/booking/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ showId }),
        cache: "no-store",
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        // The server's sentence verbatim — the no-clean-alias message is
        // approved copy and tells the owner exactly what to do about it.
        setCopyError(body.error ?? "לא הצלחתי ליצור קישור");
        setCopyState("error");
        return;
      }
      await navigator.clipboard.writeText(body.url);
      setCopyState("copied");
    } catch {
      setCopyError("לא הצלחתי להעתיק את הקישור");
      setCopyState("error");
    }
  }, [showId]);

  /**
   * Changing the room clears the day AND the hour.
   *
   * Both, and that is the point: a day that is free in גבעון is routinely busy
   * in חשמונאים, and an hour even more so. Keeping either would leave a summary
   * card asserting a slot that was never free in the newly chosen room — the one
   * failure on this screen that a client would act on.
   */
  const onRoomChange = useCallback((next: string) => {
    setRoom(next);
    setDate(null);
    setStart(null);
  }, []);

  return (
    <AvailabilityBody
      loading={loading}
      error={error}
      fromIsrael={data?.fromIsrael ?? null}
      toIsrael={data?.toIsrael ?? null}
      rooms={data?.rooms ?? []}
      free={data?.free ?? []}
      unknownRoomBlocks={data?.unknownRoomBlocks ?? []}
      roomsRefused={data?.roomsRefused ?? []}
      skipped={data?.skipped ?? []}
      step={step}
      shows={shows}
      selectedShowId={showId}
      selectedRoom={room}
      selectedDate={date}
      selectedStart={start}
      visibleMonth={month}
      warningsOpen={warningsOpen}
      onStepChange={setStep}
      onShowChange={onShowChange}
      onRoomChange={onRoomChange}
      onDateChange={setDate}
      onStartChange={setStart}
      onMonthChange={setMonth}
      onToggleWarnings={() => setWarningsOpen((v) => !v)}
      onCopyLink={() => void onCopyLink()}
      copyState={copyState}
      copyError={copyError}
    />
  );
}
