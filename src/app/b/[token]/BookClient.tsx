"use client";

import { useCallback, useEffect, useState } from "react";
import AvailabilityBody from "@/app/calendar/availability/AvailabilityBody";
import {
  dayMonth,
  dowHebrew,
  monthOf,
  monthsInWindow,
  sameMonth,
  type FreeSlot,
  type Month,
} from "@/app/calendar/availability/booking";
import { whatsappHref, whatsappText, type RequestView } from "@/lib/booking/publicView";

/**
 * The public container: owns the fetch, the selections and the submit, and
 * nothing else. AvailabilityBody holds every sentence and every cell and stays
 * pure — the same split as AvailabilityClient, for the same reason (the render
 * suite runs renderToString, so effects never fire and a self-fetching
 * component would only ever be testable mid-load).
 *
 * ⚠️ IT RENDERS THE SAME COMPONENT AS THE OWNER'S PREVIEW, with publicMode on.
 * That is the whole point of the preview existing: if this file rendered its
 * own copy of the screen, the owner would be checking a rehearsal of something
 * else.
 */

type Payload = {
  fromIsrael: string;
  toIsrael: string;
  rooms: string[];
  free: FreeSlot[];
  refusedRooms: string[];
};

type Sent = { dateIsrael: string; startIsrael: string; studio: string; guest: string | null };

const GENERIC_ERROR = "לא הצלחנו לשלוח את הבקשה. נסו שוב בעוד כמה דקות.";

export default function BookClient({
  token,
  showName,
  defaultRoom,
  initialRequests,
  whatsappNumber,
}: {
  token: string;
  showName: string;
  defaultRoom: string | null;
  initialRequests: RequestView[];
  whatsappNumber: string | null;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [room, setRoom] = useState<string | null>(defaultRoom);
  const [date, setDate] = useState<string | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [month, setMonth] = useState<Month | null>(null);

  const [guest, setGuest] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [requests, setRequests] = useState<RequestView[]>(initialRequests);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // The previous answer is DROPPED before the new request. Slots left on
    // screen after a failed reload are the one failure a client would act on.
    setData(null);
    try {
      const res = await fetch(`/api/book/${token}/availability`, { cache: "no-store" });
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
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!data) return;
    const months = monthsInWindow(data.fromIsrael, data.toIsrael);
    setMonth((current) => (current && months.some((m) => sameMonth(m, current)) ? current : monthOf(data.fromIsrael)));
  }, [data]);

  /** Changing the room clears the day AND the hour — see AvailabilityClient. */
  const onRoomChange = useCallback((next: string) => {
    setRoom(next);
    setDate(null);
    setStart(null);
    // A new room means the previous success no longer describes what is on
    // screen; leaving it would put "your request was sent" above a different
    // room's calendar.
    setSent(null);
    setSubmitError(null);
  }, []);

  const onSubmit = useCallback(async () => {
    if (!room || !date || !start || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/book/${token}/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studio: room, startIsrael: `${date} ${start}`, guest, note }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        request?: { id: string; studio: string; dateIsrael: string; startIsrael: string; guest: string | null };
      };
      if (!res.ok || !body.ok || !body.request) {
        // The server's sentence is shown verbatim when it sent one: 409, 429
        // and the guest-too-long 400 each have approved copy, and rewriting
        // them here would create a second set that drifts from the first.
        setSubmitError(body.error ?? GENERIC_ERROR);
        return;
      }
      const r = body.request;
      setSent({ dateIsrael: r.dateIsrael, startIsrael: r.startIsrael, studio: r.studio, guest: r.guest });
      // Appended locally rather than re-fetched: the row we just created is the
      // row the server confirmed, and a second round trip could only disagree
      // with it. A duplicate answer carries the EXISTING id, so the list does
      // not grow a second copy of the same request.
      setRequests((prev) =>
        prev.some((p) => p.id === r.id)
          ? prev
          : [
              ...prev,
              {
                id: r.id,
                // the SAME two helpers myRequests uses on the server — the one
                // row added in the browser must be formatted by the same code
                // as the rows that came with the page, or the list shows two
                // date styles in one column
                dowHe: dowHebrew(r.dateIsrael),
                dayMonth: dayMonth(r.dateIsrael),
                timeIsrael: r.startIsrael,
                studio: r.studio,
                guest: r.guest,
                statusLabel: "ממתינה לאישור",
              },
            ]
      );
      // The slot is gone for everyone the moment it is approved, and the grid
      // is stale the moment anything is requested. Re-read rather than guess.
      void load();
    } catch {
      setSubmitError(GENERIC_ERROR);
    } finally {
      setSubmitting(false);
    }
  }, [room, date, start, guest, note, token, submitting, load]);

  const href = sent
    ? whatsappHref(
        whatsappNumber,
        whatsappText({
          showName,
          dateIsrael: sent.dateIsrael,
          startIsrael: sent.startIsrael,
          studio: sent.studio,
          guest: sent.guest,
        })
      )
    : null;

  return (
    <AvailabilityBody
      publicMode
      loading={loading}
      error={error}
      fromIsrael={data?.fromIsrael ?? null}
      toIsrael={data?.toIsrael ?? null}
      rooms={data?.rooms ?? []}
      free={data?.free ?? []}
      // ⚠️ EMPTY, AND THAT IS THE SHAPE OF THE PUBLIC PAYLOAD. The route never
      // sends unknownRoomBlocks or skipped — both carry calendar titles — so
      // there is nothing here to pass and nothing for the body to render.
      unknownRoomBlocks={[]}
      skipped={[]}
      // Names only. The series TITLE stays on the server; the client is told a
      // room is unavailable, not what is in it.
      roomsRefused={(data?.refusedRooms ?? []).map((room) => ({ room, seriesUid: "", seriesTitle: "" }))}
      step={30}
      shows={[{ id: "public", name: showName, defaultRoom }]}
      selectedShowId="public"
      selectedRoom={room}
      selectedDate={date}
      selectedStart={start}
      visibleMonth={month}
      warningsOpen={false}
      onStepChange={() => {}}
      onShowChange={() => {}}
      onRoomChange={onRoomChange}
      onDateChange={(d) => {
        setDate(d);
        setSent(null);
        setSubmitError(null);
      }}
      onStartChange={(s) => {
        setStart(s);
        setSent(null);
        setSubmitError(null);
      }}
      onMonthChange={setMonth}
      onToggleWarnings={() => {}}
      guest={guest}
      note={note}
      onGuestChange={setGuest}
      onNoteChange={setNote}
      onSubmit={onSubmit}
      submitting={submitting}
      submitError={submitError}
      submitted={sent}
      whatsappHref={href}
      myRequests={requests}
    />
  );
}
