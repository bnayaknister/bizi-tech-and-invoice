"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import IconTile from "@/components/IconTile";
import { displayDateTime } from "@/lib/dates";
import { PRESETS, type PermKey, type PresetRole } from "@/lib/users/presets";

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
  /** U1-5: no last_sign_in_at in auth.users */
  never_signed_in: boolean;
};

const PERMS: { key: PermKey; label: string }[] = [
  { key: "can_view_stages", label: "צפייה בהפקות" },
  { key: "can_edit_stages", label: "עריכת הפקות" },
  { key: "can_view_money", label: "צפייה בכספים" },
  { key: "can_edit_money", label: "עריכת כספים" },
  { key: "can_manage_users", label: "פעולות מנהל" },
  { key: "can_import", label: "ייבוא" },
];

export default function UsersClient({ users: initial, selfId }: { users: UserRow[]; selfId: string }) {
  const router = useRouter();
  const [users, setUsers] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // U1-5: a sign-in link to copy (after "העתק קישור" / "קישור חדש")
  const [linkInfo, setLinkInfo] = useState<{ email: string; url: string } | null>(null);
  // the name being edited on a card (✎). A nameless user shows the email:
  // handle_new_user falls back to it
  const [nameEdit, setNameEdit] = useState<{ id: string; draft: string } | null>(null);

  // router.refresh() hands new props; without this the list kept the first ones
  useEffect(() => setUsers(initial), [initial]);

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

  function applyPreset(u: UserRow, preset: PresetRole) {
    const { flags, role } = PRESETS[preset];
    void patch(u.id, { ...flags, role });
  }

  async function resend(u: UserRow, mode: "email" | "link") {
    setError(null);
    setNotice(null);
    setBusyId(u.id);
    const res = await fetch(`/api/users/${u.id}/resend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    setBusyId(null);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(d.error ?? "השליחה נכשלה");
      return;
    }
    if (mode === "link" && d.link) setLinkInfo({ email: u.email ?? "", url: d.link });
    else setNotice(`נשלח מייל כניסה אל ${u.email}.`);
  }

  const pendingUsers = users.filter((u) => !u.approved);
  const activeUsers = users.filter((u) => u.approved);

  const card = (u: UserRow) => {
    const isSelf = u.id === selfId;
    const nameless = !u.name?.trim() || u.name === u.email;
    const editingName = nameEdit?.id === u.id;
    const isOwnerRow = u.role === "owner";
    return (
      <div
        key={u.id}
        className="rounded-2xl border border-[var(--rule)] p-4"
        style={{ background: "rgba(255,255,255,0.03)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
      >
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="min-w-0">
            {editingName ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = nameEdit.draft.trim();
                  if (!name) return;
                  setNameEdit(null);
                  void patch(u.id, { name });
                }}
              >
                <input
                  autoFocus
                  value={nameEdit.draft}
                  onChange={(e) => setNameEdit({ id: u.id, draft: e.target.value })}
                  placeholder="שם"
                  maxLength={80}
                  className="border border-[var(--rule)] rounded-xl px-2 py-1 text-sm w-40"
                  style={{ background: "rgba(255,255,255,0.05)" }}
                />
                <button type="submit" disabled={!nameEdit.draft.trim()} className="text-[11px] text-[var(--violet-light)] disabled:opacity-40">
                  שמירה
                </button>
                <button type="button" onClick={() => setNameEdit(null)} className="text-[11px] text-[var(--faint)]">
                  ביטול
                </button>
              </form>
            ) : (
              <div className="font-bold text-sm flex items-center gap-2">
                {u.name || u.email || "—"}
                {isSelf && <span className="text-[10px] text-[var(--faint)]">(החשבון שלך)</span>}
                <button
                  onClick={() => setNameEdit({ id: u.id, draft: nameless ? "" : u.name ?? "" })}
                  disabled={busyId === u.id}
                  title={nameless ? "הוספת שם" : "עריכת שם"}
                  aria-label={nameless ? "הוספת שם" : "עריכת שם"}
                  className="text-[12px] font-normal text-[var(--faint)] hover:text-[var(--violet-light)] disabled:opacity-40"
                >
                  ✎
                </button>
              </div>
            )}
            <div className="text-[11px] text-[var(--faint)]" dir="ltr">{u.email}</div>
            {u.never_signed_in && (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-[var(--amber)] border border-[var(--amber)] rounded-full px-2 py-0.5">
                  הוזמן, טרם נכנס
                </span>
                <button
                  onClick={() => resend(u, "email")}
                  disabled={busyId === u.id}
                  className="text-[11px] border border-[var(--rule)] rounded-xl px-2.5 py-0.5 text-[var(--dim)] hover:bg-[var(--panel3)] disabled:opacity-40"
                >
                  שלח שוב במייל
                </button>
                <button
                  onClick={() => resend(u, "link")}
                  disabled={busyId === u.id}
                  className="text-[11px] border border-[var(--rule)] rounded-xl px-2.5 py-0.5 text-[var(--dim)] hover:bg-[var(--panel3)] disabled:opacity-40"
                >
                  קישור חדש
                </button>
              </div>
            )}
            {!u.approved && (
              <div className="text-[11px] text-[var(--faint)]">
                תאריך הרשמה: <span className="font-mono">{displayDateTime(u.created_at)}</span>
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
              אישור משתמש
            </button>
          )}
          <div className="flex-1" />
          {u.role === "owner" ? (
            // an owner's role is never changed from the app (U1-4)
            <span
              className="text-[11px] font-bold text-white rounded-xl px-2.5 py-1"
              style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
            >
              בעלים
            </span>
          ) : (
            !isSelf &&
            (Object.keys(PRESETS) as PresetRole[]).map((p) => {
              const current = u.role === p;
              return (
                <button
                  key={p}
                  onClick={() => applyPreset(u, p)}
                  disabled={busyId === u.id}
                  aria-pressed={current}
                  className={`text-[11px] border rounded-xl px-2.5 py-1 transition-colors disabled:opacity-40 ${
                    current
                      ? "border-[var(--violet-light)] text-white font-bold"
                      : "border-[var(--rule)] text-[var(--dim)] hover:bg-[var(--panel3)] hover:border-[var(--rule2)]"
                  }`}
                  style={current ? { background: "rgba(139,92,246,0.35)" } : undefined}
                >
                  {current ? `✓ ${PRESETS[p].label}` : PRESETS[p].label}
                </button>
              );
            })
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5">
          {PERMS.map((perm) => (
            <label key={perm.key} className={`flex items-center gap-2 text-xs ${isSelf || isOwnerRow ? "opacity-50" : "cursor-pointer"}`}>
              <input
                type="checkbox"
                // an owner has every permission, locked (API refuses too)
                checked={isOwnerRow ? true : u[perm.key]}
                disabled={isSelf || isOwnerRow || busyId === u.id}
                onChange={(e) => patch(u.id, { [perm.key]: e.target.checked })}
              />
              {perm.label}
            </label>
          ))}
        </div>
        {isOwnerRow ? (
          <div className="mt-2 text-[10px] text-[var(--faint)]">לבעלים יש את כל ההרשאות.</div>
        ) : (
          isSelf && <div className="mt-2 text-[10px] text-[var(--faint)]">אי אפשר לשנות את ההרשאות של עצמך.</div>
        )}
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
          onDone={(msg, link) => {
            setAddOpen(false);
            setNotice(msg);
            if (link) setLinkInfo(link);
            router.refresh();
          }}
        />
      )}
      {linkInfo && <LinkModal email={linkInfo.email} url={linkInfo.url} onClose={() => setLinkInfo(null)} />}
    </div>
  );
}

const ROLE_CHOICES: PresetRole[] = ["tech", "bookkeeper", "admin"];

// U1-5: email, name and role. role=owner is never offered — it is set by hand.
// The new user is created approved, with the role's preset flags.
function AddUserModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (msg: string, link?: { email: string; url: string }) => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<PresetRole>("tech");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(mode: "invite" | "link") {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name, role, mode }),
    });
    setBusy(false);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      // stay open: the owner fixes the address or picks the other way
      setError(d.error ?? "ההוספה נכשלה");
      return;
    }
    if (mode === "invite") onDone(`נשלחה הזמנה במייל אל ${email.trim()}.`);
    else onDone(`המשתמש נוצר (${PRESETS[role].label}).`, { email: email.trim(), url: d.link });
  }

  const fieldClass = "w-full border border-[var(--rule)] rounded-xl px-3 py-2 text-sm mb-2";
  const ready = !busy && !!email.trim() && !!name.trim();

  return (
    <Modal onClose={onClose}>
      <h3 className="font-bold mb-3">הוספת משתמש</h3>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="שם" className={fieldClass} style={{ background: "rgba(255,255,255,0.05)" }} />
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="אימייל"
        dir="ltr"
        className={fieldClass}
        style={{ background: "rgba(255,255,255,0.05)" }}
      />
      <div className="flex flex-wrap gap-2 mb-3">
        {ROLE_CHOICES.map((r) => (
          <button
            key={r}
            onClick={() => setRole(r)}
            className={`text-xs rounded-xl px-3 py-1.5 border transition-colors ${
              role === r ? "border-[var(--violet-light)] text-white" : "border-[var(--rule)] text-[var(--dim)] hover:bg-[var(--panel3)]"
            }`}
            style={role === r ? { background: "rgba(139,92,246,0.25)" } : undefined}
          >
            {PRESETS[r].label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-[var(--faint)] mb-3">
        ההרשאות נקבעות לפי התפקיד, ואפשר לשנות אותן אחר כך ברשימה. המשתמש ייכנס ישר למערכת, בלי המתנה לאישור.
      </p>
      {error && <div className="text-[var(--peak)] text-xs mb-3">{error}</div>}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => submit("invite")}
          disabled={!ready}
          className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
          style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
        >
          שלח הזמנה במייל
        </button>
        <button
          onClick={() => submit("link")}
          disabled={!ready}
          className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)] hover:bg-[var(--panel3)] disabled:opacity-40 transition-colors"
        >
          העתק קישור
        </button>
        <button onClick={onClose} className="text-[var(--faint)] text-sm px-2">
          ביטול
        </button>
      </div>
    </Modal>
  );
}

// U1-5: our own /auth/confirm link (never Supabase's action_link), to send by hand
function LinkModal({ email, url, onClose }: { email: string; url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // no clipboard permission: the field below is selectable by hand
    }
  }

  return (
    <Modal onClose={onClose}>
      <h3 className="font-bold mb-1">קישור כניסה</h3>
      <div className="text-[11px] text-[var(--faint)] mb-3" dir="ltr">{email}</div>
      <input
        readOnly
        value={url}
        dir="ltr"
        onFocus={(e) => e.currentTarget.select()}
        className="w-full border border-[var(--rule)] rounded-xl px-3 py-2 text-xs mb-2 font-mono"
        style={{ background: "rgba(255,255,255,0.05)" }}
      />
      <p className="text-[11px] text-[var(--faint)] mb-3">הקישור בתוקף לשעה ולשימוש אחד. אפשר לשלוח אותו בוואטסאפ או במייל.</p>
      <div className="flex gap-2">
        <button
          onClick={copy}
          className="text-white font-bold rounded-xl px-4 py-2 text-sm"
          style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
        >
          {copied ? "הועתק ✓" : "העתק קישור"}
        </button>
        <button onClick={onClose} className="text-[var(--faint)] text-sm px-2">
          סגירה
        </button>
      </div>
    </Modal>
  );
}

function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
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
        {children}
      </div>
    </div>
  );
}
