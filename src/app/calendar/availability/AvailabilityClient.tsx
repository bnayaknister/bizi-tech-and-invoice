"use client";

import { useCallback, useEffect, useState } from "react";
import AvailabilityBody, {
  type FreeSlot,
  type Refused,
  type Skipped,
  type UnknownBlock,
} from "./AvailabilityBody";

/**
 * The container: owns the fetch and the step selector, and nothing else.
 * AvailabilityBody holds every sentence and every cell and is pure, so the
 * render suite can reach all of its states (see the note at the top of that
 * file — renderToString runs no effects).
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

export default function AvailabilityClient() {
  const [step, setStep] = useState<30 | 90>(30);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (s: 30 | 90) => {
    setLoading(true);
    setError(null);
    // ⚠️ the previous answer is DROPPED before the new request, not kept as a
    // placeholder. Holding it would leave a 30-minute grid on screen while the
    // 90-minute one loads, or — worse — leave real slots visible if the reload
    // fails. Availability that is no longer confirmed must not be on screen.
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
      fetchedAt={data?.fetchedAt ?? null}
      onStepChange={setStep}
    />
  );
}
