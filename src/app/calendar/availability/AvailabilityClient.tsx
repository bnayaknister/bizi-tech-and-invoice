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
    },
    [shows]
  );

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
    />
  );
}
