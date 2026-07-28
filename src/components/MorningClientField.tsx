"use client";

import { useEffect, useRef, useState } from "react";

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
          onCreated={(id, name) => {
            setCreateOpen(false);
            setInfo((i) => (i ? { ...i, current: { id, name } } : i));
            loadedFor.current = null; // force reload of morning list next open
          }}
          onMapExisting={(id, name) => {
            setCreateOpen(false);
            void map(id, name);
          }}
        />
      )}
    </div>
  );
}

function CreateMorningClientModal({
  clientId,
  defaultName,
  onClose,
  onCreated,
  onMapExisting,
}: {
  clientId: string;
  defaultName: string;
  onClose: () => void;
  onCreated: (morningId: string, name: string) => void;
  onMapExisting: (morningId: string, name: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [taxId, setTaxId] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dup, setDup] = useState<MC | null>(null);
  const [confirming, setConfirming] = useState(false); // no-dup go-ahead step

  async function post(confirm: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/morning/clients/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, name: name.trim(), taxId: taxId.trim() || undefined, phone: phone.trim() || undefined, email: email.trim() || undefined, confirm }),
      });
      const body = await res.json();
      if (!res.ok) {
        setErr(body.error ?? "היצירה נכשלה");
        return;
      }
      if (!confirm && body.needs_confirmation) {
        // gate 2: duplicate found → offer to map to it; else a plain go-ahead
        if (body.duplicate) setDup(body.duplicate);
        else setConfirming(true);
        return;
      }
      onCreated(body.morning_client_id, name.trim());
    } catch {
      setErr("שגיאת רשת");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="glass-card w-full max-w-md p-5 rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-bold mb-3">צור לקוח חדש במורנינג</h2>

        {dup ? (
          <div className="text-xs">
            <div className="mb-3 border border-[var(--warn)] rounded-xl px-3 py-2 text-[var(--warn)]">
              נמצא לקוח דומה במורנינג: <b>{dup.name}</b>{dup.taxId ? ` · ${dup.taxId}` : ""}. אולי הוא זה?
            </div>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setDup(null)} className="rounded-xl px-3 py-1.5 border border-[var(--rule)]">חזור</button>
              <button onClick={() => onMapExisting(dup.id, dup.name)} className="rounded-xl px-3 py-1.5 border border-[var(--rule2)] font-bold">מפה לקיים</button>
              <button onClick={() => { setDup(null); void post(true); }} disabled={busy} className="rounded-xl px-3 py-1.5 bg-[var(--signal)] text-white font-bold disabled:opacity-40">צור חדש בכל זאת</button>
            </div>
          </div>
        ) : confirming ? (
          <div className="text-xs">
            <div className="mb-3">ליצור לקוח חדש <b>{name.trim()}</b> במורנינג ולשייך? הפעולה יוצרת רשומה אמיתית במורנינג.</div>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setConfirming(false)} className="rounded-xl px-3 py-1.5 border border-[var(--rule)]">חזור</button>
              <button onClick={() => void post(true)} disabled={busy} className="rounded-xl px-3 py-1.5 bg-[var(--signal)] text-white font-bold disabled:opacity-40">
                {busy ? "יוצר…" : "אשר יצירה"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="block text-[11px] text-[var(--dim)] mb-1">שם *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs mb-2" />
            <label className="block text-[11px] text-[var(--dim)] mb-1">ח.פ / ע.מ</label>
            <input value={taxId} onChange={(e) => setTaxId(e.target.value)} inputMode="numeric" className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs mb-2 font-mono" />
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] text-[var(--dim)] mb-1">טלפון</label>
                <input value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs" />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--dim)] mb-1">אימייל</label>
                <input value={email} onChange={(e) => setEmail(e.target.value)} className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs" />
              </div>
            </div>
            {err && <div className="text-[11px] text-[var(--red)] mt-2">{err}</div>}
            <div className="flex items-center justify-end gap-2 mt-4">
              <button onClick={onClose} className="text-xs rounded-xl px-4 py-1.5 border border-[var(--rule)]">ביטול</button>
              <button onClick={() => void post(false)} disabled={busy || !name.trim()} className="text-xs font-bold rounded-xl px-4 py-1.5 bg-[var(--signal)] text-white disabled:opacity-40">
                {busy ? "בודק…" : "המשך"}
              </button>
            </div>
          </>
        )}
        {err && !dup && !confirming && null}
      </div>
    </div>
  );
}
