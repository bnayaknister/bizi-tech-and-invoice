"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import IconTile from "@/components/IconTile";
import ClientCombobox from "@/components/ClientCombobox";

export type ShowRow = {
  id: string;
  name: string;
  client_id: string | null;
  aliases: string[];
  default_rate: number | null; // null when the viewer lacks can_view_money
  default_studio: string | null;
  camera_count: number | null;
  notes: string | null;
  active: boolean;
  is_oneoff: boolean;
  color: string | null;
  episodes: number;
  revenue: number | null; // null when the viewer lacks can_view_money
};

export type EpisodeRow = {
  id: string;
  show_id: string;
  record_date: string | null;
  status: string;
  guest: string | null;
  studio_hours: number | null;
  edit_hours: number | null;
};

type Client = { id: string; name: string };

const NIS = new Intl.NumberFormat("he-IL");

function money(n: number | null | undefined): string {
  return n == null ? "—" : `${NIS.format(n)} ₪`;
}

export default function ShowsClient({
  shows: initialShows,
  episodes,
  clients: initialClients,
  canViewMoney,
  canEditMoney,
  canEditStages,
  canManageUsers,
  pendingShowIds,
  staff,
}: {
  shows: ShowRow[];
  episodes: EpisodeRow[];
  clients: Client[];
  canViewMoney: boolean;
  canEditMoney: boolean;
  canEditStages: boolean;
  canManageUsers: boolean;
  pendingShowIds: string[];
  staff: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [shows, setShows] = useState(initialShows);
  const [clients, setClients] = useState(initialClients);
  const [tab, setTab] = useState<"active" | "oneoff" | "all">("active");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [newShowOpen, setNewShowOpen] = useState(false);
  const [deleteFor, setDeleteFor] = useState<ShowRow | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set(pendingShowIds));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canEdit = canEditStages || canEditMoney;

  // Delete a show. An admin (user-manager) does it directly; a technician
  // can only REQUEST it — the request lands in the approval queue with a
  // mandatory reason (owner rule 2026-07-18). Either way the modal collects
  // the reason first.
  async function deleteOrRequest(show: ShowRow, reason: string) {
    setError(null);
    setNotice(null);
    if (canManageUsers) {
      const res = await fetch(`/api/shows/${show.id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "המחיקה נכשלה");
        return;
      }
      setShows((prev) => prev.filter((s) => s.id !== show.id));
      setNotice(`התוכנית "${show.name}" נמחקה.`);
    } else {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action_type: "show_delete", entity_type: "show", entity_id: show.id, reason }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "שליחת הבקשה נכשלה");
        return;
      }
      setPendingIds((prev) => new Set(prev).add(show.id));
      setNotice("הבקשה נשלחה לאישור מנהל.");
    }
  }
  const clientName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of clients) m[c.id] = c.name;
    return m;
  }, [clients]);

  const activeCount = shows.filter((s) => s.active).length;
  const oneoffCount = shows.filter((s) => s.is_oneoff).length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return shows.filter((s) => {
      if (tab === "active" && !s.active) return false;
      if (tab === "oneoff" && !s.is_oneoff) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.aliases.some((a) => a.toLowerCase().includes(q)) ||
        (s.client_id && (clientName[s.client_id] ?? "").toLowerCase().includes(q))
      );
    });
  }, [shows, tab, query, clientName]);

  async function save(id: string, patch: Record<string, unknown>): Promise<boolean> {
    setError(null);
    const res = await fetch("/api/shows/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, patch }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "שגיאה בשמירה");
      return false;
    }
    setShows((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    return true;
  }

  const open = openId ? shows.find((s) => s.id === openId) ?? null : null;

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <h1 className="text-lg font-bold flex items-center gap-2.5">
          <IconTile icon="shows" accent="cyan" size={30} iconSize={17} />
          תוכניות
        </h1>
        <span className="text-xs text-[var(--dim)]">
          <span className="font-mono">{activeCount}</span> פעילות · <span className="font-mono">{oneoffCount}</span> חד־פעמיות
        </span>
        <div className="flex-1" />
        {canEdit && (
          <button
            onClick={() => setNewShowOpen(true)}
            className="text-xs font-bold rounded-xl px-3 py-1.5 text-white transition-colors"
            style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
          >
            + תוכנית חדשה
          </button>
        )}
        {canEditMoney && (
          <Link
            href="/shows/assign"
            className="text-xs border border-[var(--rule)] rounded-xl px-3 py-1.5 text-[var(--dim)] hover:bg-[var(--panel3)] hover:border-[var(--rule2)] transition-colors"
          >
            שיוך יתומות
          </Link>
        )}
        {canEdit && (
          <button
            onClick={() => setMergeOpen(true)}
            className="text-xs border border-[var(--rule)] rounded-xl px-3 py-1.5 text-[var(--dim)] hover:bg-[var(--panel3)] hover:border-[var(--rule2)] transition-colors"
          >
            מזג שתי תוכניות
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {(
          [
            ["active", "פעילות"],
            ["oneoff", "חד־פעמיות"],
            ["all", "הכל"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`text-xs rounded-xl px-3 py-1.5 border transition-colors ${
              tab === key
                ? "border-[var(--violet)] text-[var(--violet-light)] font-bold bg-[rgba(139,92,246,0.08)]"
                : "border-[var(--rule)] text-[var(--dim)] hover:bg-[var(--panel3)]"
            }`}
          >
            {label}
          </button>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="חיפוש תוכנית, כינוי או לקוח…"
          className="mr-auto w-64 max-w-full border border-[var(--rule)] rounded-xl px-3 py-1.5 text-sm focus:border-[var(--violet-light)] outline-none transition-colors"
          style={{ background: "rgba(255,255,255,0.04)", backdropFilter: "blur(8px)" }}
        />
      </div>

      {error && (
        <div className="mb-3 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-3 text-xs text-[var(--green)] border border-[var(--green)] rounded-xl px-3 py-2">
          {notice}
        </div>
      )}

      <div
        className="overflow-x-auto border border-[var(--rule)] rounded-2xl"
        style={{ background: "rgba(255,255,255,0.03)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-[10px] uppercase tracking-wider text-[var(--faint)] border-b border-[var(--rule)] bg-[var(--panel3)]">
              <th className="px-3 py-2.5 font-semibold">תוכנית</th>
              {canViewMoney && <th className="px-3 py-2.5 font-semibold">לקוח</th>}
              <th className="px-3 py-2.5 font-semibold">פרקים</th>
              <th className="px-3 py-2.5 font-semibold">כינויים</th>
              {canViewMoney && <th className="px-3 py-2.5 font-semibold">מחיר/פרק</th>}
              {canViewMoney && <th className="px-3 py-2.5 font-semibold">הכנסה מצטברת</th>}
              <th className="px-3 py-2.5 font-semibold">פעיל</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr
                key={s.id}
                onClick={() => setOpenId(s.id)}
                className="border-b border-[var(--rule)] last:border-b-0 hover:bg-[rgba(255,255,255,0.03)] cursor-pointer transition-colors"
              >
                <td className="px-3 py-2.5">
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ background: s.color ?? "var(--rule2)" }}
                    />
                    <span className={s.active ? "" : "text-[var(--dim)]"}>{s.name}</span>
                    {s.is_oneoff && <span className="text-[10px] text-[var(--faint)]">חד־פעמית</span>}
                    {pendingIds.has(s.id) && (
                      <span className="text-[10px] text-[var(--amber)] border border-[var(--amber)] rounded-full px-1.5 py-0.5">
                        ממתין לאישור
                      </span>
                    )}
                  </span>
                </td>
                {canViewMoney && (
                  <td className="px-3 py-2.5 text-[var(--dim)]">
                    {s.client_id ? clientName[s.client_id] ?? "—" : "—"}
                  </td>
                )}
                <td className="px-3 py-2.5 font-mono">{s.episodes}</td>
                <td className="px-3 py-2.5 text-xs text-[var(--dim)]">
                  {s.aliases.length === 0
                    ? "—"
                    : s.aliases.length <= 2
                    ? s.aliases.join(", ")
                    : `${s.aliases.slice(0, 2).join(", ")} +${s.aliases.length - 2}`}
                </td>
                {canViewMoney && <td className="px-3 py-2.5 font-mono">{money(s.default_rate)}</td>}
                {canViewMoney && (
                  <td className="px-3 py-2.5 font-mono font-bold">{s.revenue ? money(s.revenue) : "—"}</td>
                )}
                <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={s.active}
                    disabled={!canEdit}
                    onChange={() => save(s.id, { active: !s.active })}
                  />
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={canViewMoney ? 7 : 4} className="px-3 py-8 text-center text-[var(--faint)] text-xs">
                  אין תוכניות תואמות
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <ShowCard
          show={open}
          episodes={episodes.filter((e) => e.show_id === open.id)}
          clients={clients}
          canViewMoney={canViewMoney}
          canEditMoney={canEditMoney}
          canEdit={canEdit}
          onSave={save}
          onClose={() => setOpenId(null)}
          onClientCreated={(c) => setClients((cs) => [...cs, c].sort((a, b) => a.name.localeCompare(b.name, "he")))}
          canManageUsers={canManageUsers}
          isPending={pendingIds.has(open.id)}
          onDeleteAsk={(s) => {
            setOpenId(null);
            setDeleteFor(s);
          }}
        />
      )}

      {deleteFor && (
        <DeleteRequestModal
          show={deleteFor}
          canManageUsers={canManageUsers}
          onClose={() => setDeleteFor(null)}
          onConfirm={(reason) => {
            void deleteOrRequest(deleteFor, reason);
            setDeleteFor(null);
          }}
        />
      )}

      {mergeOpen && (
        <MergeModal
          shows={shows}
          onClose={() => setMergeOpen(false)}
          onMerged={() => {
            setMergeOpen(false);
            router.refresh();
          }}
        />
      )}

      {newShowOpen && (
        <NewShowModal
          clients={clients}
          staff={staff}
          canViewMoney={canViewMoney}
          canEditMoney={canEditMoney}
          onClose={() => setNewShowOpen(false)}
          onClientCreated={(c) => setClients((cs) => [...cs, c].sort((a, b) => a.name.localeCompare(b.name, "he")))}
          onCreated={(row) => {
            setShows((prev) => [row, ...prev]);
            setNewShowOpen(false);
            setNotice(`התוכנית "${row.name}" נוצרה.`);
          }}
        />
      )}
    </div>
  );
}

// ============ the heart of the screen: fast alias editing ============
// aliases feed calendar matching — every add here is a name the daily
// sync will recognize. Enter adds, ✕ removes, each change saves instantly.
function AliasEditor({
  show,
  canEdit,
  onSave,
}: {
  show: ShowRow;
  canEdit: boolean;
  onSave: (id: string, patch: Record<string, unknown>) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function change(aliases: string[]) {
    setBusy(true);
    await onSave(show.id, { aliases });
    setBusy(false);
  }

  async function add() {
    const v = draft.trim().replace(/\s+/g, " ");
    if (!v || v === show.name || show.aliases.includes(v)) {
      setDraft("");
      return;
    }
    await change([...show.aliases, v]);
    setDraft("");
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs font-bold">כינויים</span>
        <span className="text-[10px] text-[var(--faint)]">מזינים את זיהוי היומן — כל שם שהתוכנית מופיעה בו</span>
        {busy && <span className="text-[10px] text-[var(--faint)]">שומר…</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {show.aliases.map((a) => (
          <span
            key={a}
            className="inline-flex items-center gap-1 bg-[var(--panel3)] border border-[var(--rule)] rounded-full px-2.5 py-1 text-xs"
          >
            {a}
            {canEdit && (
              <button
                onClick={() => change(show.aliases.filter((x) => x !== a))}
                disabled={busy}
                className="text-[var(--faint)] hover:text-[var(--peak)]"
                aria-label={`הסר כינוי ${a}`}
              >
                ✕
              </button>
            )}
          </span>
        ))}
        {show.aliases.length === 0 && <span className="text-xs text-[var(--faint)]">אין כינויים עדיין</span>}
        {canEdit && (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            onBlur={() => draft.trim() && add()}
            placeholder="+ הוסף כינוי ולחץ Enter"
            disabled={busy}
            className="bg-[var(--panel2)] border border-dashed border-[var(--rule2)] rounded-full px-3 py-1 text-xs w-44 focus:border-[var(--signal)] outline-none"
          />
        )}
      </div>
    </div>
  );
}

function ShowCard({
  show,
  episodes,
  clients,
  canViewMoney,
  canEditMoney,
  canEdit,
  onSave,
  onClose,
  onClientCreated,
  canManageUsers,
  isPending,
  onDeleteAsk,
}: {
  show: ShowRow;
  episodes: EpisodeRow[];
  clients: Client[];
  canViewMoney: boolean;
  canEditMoney: boolean;
  canEdit: boolean;
  onSave: (id: string, patch: Record<string, unknown>) => Promise<boolean>;
  onClose: () => void;
  onClientCreated: (client: Client) => void;
  canManageUsers: boolean;
  isPending: boolean;
  onDeleteAsk: (show: ShowRow) => void;
}) {
  const studioHours = episodes.reduce((t, e) => t + (e.studio_hours ?? 0), 0);
  const editHours = episodes.reduce((t, e) => t + (e.edit_hours ?? 0), 0);
  const perEpisode = show.revenue && episodes.length > 0 ? Math.round(show.revenue / episodes.length) : null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 z-50"
      style={{ background: "rgba(3,2,10,0.66)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl max-h-[88vh] overflow-y-auto border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl"
        style={{ background: "rgba(15,13,28,0.92)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
      >
        <div className="flex items-center gap-3 mb-4">
          <span
            className="inline-block w-3 h-3 rounded-full shrink-0"
            style={{ background: show.color ?? "var(--rule2)" }}
          />
          <h2 className="font-bold text-base flex-1">{show.name}</h2>
          {show.is_oneoff && <span className="text-[10px] text-[var(--faint)]">חד־פעמית</span>}
          {canEdit && (
            <button
              onClick={() => onSave(show.id, { active: !show.active })}
              className={`text-xs border rounded-xl px-3 py-1.5 transition-colors ${
                show.active
                  ? "border-[var(--rule)] text-[var(--dim)] hover:bg-[var(--panel3)]"
                  : "border-[var(--violet)] text-[var(--violet-light)]"
              }`}
            >
              {show.active ? "ארכב תוכנית" : "הפעל תוכנית"}
            </button>
          )}
          {canEdit &&
            (isPending ? (
              <span className="text-[10px] text-[var(--amber)] border border-[var(--amber)] rounded-xl px-2.5 py-1.5">
                ממתין לאישור
              </span>
            ) : (
              <button
                onClick={() => onDeleteAsk(show)}
                className="text-xs border border-[var(--red)] text-[var(--red)] rounded-xl px-3 py-1.5 hover:bg-[rgba(251,113,133,0.08)] transition-colors"
              >
                {canManageUsers ? "מחק תוכנית" : "בקש מחיקה"}
              </button>
            ))}
          <button onClick={onClose} className="text-[var(--faint)] hover:text-[var(--ink)]" aria-label="סגור">
            ✕
          </button>
        </div>

        <div className="mb-5">
          <AliasEditor show={show} canEdit={canEdit} onSave={onSave} />
        </div>

        <div className="grid grid-cols-2 gap-3 mb-5">
          {canViewMoney && (
            <label className="text-xs">
              <span className="block text-[var(--faint)] mb-1">לקוח</span>
              <ClientCombobox
                clients={clients}
                value={show.client_id}
                disabled={!canEditMoney}
                placeholder="— פנימי / ללא לקוח —"
                onChange={(clientId) => void onSave(show.id, { client_id: clientId })}
                onCreated={onClientCreated}
              />
            </label>
          )}
          {canViewMoney && (
            <label className="text-xs">
              <span className="block text-[var(--faint)] mb-1">מחיר לפרק</span>
              <input
                type="number"
                defaultValue={show.default_rate ?? ""}
                disabled={!canEditMoney}
                onBlur={(e) => {
                  const v = e.target.value === "" ? null : Number(e.target.value);
                  if (v !== show.default_rate) onSave(show.id, { default_rate: v });
                }}
                placeholder="—"
                className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1.5"
              />
            </label>
          )}
          <label className="text-xs">
            <span className="block text-[var(--faint)] mb-1">אולפן ברירת מחדל</span>
            <input
              defaultValue={show.default_studio ?? ""}
              disabled={!canEdit}
              onBlur={(e) => {
                const v = e.target.value.trim() || null;
                if (v !== show.default_studio) onSave(show.id, { default_studio: v });
              }}
              placeholder="—"
              className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1.5"
            />
          </label>
          <label className="text-xs">
            <span className="block text-[var(--faint)] mb-1">צבע ביומן</span>
            <input
              type="color"
              value={show.color ?? "#3D4454"}
              disabled={!canEdit}
              onChange={(e) => onSave(show.id, { color: e.target.value })}
              className="w-full h-8 bg-[var(--panel)] border border-[var(--rule)] rounded cursor-pointer"
            />
          </label>
          <label className="text-xs">
            <span className="block text-[var(--faint)] mb-1">מספר מצלמות</span>
            <input
              type="number"
              min={0}
              defaultValue={show.camera_count ?? ""}
              disabled={!canEdit}
              onBlur={(e) => {
                const v = e.target.value === "" ? null : Number(e.target.value);
                if (v !== show.camera_count) onSave(show.id, { camera_count: v });
              }}
              placeholder="—"
              className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1.5"
            />
          </label>
        </div>

        <label className="block text-xs mb-5">
          <span className="block text-[var(--faint)] mb-1">הערות</span>
          <textarea
            defaultValue={show.notes ?? ""}
            disabled={!canEdit}
            rows={2}
            onBlur={(e) => {
              const v = e.target.value.trim() || null;
              if (v !== show.notes) onSave(show.id, { notes: v });
            }}
            placeholder="הערות חופשיות על התוכנית…"
            className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1.5 text-xs resize-y"
          />
        </label>

        {canViewMoney && (
          <div className="grid grid-cols-4 gap-2 mb-5 text-center">
            {[
              ["הכנסה מצטברת", show.revenue ? money(show.revenue) : "—"],
              ["שעות אולפן", studioHours ? String(studioHours) : "—"],
              ["שעות עריכה", editHours ? String(editHours) : "—"],
              ["הכנסה לפרק", perEpisode ? money(perEpisode) : "—"],
            ].map(([label, value]) => (
              <div
                key={label}
                className="border border-[var(--rule)] rounded-xl p-2"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <div className="text-[10px] text-[var(--faint)] mb-1">{label}</div>
                <div className="text-sm font-bold font-mono">{value}</div>
              </div>
            ))}
          </div>
        )}

        <div>
          <div className="text-xs font-bold mb-1.5">פרקים ({episodes.length})</div>
          <div className="max-h-56 overflow-y-auto border border-[var(--rule)] rounded">
            {episodes.map((e) => (
              <div
                key={e.id}
                className="flex items-center gap-3 px-3 py-1.5 text-xs border-b border-[var(--rule)] last:border-b-0"
              >
                <span className="text-[var(--dim)] w-20 shrink-0">{e.record_date ?? "—"}</span>
                <span className="flex-1 truncate">{e.guest || ""}</span>
                <span className="text-[var(--faint)]">{(e.status ?? "").replace(/_/g, " ")}</span>
              </div>
            ))}
            {episodes.length === 0 && (
              <div className="px-3 py-4 text-center text-[var(--faint)] text-xs">אין פרקים</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MergeModal({
  shows,
  onClose,
  onMerged,
}: {
  shows: ShowRow[];
  onClose: () => void;
  onMerged: () => void;
}) {
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const source = shows.find((s) => s.id === sourceId);
  const target = shows.find((s) => s.id === targetId);
  const ready = source && target && sourceId !== targetId;

  async function merge() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/shows/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, targetId }),
    });
    setBusy(false);
    if (res.ok) {
      onMerged();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "שגיאת מיזוג");
    }
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 z-50"
      style={{ background: "rgba(3,2,10,0.66)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl"
        style={{ background: "rgba(15,13,28,0.92)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
      >
        <h3 className="font-bold mb-1">מיזוג שתי תוכניות</h3>
        <p className="text-xs text-[var(--dim)] mb-4">
          לשימוש נדיר — כשאותה תוכנית נוצרה פעמיים בטעות.
        </p>

        <label className="block text-xs mb-3">
          <span className="block text-[var(--faint)] mb-1">תוכנית שתימחק (המקור)</span>
          <select
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1.5"
          >
            <option value="">בחר…</option>
            {shows.map((s) => (
              <option key={s.id} value={s.id} disabled={s.id === targetId}>
                {s.name} ({s.episodes})
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs mb-4">
          <span className="block text-[var(--faint)] mb-1">תוכנית שתקבל הכל (היעד)</span>
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1.5"
          >
            <option value="">בחר…</option>
            {shows.map((s) => (
              <option key={s.id} value={s.id} disabled={s.id === sourceId}>
                {s.name} ({s.episodes})
              </option>
            ))}
          </select>
        </label>

        {ready && (
          <div className="text-xs text-[var(--warn)] border border-[var(--warn)] rounded px-3 py-2 mb-4">
            {source!.episodes} הפקות של &quot;{source!.name}&quot; יעברו ל&quot;{target!.name}&quot;,
            השם &quot;{source!.name}&quot; יתווסף ככינוי, והתוכנית תימחק. הפעולה נרשמת ביומן האירועים.
          </div>
        )}
        {error && (
          <div className="text-xs text-[var(--peak)] border border-[var(--peak)] rounded px-3 py-2 mb-4">
            {error}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={merge}
            disabled={!ready || busy}
            className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
            style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 14px rgba(139,92,246,0.3)" }}
          >
            מזג
          </button>
          <button onClick={onClose} className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)] hover:bg-[var(--panel3)] transition-colors">
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}

// Delete/request modal: reason is mandatory for BOTH paths (an admin's
// direct delete and a technician's request), so the audit trail always has
// a "why". The button label + copy adapt to whether this user can delete
// directly or is filing a request.
function DeleteRequestModal({
  show,
  canManageUsers,
  onClose,
  onConfirm,
}: {
  show: ShowRow;
  canManageUsers: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
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
        <h3 className="font-bold mb-1">{canManageUsers ? "מחיקת תוכנית" : "בקשת מחיקת תוכנית"}</h3>
        <p className="text-xs text-[var(--dim)] mb-1">{show.name}</p>
        <p className="text-[11px] text-[var(--faint)] mb-3">
          {canManageUsers
            ? "פעולה בלתי הפיכה. למה למחוק?"
            : "פעולה זו דורשת אישור מנהל. למה אתה רוצה למחוק?"}
        </p>
        <textarea
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder="סיבה (חובה)"
          className="w-full border border-[var(--rule)] rounded-xl px-3 py-2 text-sm mb-4 resize-y"
          style={{ background: "rgba(255,255,255,0.05)" }}
        />
        <div className="flex gap-2">
          <button
            onClick={() => onConfirm(reason)}
            disabled={!reason.trim()}
            className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
            style={{ background: "linear-gradient(135deg, var(--red), var(--red-dk))" }}
          >
            {canManageUsers ? "מחק" : "שלח בקשה"}
          </button>
          <button onClick={onClose} className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)] hover:bg-[var(--panel3)] transition-colors">
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}

// "+ תוכנית חדשה" — create a show for a podcast that never came through the
// import. Operational fields are always editable; money fields (client / rate /
// billing) show only for a can_view_money viewer, so a stages-only tech creates
// the shell and the owner completes it (owner spec 2026-07-22).
function NewShowModal({
  clients,
  staff,
  canViewMoney,
  canEditMoney,
  onClose,
  onClientCreated,
  onCreated,
}: {
  clients: Client[];
  staff: { id: string; name: string }[];
  canViewMoney: boolean;
  canEditMoney: boolean;
  onClose: () => void;
  onClientCreated: (c: Client) => void;
  onCreated: (row: ShowRow) => void;
}) {
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasDraft, setAliasDraft] = useState("");
  const [clientId, setClientId] = useState<string | null>(null);
  const [billingMode, setBillingMode] = useState<"per_episode" | "none">("per_episode");
  const [rate, setRate] = useState("");
  const [studio, setStudio] = useState("");
  const [cameras, setCameras] = useState("");
  const [editorId, setEditorId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // when the server asks "internal?" we surface a confirm step instead of an error
  const [confirmInternal, setConfirmInternal] = useState(false);

  function addAlias() {
    const v = aliasDraft.trim().replace(/\s+/g, " ");
    if (v && v !== name && !aliases.includes(v)) setAliases((a) => [...a, v]);
    setAliasDraft("");
  }

  async function submit(internalConfirmed = false) {
    setError(null);
    if (!name.trim()) {
      setError("שם התוכנית חובה");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/shows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        aliases,
        client_id: canEditMoney ? clientId : null,
        billing_mode: canEditMoney ? billingMode : "none",
        default_rate: canEditMoney && billingMode === "per_episode" && rate.trim() ? Number(rate) : null,
        default_studio: studio.trim() || null,
        camera_count: cameras.trim() ? Number(cameras) : null,
        default_editor_id: editorId,
        notes: notes.trim() || null,
        internal_confirmed: internalConfirmed,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      if (data.code === "needs_internal_confirmation") {
        setConfirmInternal(true);
        return;
      }
      setError(data.error ?? "יצירת התוכנית נכשלה");
      return;
    }
    const s = data.show;
    onCreated({
      id: s.id,
      name: s.name,
      client_id: s.client_id ?? null,
      aliases: s.aliases ?? [],
      default_rate: canViewMoney ? data.default_rate ?? null : null,
      default_studio: s.default_studio ?? null,
      camera_count: s.camera_count ?? null,
      notes: s.notes ?? null,
      active: s.active,
      is_oneoff: s.is_oneoff,
      color: s.color ?? null,
      episodes: 0,
      revenue: canViewMoney ? 0 : null,
    });
  }

  const field = "w-full bg-[var(--panel)] border border-[var(--rule)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--violet-light)]";
  const labelCls = "text-xs text-[var(--dim)] mb-1 block";

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 z-50"
      style={{ background: "rgba(3,2,10,0.66)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md max-h-[90vh] overflow-y-auto border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl"
        style={{ background: "rgba(15,13,28,0.94)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
      >
        <h2 className="font-bold text-base mb-4">תוכנית חדשה</h2>

        <div className="space-y-3">
          <div>
            <label className={labelCls}>שם התוכנית *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className={field} placeholder="שם הפודקאסט" />
          </div>

          <div>
            <label className={labelCls}>כינויים (איך זה כתוב ביומן)</label>
            <div className="flex flex-wrap items-center gap-1.5">
              {aliases.map((a) => (
                <span key={a} className="inline-flex items-center gap-1 bg-[var(--panel3)] border border-[var(--rule)] rounded-full px-2.5 py-1 text-xs">
                  {a}
                  <button onClick={() => setAliases((xs) => xs.filter((x) => x !== a))} className="text-[var(--faint)] hover:text-[var(--peak)]" aria-label={`הסר ${a}`}>✕</button>
                </span>
              ))}
              <input
                value={aliasDraft}
                onChange={(e) => setAliasDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAlias(); } }}
                onBlur={() => aliasDraft.trim() && addAlias()}
                placeholder="+ הוסף כינוי ולחץ Enter"
                className="bg-[var(--panel2)] border border-dashed border-[var(--rule2)] rounded-full px-3 py-1 text-xs w-44 focus:border-[var(--signal)] outline-none"
              />
            </div>
          </div>

          {canViewMoney && (
            <>
              <div>
                <label className={labelCls}>לקוח</label>
                <ClientCombobox
                  clients={clients}
                  value={clientId}
                  onChange={setClientId}
                  onCreated={(c) => { onClientCreated(c); setClientId(c.id); }}
                  disabled={!canEditMoney}
                  placeholder="חפש או צור לקוח…"
                />
                <div className="text-[10px] text-[var(--faint)] mt-1">בלי לקוח → הפקה פנימית (ללא חיוב)</div>
              </div>

              <div>
                <label className={labelCls}>אופן חיוב</label>
                <div className="flex gap-2">
                  {([["per_episode", "לפי פרק"], ["none", "ללא חיוב"]] as const).map(([v, l]) => (
                    <button
                      key={v}
                      onClick={() => canEditMoney && setBillingMode(v)}
                      disabled={!canEditMoney}
                      className={`flex-1 text-xs rounded-lg py-2 border transition-colors disabled:opacity-50 ${
                        billingMode === v ? "border-[var(--violet-light)] text-[var(--violet-light)] font-bold" : "border-[var(--rule)] text-[var(--dim)]"
                      }`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>

              {billingMode === "per_episode" && canEditMoney && (
                <div>
                  <label className={labelCls}>מחיר לפרק (₪)</label>
                  <input value={rate} onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ""))} className={field} placeholder="למשל 1500" inputMode="decimal" />
                </div>
              )}
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>אולפן ברירת מחדל</label>
              <input value={studio} onChange={(e) => setStudio(e.target.value)} className={field} />
            </div>
            <div>
              <label className={labelCls}>מספר מצלמות</label>
              <input value={cameras} onChange={(e) => setCameras(e.target.value.replace(/\D/g, ""))} className={field} inputMode="numeric" />
            </div>
          </div>

          <div>
            <label className={labelCls}>עורך קבוע</label>
            <select value={editorId ?? ""} onChange={(e) => setEditorId(e.target.value || null)} className={field}>
              <option value="">— ללא —</option>
              {staff.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelCls}>הערות</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={field} />
          </div>
        </div>

        {error && <div className="mt-3 text-xs text-[var(--peak)] border border-[var(--peak)]/40 rounded-lg px-3 py-2">{error}</div>}

        {confirmInternal ? (
          <div className="mt-4 rounded-lg border border-amber-500/40 px-3 py-3" style={{ background: "rgba(251,191,36,0.08)" }}>
            <div className="text-xs font-bold text-amber-400 mb-1">אין לקוח מקושר — זו הפקה פנימית?</div>
            <div className="text-[11px] text-[var(--dim)] mb-2">תיווצר ללא חיוב. אפשר לשייך לקוח מאוחר יותר.</div>
            <div className="flex gap-2">
              <button onClick={() => void submit(true)} disabled={busy} className="flex-1 text-xs font-bold rounded-lg py-2 text-white" style={{ background: "var(--violet)" }}>
                כן, פנימית — צור
              </button>
              <button onClick={() => setConfirmInternal(false)} className="flex-1 text-xs rounded-lg py-2 border border-[var(--rule)] text-[var(--dim)]">
                חזרה
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2 mt-5">
            <button onClick={() => void submit(false)} disabled={busy || !name.trim()} className="flex-1 text-sm font-bold rounded-xl py-2 text-white disabled:opacity-40" style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}>
              {busy ? "יוצר…" : "צור תוכנית"}
            </button>
            <button onClick={onClose} className="flex-1 text-sm rounded-xl py-2 border border-[var(--rule)] text-[var(--dim)] hover:bg-[var(--panel3)]">
              ביטול
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
