"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export type ShowRow = {
  id: string;
  name: string;
  client_id: string | null;
  aliases: string[];
  default_rate: number | null; // null when the viewer lacks can_view_money
  default_studio: string | null;
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
  clients,
  canViewMoney,
  canEditMoney,
  canEditStages,
}: {
  shows: ShowRow[];
  episodes: EpisodeRow[];
  clients: Client[];
  canViewMoney: boolean;
  canEditMoney: boolean;
  canEditStages: boolean;
}) {
  const router = useRouter();
  const [shows, setShows] = useState(initialShows);
  const [tab, setTab] = useState<"active" | "oneoff" | "all">("active");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canEdit = canEditStages || canEditMoney;
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
        <h1 className="text-lg font-bold">📺 תוכניות</h1>
        <span className="text-xs text-[var(--dim)]">
          {activeCount} פעילות · {oneoffCount} חד־פעמיות
        </span>
        <div className="flex-1" />
        {canEditMoney && (
          <Link
            href="/shows/assign"
            className="text-xs border border-[var(--rule)] rounded px-3 py-1.5 text-[var(--dim)] hover:bg-[var(--panel3)]"
          >
            שיוך יתומות
          </Link>
        )}
        {canEdit && (
          <button
            onClick={() => setMergeOpen(true)}
            className="text-xs border border-[var(--rule)] rounded px-3 py-1.5 text-[var(--dim)] hover:bg-[var(--panel3)]"
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
            className={`text-xs rounded px-3 py-1.5 border ${
              tab === key
                ? "border-[var(--signal)] text-[var(--signal)] font-bold"
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
          className="mr-auto w-64 max-w-full bg-[var(--panel2)] border border-[var(--rule)] rounded px-3 py-1.5 text-sm"
        />
      </div>

      {error && (
        <div className="mb-3 text-xs text-[var(--peak)] border border-[var(--peak)] rounded px-3 py-2">
          {error}
        </div>
      )}

      <div className="overflow-x-auto border border-[var(--rule)] rounded">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-xs text-[var(--faint)] border-b border-[var(--rule)] bg-[var(--panel2)]">
              <th className="px-3 py-2 font-normal">תוכנית</th>
              {canViewMoney && <th className="px-3 py-2 font-normal">לקוח</th>}
              <th className="px-3 py-2 font-normal">פרקים</th>
              <th className="px-3 py-2 font-normal">כינויים</th>
              {canViewMoney && <th className="px-3 py-2 font-normal">מחיר/פרק</th>}
              {canViewMoney && <th className="px-3 py-2 font-normal">הכנסה מצטברת</th>}
              <th className="px-3 py-2 font-normal">פעיל</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr
                key={s.id}
                onClick={() => setOpenId(s.id)}
                className="border-b border-[var(--rule)] last:border-b-0 hover:bg-[var(--panel3)] cursor-pointer"
              >
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ background: s.color ?? "var(--rule2)" }}
                    />
                    <span className={s.active ? "" : "text-[var(--dim)]"}>{s.name}</span>
                    {s.is_oneoff && <span className="text-[10px] text-[var(--faint)]">חד־פעמית</span>}
                  </span>
                </td>
                {canViewMoney && (
                  <td className="px-3 py-2 text-[var(--dim)]">
                    {s.client_id ? clientName[s.client_id] ?? "—" : "—"}
                  </td>
                )}
                <td className="px-3 py-2">{s.episodes}</td>
                <td className="px-3 py-2 text-xs text-[var(--dim)]">
                  {s.aliases.length === 0
                    ? "—"
                    : s.aliases.length <= 2
                    ? s.aliases.join(", ")
                    : `${s.aliases.slice(0, 2).join(", ")} +${s.aliases.length - 2}`}
                </td>
                {canViewMoney && <td className="px-3 py-2">{money(s.default_rate)}</td>}
                {canViewMoney && (
                  <td className="px-3 py-2 font-bold">{s.revenue ? money(s.revenue) : "—"}</td>
                )}
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
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
                <td colSpan={canViewMoney ? 7 : 4} className="px-3 py-6 text-center text-[var(--faint)] text-xs">
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
}: {
  show: ShowRow;
  episodes: EpisodeRow[];
  clients: Client[];
  canViewMoney: boolean;
  canEditMoney: boolean;
  canEdit: boolean;
  onSave: (id: string, patch: Record<string, unknown>) => Promise<boolean>;
  onClose: () => void;
}) {
  const studioHours = episodes.reduce((t, e) => t + (e.studio_hours ?? 0), 0);
  const editHours = episodes.reduce((t, e) => t + (e.edit_hours ?? 0), 0);
  const perEpisode = show.revenue && episodes.length > 0 ? Math.round(show.revenue / episodes.length) : null;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl max-h-[88vh] overflow-y-auto border border-[var(--rule2)] rounded bg-[var(--panel2)] p-5"
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
              className={`text-xs border rounded px-3 py-1.5 ${
                show.active
                  ? "border-[var(--rule)] text-[var(--dim)] hover:bg-[var(--panel3)]"
                  : "border-[var(--signal)] text-[var(--signal)]"
              }`}
            >
              {show.active ? "ארכב תוכנית" : "הפעל תוכנית"}
            </button>
          )}
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
              <select
                value={show.client_id ?? ""}
                disabled={!canEditMoney}
                onChange={(e) => onSave(show.id, { client_id: e.target.value || null })}
                className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1.5"
              >
                <option value="">— פנימי / ללא לקוח —</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
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
        </div>

        {canViewMoney && (
          <div className="grid grid-cols-4 gap-2 mb-5 text-center">
            {[
              ["הכנסה מצטברת", show.revenue ? money(show.revenue) : "—"],
              ["שעות אולפן", studioHours ? String(studioHours) : "—"],
              ["שעות עריכה", editHours ? String(editHours) : "—"],
              ["הכנסה לפרק", perEpisode ? money(perEpisode) : "—"],
            ].map(([label, value]) => (
              <div key={label} className="border border-[var(--rule)] rounded p-2">
                <div className="text-[10px] text-[var(--faint)] mb-1">{label}</div>
                <div className="text-sm font-bold">{value}</div>
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
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md border border-[var(--rule2)] rounded bg-[var(--panel2)] p-5"
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
            className="bg-[var(--signal)] text-[#0C1410] font-bold rounded px-4 py-2 text-sm disabled:opacity-40"
          >
            מזג
          </button>
          <button onClick={onClose} className="border border-[var(--rule)] rounded px-4 py-2 text-sm text-[var(--dim)]">
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}
