"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import IconTile from "@/components/IconTile";

export type UserRow = {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
  approved: boolean;
  can_view_money: boolean;
  can_edit_money: boolean;
  can_view_stages: boolean;
  can_edit_stages: boolean;
  can_manage_users: boolean;
  can_import: boolean;
  created_at: string;
};

type PermKey =
  | "can_view_money"
  | "can_edit_money"
  | "can_view_stages"
  | "can_edit_stages"
  | "can_manage_users"
  | "can_import";

const PERMS: { key: PermKey; label: string }[] = [
  { key: "can_view_stages", label: "צפייה בהפקות" },
  { key: "can_edit_stages", label: "עריכת הפקות" },
  { key: "can_view_money", label: "צפייה בכספים" },
  { key: "can_edit_money", label: "עריכת כספים" },
  { key: "can_manage_users", label: "ניהול משתמשים" },
  { key: "can_import", label: "ייבוא" },
];

// presets set the six flags in one click (owner spec 2026-07-18)
const PRESETS: Record<string, { label: string; flags: Record<PermKey, boolean>; role: string }> = {
  tech: {
    label: "טכנאי",
    role: "tech",
    flags: {
      can_view_stages: true,
      can_edit_stages: true,
      can_view_money: false,
      can_edit_money: false,
      can_manage_users: false,
      can_import: false,
    },
  },
  bookkeeper: {
    // read-only on productions/shows, but marks paid + issues invoices
    label: "חשבונאית",
    role: "bookkeeper",
    flags: {
      can_view_stages: true,
      can_edit_stages: false,
      can_view_money: true,
      can_edit_money: true,
      can_manage_users: false,
      can_import: false,
    },
  },
  admin: {
    label: "אדמין",
    role: "owner",
    flags: {
      can_view_stages: true,
      can_edit_stages: true,
      can_view_money: true,
      can_edit_money: true,
      can_manage_users: true,
      can_import: true,
    },
  },
};

export default function UsersClient({ users: initial, selfId }: { users: UserRow[]; selfId: string }) {
  const router = useRouter();
  const [users, setUsers] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const pendingCount = users.filter((u) => !u.approved).length;

  async function patch(id: string, p: Record<string, unknown>) {
    setError(null);
    setNotice(null);
    setBusyId(id);
    // optimistic
    const prev = users;
    setUsers((us) => us.map((u) => (u.id === id ? { ...u, ...p } : u)));
    const res = await fetch(`/api/users/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: p }),
    });
    setBusyId(null);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setUsers(prev);
      setError(d.error ?? "העדכון נכשל");
    }
  }

  function applyPreset(u: UserRow, preset: keyof typeof PRESETS) {
    const { flags, role } = PRESETS[preset];
    void patch(u.id, { ...flags, role });
  }

  const pendingUsers = users.filter((u) => !u.approved);
  const activeUsers = users.filter((u) => u.approved);

  const card = (u: UserRow) => {
    const isSelf = u.id === selfId;
    return (
      <div
        key={u.id}
        className="rounded-2xl border border-[var(--rule)] p-4"
        style={{ background: "rgba(255,255,255,0.03)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
      >
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="min-w-0">
            <div className="font-bold text-sm flex items-center gap-2">
              {u.name || u.email || "—"}
              {isSelf && <span className="text-[10px] text-[var(--faint)]">(אתה)</span>}
            </div>
            <div className="text-[11px] text-[var(--faint)]" dir="ltr">{u.email}</div>
            {!u.approved && (
              <div className="text-[11px] text-[var(--faint)]">
                נרשם: <span className="font-mono">{new Date(u.created_at).toLocaleString("he-IL")}</span>
              </div>
            )}
          </div>
          {!u.approved && (
            <button
              onClick={() => patch(u.id, { approved: true })}
              disabled={isSelf || busyId === u.id}
              className="text-xs text-white font-bold rounded-xl px-3 py-1.5 disabled:opacity-40"
              style={{ background: "linear-gradient(135deg, var(--green), #16A34A)" }}
            >
              אשר משתמש
            </button>
          )}
          <div className="flex-1" />
          {!isSelf &&
            (Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((p) => (
              <button
                key={p}
                onClick={() => applyPreset(u, p)}
                disabled={busyId === u.id}
                className="text-[11px] border border-[var(--rule)] rounded-xl px-2.5 py-1 text-[var(--dim)] hover:bg-[var(--panel3)] hover:border-[var(--rule2)] transition-colors disabled:opacity-40"
              >
                {PRESETS[p].label}
              </button>
            ))}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5">
          {PERMS.map((perm) => (
            <label key={perm.key} className={`flex items-center gap-2 text-xs ${isSelf ? "opacity-50" : "cursor-pointer"}`}>
              <input
                type="checkbox"
                checked={u[perm.key]}
                disabled={isSelf || busyId === u.id}
                onChange={(e) => patch(u.id, { [perm.key]: e.target.checked })}
              />
              {perm.label}
            </label>
          ))}
        </div>
        {isSelf && <div className="mt-2 text-[10px] text-[var(--faint)]">אי אפשר לשנות את ההרשאות של עצמך.</div>}
      </div>
    );
  };

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <h1 className="text-lg font-bold flex items-center gap-2.5">
          <IconTile icon="users" accent="violet" size={30} iconSize={17} />
          משתמשים
        </h1>
        {pendingCount > 0 && (
          <span className="text-[11px] text-[var(--amber)] border border-[var(--amber)] rounded-full px-2 py-0.5">
            {pendingCount} ממתינים לאישור
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => setAddOpen(true)}
          className="text-xs text-white font-bold rounded-xl px-3 py-1.5"
          style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 14px rgba(139,92,246,0.3)" }}
        >
          + הוסף משתמש
        </button>
      </div>

      {error && <div className="mb-3 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2">{error}</div>}
      {notice && <div className="mb-3 text-xs text-[var(--green)] border border-[var(--green)] rounded-xl px-3 py-2">{notice}</div>}

      {/* prominent, separate — new signups waiting for me to assign a role */}
      {pendingUsers.length > 0 && (
        <section
          className="mb-6 rounded-2xl border border-[var(--amber)] p-3"
          style={{ background: "rgba(252,211,77,0.06)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
        >
          <div className="text-xs font-bold text-[var(--amber)] mb-2 px-1 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: "var(--amber)" }} />
            ממתינים לאישור ({pendingUsers.length})
          </div>
          <div className="space-y-3">{pendingUsers.map(card)}</div>
        </section>
      )}

      <div className="text-[10px] uppercase tracking-wider font-semibold text-[var(--faint)] mb-2">
        משתמשים פעילים ({activeUsers.length})
      </div>
      <div className="space-y-3">{activeUsers.map(card)}</div>

      {addOpen && (
        <AddUserModal
          onClose={() => setAddOpen(false)}
          onDone={(msg) => {
            setAddOpen(false);
            setNotice(msg);
            router.refresh();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function AddUserModal({
  onClose,
  onDone,
  onError,
}: {
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(mode: "invite" | "manual") {
    setBusy(true);
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name, mode }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      onError(d.error ?? "ההוספה נכשלה");
      onClose();
      return;
    }
    onDone(mode === "invite" ? "נשלחה הזמנה במייל." : "המשתמש נוצר — יאפס סיסמה דרך 'שכחתי סיסמה'.");
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 z-50"
      style={{ background: "rgba(3,2,10,0.66)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl"
        style={{ background: "rgba(15,13,28,0.92)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
      >
        <h3 className="font-bold mb-3">הוספת משתמש</h3>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="שם"
          className="w-full border border-[var(--rule)] rounded-xl px-3 py-2 text-sm mb-2"
          style={{ background: "rgba(255,255,255,0.05)" }}
        />
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="אימייל"
          dir="ltr"
          className="w-full border border-[var(--rule)] rounded-xl px-3 py-2 text-sm mb-4"
          style={{ background: "rgba(255,255,255,0.05)" }}
        />
        <p className="text-[11px] text-[var(--faint)] mb-3">
          המשתמש נוצר ללא הרשאות (ממתין לאישור). הגדר לו הרשאות אחרי היצירה.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => submit("invite")}
            disabled={busy || !email}
            className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
            style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
          >
            הזמן במייל
          </button>
          <button
            onClick={() => submit("manual")}
            disabled={busy || !email}
            className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)] hover:bg-[var(--panel3)] disabled:opacity-40 transition-colors"
          >
            הוסף ידנית
          </button>
          <button onClick={onClose} className="text-[var(--faint)] text-sm px-2">
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}
