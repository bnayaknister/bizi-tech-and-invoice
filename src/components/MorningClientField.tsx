"use client";

import { useEffect, useRef, useState } from "react";
import CreateMorningClientModal from "./CreateMorningClientModal";

type MC = { id: string; name: string; taxId: string | null };
type Info = { client: { id: string; name: string }; current: { id: string; name: string | null } | null; morning_clients: MC[] };

// The show-card "לקוח מורנינג" field (owner spec — Feature 5): map the show's
// client to a Morning client, or create a new one in Morning and map it. Backed
// by GET /api/clients/[id]/morning, POST /api/morning/clients (map/unmap), and
// POST /api/morning/clients/create (double-confirmed creation).
export default function MorningClientField({ clientId, canEdit }: { clientId: string | null; canEdit: boolean }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const loadedFor = useRef<string | null>(null);

  async function load() {
    if (!clientId) return;
    setErr(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/morning`);
      const body = await res.json();
      if (!res.ok) {
        setErr(body.error ?? "טעינת מיפוי נכשלה");
        return;
      }
      setInfo(body);
      loadedFor.current = clientId;
    } catch {
      setErr("שגיאת רשת");
    }
  }

  useEffect(() => {
    if (open && clientId && loadedFor.current !== clientId) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, clientId]);

  async function map(morning_client_id: string | null, morning_client_name?: string, confirm_shared = false) {
    if (!clientId) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/morning/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, morning_client_id, morning_client_name, confirm_shared }),
      });
      const body = await res.json();
      if (res.status === 409 && body.needs_confirmation) {
        if (confirm(`לקוח מורנינג זה כבר משויך ל: ${(body.shared_with ?? []).join(", ")}.\nלשייך גם את הלקוח הזה?`)) {
          await map(morning_client_id, morning_client_name, true);
        }
        return;
      }
      if (!res.ok) {
        setErr(body.error ?? "השיוך נכשל");
        return;
      }
      setInfo((i) => (i ? { ...i, current: morning_client_id ? { id: morning_client_id, name: morning_client_name ?? null } : null } : i));
      setOpen(false);
    } catch {
      setErr("שגיאת רשת");
    } finally {
      setBusy(false);
    }
  }

  const filtered = (info?.morning_clients ?? []).filter((m) =>
    q.trim() ? m.name.toLowerCase().includes(q.trim().toLowerCase()) : true
  ).slice(0, 40);

  if (!clientId) {
    return <div className="text-[11px] text-[var(--faint)]">בחר לקוח כדי לשייך ללקוח מורנינג</div>;
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <span className="text-xs">{info?.current?.name ?? (info?.current ? "(מזהה לא נמצא)" : "— ללא שיוך —")}</span>
        {canEdit && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-[10px] text-[var(--signal)] hover:underline"
          >
            {info?.current ? "שנה" : "שייך"}
          </button>
        )}
      </div>
      {err && <div className="text-[10px] text-[var(--red)] mt-1">{err}</div>}

      {open && canEdit && (
        <div className="absolute z-20 mt-1 w-72 rounded-2xl border border-[var(--rule2)] bg-[var(--panel)] shadow-xl p-2"
          style={{ backdropFilter: "blur(12px)" }}>
          {!info ? (
            <div className="text-[11px] text-[var(--faint)] px-2 py-3">טוען ממורנינג…</div>
          ) : (
            <>
              <button
                onClick={() => { setCreateOpen(true); setOpen(false); }}
                className="w-full text-right text-xs font-bold text-[var(--signal)] rounded-xl px-3 py-2 border border-[var(--signal)] mb-1.5"
              >
                ➕ צור לקוח חדש במורנינג
              </button>
              <button
                onClick={() => void map(null)}
                disabled={busy || !info.current}
                className="w-full text-right text-[11px] text-[var(--dim)] rounded-xl px-3 py-1.5 hover:bg-[var(--hover)] disabled:opacity-40 mb-1"
              >
                ללא שיוך
              </button>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="חפש לקוח מורנינג…"
                className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-1.5 text-xs mb-1.5"
              />
              <div className="max-h-52 overflow-y-auto space-y-0.5">
                {filtered.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => void map(m.id, m.name)}
                    disabled={busy || info.current?.id === m.id}
                    className="w-full text-right text-xs rounded-xl px-3 py-1.5 hover:bg-[var(--hover)] disabled:opacity-50 flex items-center justify-between gap-2"
                  >
                    <span className="min-w-0 truncate">{m.name}</span>
                    {info.current?.id === m.id && <span className="text-[10px] text-[var(--green)] shrink-0">משויך</span>}
                  </button>
                ))}
                {filtered.length === 0 && <div className="text-[11px] text-[var(--faint)] px-2 py-2">אין תוצאות</div>}
              </div>
            </>
          )}
        </div>
      )}

      {createOpen && (
        <CreateMorningClientModal
          clientId={clientId}
          defaultName={info?.client.name ?? ""}
          onClose={() => setCreateOpen(false)}
          onResolved={({ morningId, name }) => {
            setCreateOpen(false);
            setInfo((i) => (i ? { ...i, current: { id: morningId, name } } : i));
            loadedFor.current = null; // force reload of the morning list next open
          }}
        />
      )}
    </div>
  );
}
