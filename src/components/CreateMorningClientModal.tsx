"use client";

import { useState } from "react";

export type MorningCreateResult = { clientId: string; morningId: string; name: string };
type Gate1 = {
  duplicate: { id: string; name: string; taxId: string | null } | null;
  existing_client: { id: string; name: string; mapped: boolean } | null;
};

// The ONE shared "create a client in Morning" modal (owner spec). Used by the
// ClientPicker, the show card, and the client-mapping screen — a single source,
// so a change here shows up everywhere.
//
//   clientId set  → map-existing mode: create/adopt a Morning client for THAT
//                   client of ours.
//   clientId null → brand-new mode: create OUR client too, then Morning, map,
//                   and return the new client_id to select.
export default function CreateMorningClientModal({
  clientId = null,
  defaultName = "",
  onClose,
  onResolved,
  onPickExistingClient,
}: {
  clientId?: string | null;
  defaultName?: string;
  onClose: () => void;
  onResolved: (r: MorningCreateResult) => void;
  onPickExistingClient?: (clientId: string, name: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [taxId, setTaxId] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [gate1, setGate1] = useState<Gate1 | null>(null); // confirmation stage

  async function post(confirm: boolean, mapToMorningId?: string) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/morning/clients/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId ?? undefined,
          name: name.trim(),
          taxId: taxId.trim() || undefined,
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          address: address.trim() || undefined,
          confirm,
          map_to_morning_id: mapToMorningId,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setErr(body.error ?? "הפעולה נכשלה");
        return;
      }
      if (!confirm && body.needs_confirmation) {
        setGate1({ duplicate: body.duplicate ?? null, existing_client: body.existing_client ?? null });
        return;
      }
      onResolved({ clientId: body.client_id, morningId: body.morning_client_id, name: name.trim() });
    } catch {
      setErr("שגיאת רשת");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="glass-card w-full max-w-md p-5 rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-bold mb-3">צור לקוח חדש במורנינג</h2>

        {gate1 ? (
          <div className="text-xs space-y-3">
            {gate1.existing_client && (
              <div className="border border-[var(--warn)] rounded-xl px-3 py-2">
                <div className="text-[var(--warn)] mb-2">
                  כבר קיים אצלך לקוח בשם <b>{gate1.existing_client.name}</b>
                  {gate1.existing_client.mapped ? " (ממופה למורנינג)" : ""}.
                </div>
                {onPickExistingClient && (
                  <button
                    onClick={() => onPickExistingClient!(gate1.existing_client!.id, gate1.existing_client!.name)}
                    className="rounded-xl px-3 py-1.5 border border-[var(--rule2)] font-bold"
                  >
                    בחר את הלקוח הקיים
                  </button>
                )}
              </div>
            )}
            {gate1.duplicate && (
              <div className="border border-[var(--warn)] rounded-xl px-3 py-2">
                <div className="text-[var(--warn)] mb-2">
                  נמצא לקוח דומה במורנינג: <b>{gate1.duplicate.name}</b>{gate1.duplicate.taxId ? ` · ${gate1.duplicate.taxId}` : ""}.
                </div>
                <button
                  onClick={() => void post(true, gate1.duplicate!.id)}
                  disabled={busy}
                  className="rounded-xl px-3 py-1.5 border border-[var(--rule2)] font-bold disabled:opacity-40"
                >
                  מפה ללקוח מורנינג הקיים
                </button>
              </div>
            )}
            {!gate1.duplicate && !gate1.existing_client && (
              <div>ליצור לקוח חדש <b>{name.trim()}</b> במורנינג? הפעולה יוצרת רשומה אמיתית במורנינג.</div>
            )}
            {err && <div className="text-[11px] text-[var(--red)]">{err}</div>}
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setGate1(null)} className="rounded-xl px-3 py-1.5 border border-[var(--rule)]">חזור</button>
              <button onClick={() => void post(true)} disabled={busy} className="rounded-xl px-4 py-1.5 bg-[var(--signal)] text-white font-bold disabled:opacity-40">
                {busy ? "יוצר…" : "צור חדש במורנינג"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="block text-[11px] text-[var(--dim)] mb-1">שם *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs mb-2" />
            <label className="block text-[11px] text-[var(--dim)] mb-1">ח.פ / ת.ז / ע.מ</label>
            <input value={taxId} onChange={(e) => setTaxId(e.target.value)} inputMode="numeric" className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs mb-2 font-mono" />
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div>
                <label className="block text-[11px] text-[var(--dim)] mb-1">מייל</label>
                <input value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs" />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--dim)] mb-1">טלפון</label>
                <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs" />
              </div>
            </div>
            <label className="block text-[11px] text-[var(--dim)] mb-1">כתובת</label>
            <input value={address} onChange={(e) => setAddress(e.target.value)} className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs mb-1" />
            {err && <div className="text-[11px] text-[var(--red)] mt-2">{err}</div>}
            <div className="flex items-center justify-end gap-2 mt-4">
              <button onClick={onClose} className="text-xs rounded-xl px-4 py-1.5 border border-[var(--rule)]">ביטול</button>
              <button onClick={() => void post(false)} disabled={busy || !name.trim()} className="text-xs font-bold rounded-xl px-4 py-1.5 bg-[var(--signal)] text-white disabled:opacity-40">
                {busy ? "בודק…" : "המשך"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
