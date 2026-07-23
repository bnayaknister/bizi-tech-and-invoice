"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useDrawer } from "@/components/EntityDrawer";
import IconTile from "@/components/IconTile";
import { STATUS_ORDER, STATUS_LABEL, IN_PROGRESS_STATES, TERMINAL_STATES } from "@/lib/productions/status";

export type BoardProduction = {
  id: string;
  status: string;
  record_date: string | null;
  record_time: string | null;
  guest: string | null;
  studio: string | null;
  on_hold: boolean;
  on_hold_reason: string | null;
  on_hold_since: string | null;
  needs_attention: boolean;
  show_name: string;
  show_color: string | null;
  show_active: boolean;
  client_name: string | null; // null unless can_view_money
  stages_done: number;
  stages_total: number;
  in_progress: { track: string; step: string; assignee: string | null }[];
  mine: boolean;
  split_index: number | null;
  split_count: number | null;
  dup_group: { count: number; ids: string[] } | null;
  absorbed: { id: string }[];
  legacy: boolean;
  log_count: number; // human journal entries (notes + client notes)
};

const STEP_LABEL: Record<string, string> = { record: "הקלטה", edit: "עריכה", deliver: "מסירה" };
const TRACK_LABEL: Record<string, string> = { episode: "פרק", reels: "רילז" };

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / 86_400_000);
}

export default function ProductionsClient({
  board,
  isTech,
  canEditStages,
  shows,
}: {
  board: BoardProduction[];
  isTech: boolean;
  canEditStages: boolean;
  shows: { id: string; name: string }[];
}) {
  const { openEntity } = useDrawer();
  const router = useRouter();
  const [rows, setRows] = useState(board);
  const [tab, setTab] = useState<"today" | "kanban">("today");
  const [onlyMine, setOnlyMine] = useState(isTech); // default on for technicians
  const [activeOnly, setActiveOnly] = useState(true); // scope the kanban to live shows
  const [includeLegacy, setIncludeLegacy] = useState(false); // hide imported history by default (owner 2026-07-21)
  const [query, setQuery] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [holdFor, setHoldFor] = useState<BoardProduction | null>(null);
  const [splitFor, setSplitFor] = useState<BoardProduction | null>(null);
  const [cancelFor, setCancelFor] = useState<BoardProduction | null>(null);
  const [reviewFor, setReviewFor] = useState<BoardProduction | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  // these four all change the SET of board rows (create/hide productions),
  // not just a field on one — router.refresh() re-seeds `board` from the
  // server rather than trying to reconcile optimistic local state
  async function splitProduction(id: string, count: number) {
    setError(null);
    const res = await fetch(`/api/productions/${id}/split`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "פיצול נכשל");
      return;
    }
    router.refresh();
  }

  async function undoSplit(id: string) {
    setError(null);
    const res = await fetch(`/api/productions/${id}/split`, { method: "DELETE" });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "ביטול פיצול נכשל");
      return;
    }
    router.refresh();
  }

  async function dupAction(id: string, action: "confirm" | "merge") {
    setError(null);
    const res = await fetch(`/api/productions/${id}/duplicate-group`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "הפעולה נכשלה");
      return;
    }
    router.refresh();
  }

  async function unmerge(id: string) {
    setError(null);
    const res = await fetch(`/api/productions/${id}/duplicate-group`, { method: "DELETE" });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "ביטול מיזוג נכשל");
      return;
    }
    router.refresh();
  }

  async function createProduction(input: {
    show_id: string;
    record_date: string;
    record_time: string;
    studio: string;
    guest: string;
    notes: string;
  }): Promise<{ error?: string }> {
    const res = await fetch("/api/productions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return { error: d.error ?? "יצירת ההפקה נכשלה" };
    }
    router.refresh();
    return {};
  }

  async function syncNow() {
    setSyncing(true);
    setSyncResult(null);
    setError(null);
    const res = await fetch("/api/calendar/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    setSyncing(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "שגיאת סנכרון");
      return;
    }
    const d = await res.json();
    setSyncResult(
      `נוצרו ${d.created} · עודכנו ${d.updated} · דגל שינוי ${d.flaggedChanged} · דגל הוסר ${d.flaggedRemoved} · דולגו בשקט ${d.skippedNoMatch}`
    );
    router.refresh();
  }

  useEffect(() => setRows(board), [board]);

  // re-open of the same production after a drawer edit refreshes the page,
  // which re-seeds `board`; nothing else needed here

  const matches = useCallback(
    (p: BoardProduction) => {
      if (onlyMine && !p.mine) return false;
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        p.show_name.toLowerCase().includes(q) ||
        (p.guest ?? "").toLowerCase().includes(q) ||
        (p.studio ?? "").toLowerCase().includes(q) ||
        (p.client_name ?? "").toLowerCase().includes(q)
      );
    },
    [onlyMine, query]
  );

  async function act(id: string, body: Record<string, unknown>, optimistic: (p: BoardProduction) => BoardProduction) {
    const prev = rows;
    setRows((rs) => rs.map((p) => (p.id === id ? optimistic(p) : p)));
    setError(null);
    const res = await fetch(`/api/productions/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setRows(prev); // revert
      setError(data.error ?? "הפעולה נכשלה");
    }
  }

  // returns a result the modal acts on: a document warning to confirm, an
  // error, or success (the row is marked cancelled and leaves the board)
  async function cancelProduction(
    id: string,
    reason: string,
    confirm: boolean
  ): Promise<{ ok?: boolean; needsConfirmation?: boolean; issuedDocs?: { type: string; number: string | null }[]; error?: string }> {
    const res = await fetch(`/api/productions/${id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, confirm }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.needs_confirmation) {
      return { needsConfirmation: true, issuedDocs: data.issued_docs ?? [] };
    }
    if (!res.ok) return { error: data.error ?? "הביטול נכשל" };
    setRows((rs) => rs.map((p) => (p.id === id ? { ...p, status: "בוטל" } : p)));
    return { ok: true };
  }

  const moveStatus = (id: string, status: string) =>
    act(id, { status }, (p) => ({ ...p, status }));

  const setHold = (id: string, on: boolean, reason?: string) =>
    act(id, { hold: { on, reason } }, (p) => ({
      ...p,
      on_hold: on,
      on_hold_reason: on ? reason ?? null : null,
      on_hold_since: on ? new Date().toISOString() : null,
    }));

  // cancelled productions leave the board (kanban + today) but stay findable:
  // show them only when a search term is active (owner 2026-07-21)
  const filtered = useMemo(() => {
    // imported history (legacy) is hidden on both boards unless the viewer
    // opts in — 227 legacy rows sat in "עתיד להתחיל" and flooded the team's
    // view (owner 2026-07-21)
    const base = rows.filter(matches).filter((p) => includeLegacy || !p.legacy);
    return query.trim() ? base : base.filter((p) => p.status !== "בוטל");
  }, [rows, matches, query, includeLegacy]);

  return (
    <div className="max-w-[1400px] mx-auto p-6">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <h1 className="text-lg font-bold flex items-center gap-2.5">
          <IconTile icon="productions" accent="violet" size={30} iconSize={17} />
          הפקות
        </h1>
        <div className="flex rounded-xl border border-[var(--rule)] overflow-hidden">
          {(
            [
              ["today", "היום"],
              ["kanban", "קנבן"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`text-xs px-4 py-1.5 transition-colors ${
                tab === key
                  ? "text-white font-bold"
                  : "text-[var(--dim)] hover:bg-[var(--panel3)]"
              }`}
              style={tab === key ? { background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" } : undefined}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-1.5 text-xs text-[var(--dim)] cursor-pointer">
          <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
          רק שלי
        </label>
        {tab === "kanban" && (
          <label className="flex items-center gap-1.5 text-xs text-[var(--dim)] cursor-pointer">
            <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
            רק תוכניות פעילות
          </label>
        )}
        <label className="flex items-center gap-1.5 text-xs text-[var(--dim)] cursor-pointer">
          <input type="checkbox" checked={includeLegacy} onChange={(e) => setIncludeLegacy(e.target.checked)} />
          כולל היסטוריה
        </label>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="חיפוש תוכנית, אורח, אולפן…"
          className="mr-auto w-60 max-w-full border border-[var(--rule)] rounded-xl px-3 py-1.5 text-sm focus:border-[var(--violet-light)] outline-none transition-colors"
          style={{ background: "rgba(255,255,255,0.04)", backdropFilter: "blur(8px)" }}
        />

        {canEditStages && (
          <button
            onClick={() => setCreateOpen(true)}
            className="text-xs text-white font-bold rounded-xl px-3 py-1.5 transition-colors"
            style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 14px rgba(139,92,246,0.3)" }}
          >
            + הפקה חדשה
          </button>
        )}
        {canEditStages && (
          <button
            onClick={syncNow}
            disabled={syncing}
            className="text-xs border border-[var(--rule)] rounded-xl px-3 py-1.5 text-[var(--dim)] hover:bg-[var(--panel3)] hover:border-[var(--rule2)] disabled:opacity-50 transition-colors"
          >
            {syncing ? "מסנכרן…" : "סנכרן יומן עכשיו"}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-3 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2">{error}</div>
      )}
      {syncResult && (
        <div className="mb-3 text-xs text-[var(--dim)] border border-[var(--rule)] rounded-xl px-3 py-2 font-mono">{syncResult}</div>
      )}

      {tab === "today" ? (
        <TodayView
          rows={filtered}
          onOpen={(id) => openEntity({ type: "production", id })}
          onHold={setHold}
          onFreezeAsk={setHoldFor}
          onCancelAsk={setCancelFor}
          onReviewAsk={setReviewFor}
          canEditStages={canEditStages}
          onSplitAsk={setSplitFor}
          onUndoSplit={undoSplit}
          onDupAction={dupAction}
          onUnmerge={unmerge}
        />
      ) : (
        <Kanban
          rows={activeOnly ? filtered.filter((p) => p.show_active) : filtered}
          canEditStages={canEditStages}
          dragId={dragId}
          dragOver={dragOver}
          setDragId={setDragId}
          setDragOver={setDragOver}
          onDropTo={moveStatus}
          onOpen={(id) => openEntity({ type: "production", id })}
          onFreezeAsk={setHoldFor}
          onUnfreeze={(id) => setHold(id, false)}
          onCancelAsk={setCancelFor}
          onReviewAsk={setReviewFor}
          onSplitAsk={setSplitFor}
          onUndoSplit={undoSplit}
          onDupAction={dupAction}
          onUnmerge={unmerge}
        />
      )}

      {holdFor && (
        <HoldModal
          production={holdFor}
          onClose={() => setHoldFor(null)}
          onConfirm={(reason) => {
            setHold(holdFor.id, true, reason);
            setHoldFor(null);
          }}
        />
      )}

      {cancelFor && (
        <CancelModal
          production={cancelFor}
          onClose={() => setCancelFor(null)}
          onCancel={cancelProduction}
        />
      )}

      {reviewFor && <ReviewLinkModal production={reviewFor} onClose={() => setReviewFor(null)} />}

      {createOpen && (
        <NewProductionModal
          shows={shows}
          defaultDate={todayISO()}
          onClose={() => setCreateOpen(false)}
          onCreate={createProduction}
        />
      )}

      {splitFor && (
        <SplitModal
          production={splitFor}
          onClose={() => setSplitFor(null)}
          onConfirm={(count) => {
            void splitProduction(splitFor.id, count);
            setSplitFor(null);
          }}
        />
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const terminal = TERMINAL_STATES.has(status);
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded"
      style={{
        color: terminal ? "var(--green)" : "var(--dim)",
        background: terminal ? "rgba(74,222,128,.08)" : "var(--panel3)",
      }}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function ProductionCard({
  p,
  onOpen,
  onFreezeAsk,
  onUnfreeze,
  onCancelAsk,
  onReviewAsk,
  draggable,
  onDragStart,
  onDragEnd,
  showStatus,
  canEditStages,
  onSplitAsk,
  onUndoSplit,
  onDupAction,
  onUnmerge,
}: {
  p: BoardProduction;
  onOpen: (id: string) => void;
  onFreezeAsk: (p: BoardProduction) => void;
  onUnfreeze?: (id: string) => void;
  onCancelAsk?: (p: BoardProduction) => void;
  onReviewAsk?: (p: BoardProduction) => void;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  showStatus?: boolean;
  canEditStages: boolean;
  onSplitAsk: (p: BoardProduction) => void;
  onUndoSplit: (id: string) => void;
  onDupAction: (id: string, action: "confirm" | "merge") => void;
  onUnmerge: (id: string) => void;
}) {
  const heldDays = daysSince(p.on_hold_since);
  const ip = p.in_progress[0];
  const isSplit = !!p.split_count && p.split_count > 1;
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(p.id)}
      className={`lift group text-right w-full rounded-xl border p-3 cursor-pointer ${
        p.on_hold ? "opacity-60 border-[var(--rule)]" : "border-[var(--rule)]"
      }`}
      style={{
        borderInlineStartWidth: 3,
        borderInlineStartColor: p.show_color ?? "var(--rule2)",
        background: "rgba(255,255,255,0.035)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }}
    >
      <div className="flex items-center gap-1.5 mb-1">
        {p.needs_attention && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: "var(--red)" }} title="דורש טיפול" />}
        <span className="font-bold text-sm truncate flex-1">{p.show_name}</span>
        {p.on_hold && <span className="text-[10px] text-[var(--amber)] shrink-0">⏸ מוקפא</span>}
        {/* journal indicator — visible from the board so you know there's
            something written without opening the drawer. Click opens it. */}
        {p.log_count > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); onOpen(p.id); }}
            title="יומן ההפקה"
            className="text-[10px] text-[var(--dim)] hover:text-[var(--violet-light)] shrink-0 rounded px-1 py-0.5 border border-[var(--rule)] hover:border-[var(--violet-light)] transition-colors"
          >
            📝 {p.log_count}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--dim)]">
        {showStatus && <StatusPill status={p.status} />}
        {p.record_date && <span className="font-mono">{p.record_date}</span>}
        {p.record_time && <span className="font-mono">{p.record_time}</span>}
        {p.studio && <span>{p.studio}</span>}
        {p.guest && <span className="text-[var(--faint)]">· {p.guest}</span>}
      </div>
      {(ip || p.stages_total > 0) && (
        <div className="mt-1.5 text-[11px] text-[var(--faint)]">
          {ip ? (
            <span>
              {TRACK_LABEL[ip.track]} · {STEP_LABEL[ip.step]}
              {ip.assignee ? ` · ${ip.assignee}` : ""}
            </span>
          ) : (
            <span className="font-mono">{p.stages_done}/{p.stages_total} שלבים</span>
          )}
        </div>
      )}
      {p.on_hold && p.on_hold_reason && (
        <div className="mt-1 text-[10px] text-[var(--amber)]">
          &quot;{p.on_hold_reason}&quot;{heldDays != null ? ` · ${heldDays} ימים` : ""}
        </div>
      )}

      {isSplit && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--panel3)] text-[var(--dim)]">
            פרק {p.split_index} מתוך {p.split_count}
          </span>
          {canEditStages && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onUndoSplit(p.id);
              }}
              className="text-[10px] text-[var(--faint)] hover:text-[var(--dim)] underline"
            >
              בטל פיצול
            </button>
          )}
        </div>
      )}

      {p.dup_group && (
        <div className="mt-1.5 border border-[var(--amber)] rounded px-2 py-1.5">
          <div className="text-[10px] text-[var(--amber)] mb-1">
            זוהו {p.dup_group.count} הקלטות של {p.show_name} היום
          </div>
          {canEditStages && (
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDupAction(p.id, "confirm");
                }}
                className="text-[10px] border border-[var(--rule)] rounded px-1.5 py-0.5 hover:bg-[var(--panel3)]"
              >
                מאשר {p.dup_group.count} פרקים
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDupAction(p.id, "merge");
                }}
                className="text-[10px] border border-[var(--rule)] rounded px-1.5 py-0.5 hover:bg-[var(--panel3)]"
              >
                מזג ל-1 — טעות ביומן
              </button>
            </div>
          )}
        </div>
      )}

      {p.absorbed.length > 0 && (
        <div className="mt-1 text-[10px] text-[var(--faint)]">
          מוזגו לכאן {p.absorbed.length}
          {canEditStages && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onUnmerge(p.absorbed[0].id);
              }}
              className="underline mr-1"
            >
              בטל
            </button>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {p.on_hold ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onUnfreeze?.(p.id);
            }}
            className="text-[10px] text-[var(--dim)] border border-[var(--rule)] rounded px-2 py-0.5 hover:bg-[var(--panel3)]"
          >
            שחרר הקפאה
          </button>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onFreezeAsk(p);
            }}
            className="text-[10px] text-[var(--dim)] border border-[var(--rule)] rounded px-2 py-0.5 hover:bg-[var(--panel3)]"
          >
            הקפא
          </button>
        )}
        {canEditStages && !isSplit && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSplitAsk(p);
            }}
            className="text-[10px] text-[var(--dim)] border border-[var(--rule)] rounded px-2 py-0.5 hover:bg-[var(--panel3)]"
          >
            פצל
          </button>
        )}
        {canEditStages && onCancelAsk && p.status !== "בוטל" && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCancelAsk(p);
            }}
            className="text-[10px] text-[var(--red)] border border-[var(--rule)] rounded px-2 py-0.5 hover:bg-[rgba(251,113,133,0.08)]"
          >
            בטל הפקה
          </button>
        )}
        {canEditStages && onReviewAsk && (p.status === "נשלח_ללקוח" || p.status === "ממתין_לתגובת_לקוח") && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReviewAsk(p);
            }}
            className="text-[10px] text-[var(--violet-light)] border border-[var(--rule)] rounded px-2 py-0.5 hover:bg-[rgba(139,92,246,0.1)]"
          >
            לינק אישור
          </button>
        )}
      </div>
    </div>
  );
}

function TodayView({
  rows,
  onOpen,
  onHold,
  onFreezeAsk,
  onCancelAsk,
  onReviewAsk,
  canEditStages,
  onSplitAsk,
  onUndoSplit,
  onDupAction,
  onUnmerge,
}: {
  rows: BoardProduction[];
  onOpen: (id: string) => void;
  onHold: (id: string, on: boolean) => void;
  onFreezeAsk: (p: BoardProduction) => void;
  onCancelAsk: (p: BoardProduction) => void;
  onReviewAsk: (p: BoardProduction) => void;
  canEditStages: boolean;
  onSplitAsk: (p: BoardProduction) => void;
  onUndoSplit: (id: string) => void;
  onDupAction: (id: string, action: "confirm" | "merge") => void;
  onUnmerge: (id: string) => void;
}) {
  const today = todayISO();
  const attention = rows.filter((p) => p.needs_attention);
  // "עתיד להתחיל" — only work that hasn't started yet. The moment any stage
  // goes in_progress/done the production moves to "בעבודה עכשיו", so it must
  // leave this bucket or it double-shows (owner 2026-07-24).
  const notStarted = (p: BoardProduction) => p.stages_done === 0 && p.in_progress.length === 0;
  const upcoming = rows.filter(
    (p) => p.record_date === today && !TERMINAL_STATES.has(p.status) && notStarted(p)
  );
  const working = rows.filter((p) => IN_PROGRESS_STATES.has(p.status) && !p.on_hold);
  const stuck = rows.filter((p) => p.on_hold || p.status === "ממתין_לתגובת_לקוח");

  const Section = ({ title, items, tone }: { title: string; items: BoardProduction[]; tone?: string }) => (
    <section className="mb-6">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-bold" style={{ color: tone }}>{title}</h2>
        <span className="text-xs text-[var(--faint)] font-mono">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="text-xs text-[var(--faint)] border border-dashed border-[var(--rule)] rounded-2xl px-3 py-5 text-center">
          אין פריטים
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {items.map((p) => (
            <ProductionCard
              key={p.id}
              p={p}
              onOpen={onOpen}
              onFreezeAsk={onFreezeAsk}
              onUnfreeze={(id) => onHold(id, false)}
              onCancelAsk={onCancelAsk}
              onReviewAsk={onReviewAsk}
              showStatus
              canEditStages={canEditStages}
              onSplitAsk={onSplitAsk}
              onUndoSplit={onUndoSplit}
              onDupAction={onDupAction}
              onUnmerge={onUnmerge}
            />
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div>
      <div className="text-xs text-[var(--faint)] mb-4 font-mono">{today}</div>
      {attention.length > 0 && <Section title="דורש טיפול" items={attention} tone="var(--red)" />}
      <Section title="עתיד להתחיל" items={upcoming} tone="var(--violet-light)" />
      <Section title="בעבודה עכשיו" items={working} />
      <Section title="תקוע" items={stuck} tone="var(--amber)" />
    </div>
  );
}

const COLUMN_CAP = 60;

function Kanban({
  rows,
  canEditStages,
  dragId,
  dragOver,
  setDragId,
  setDragOver,
  onDropTo,
  onOpen,
  onFreezeAsk,
  onUnfreeze,
  onCancelAsk,
  onReviewAsk,
  onSplitAsk,
  onUndoSplit,
  onDupAction,
  onUnmerge,
}: {
  rows: BoardProduction[];
  canEditStages: boolean;
  dragId: string | null;
  dragOver: string | null;
  setDragId: (id: string | null) => void;
  setDragOver: (s: string | null) => void;
  onDropTo: (id: string, status: string) => void;
  onOpen: (id: string) => void;
  onFreezeAsk: (p: BoardProduction) => void;
  onUnfreeze: (id: string) => void;
  onCancelAsk: (p: BoardProduction) => void;
  onReviewAsk: (p: BoardProduction) => void;
  onSplitAsk: (p: BoardProduction) => void;
  onUndoSplit: (id: string) => void;
  onDupAction: (id: string, action: "confirm" | "merge") => void;
  onUnmerge: (id: string) => void;
}) {
  const byStatus = useMemo(() => {
    const m = new Map<string, BoardProduction[]>();
    for (const s of STATUS_ORDER) m.set(s, []);
    for (const p of rows) (m.get(p.status) ?? m.set(p.status, []).get(p.status)!).push(p);
    return m;
  }, [rows]);

  return (
    <>
      {/* desktop / tablet: the horizontal kanban with drag between columns */}
      <div className="hidden sm:block overflow-x-auto pb-4">
      <div className="flex gap-3 min-w-max">
        {STATUS_ORDER.map((status) => {
          const items = byStatus.get(status) ?? [];
          const isOver = dragOver === status;
          return (
            <div
              key={status}
              onDragOver={(e) => {
                if (!canEditStages) return;
                e.preventDefault();
                setDragOver(status);
              }}
              onDragLeave={() => dragOver === status && setDragOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                if (dragId) onDropTo(dragId, status);
                setDragId(null);
              }}
              className={`w-64 shrink-0 rounded-2xl border p-2 transition-colors ${
                isOver ? "border-[var(--violet)]" : "border-[var(--rule)]"
              }`}
              style={{
                background: isOver ? "rgba(139,92,246,0.08)" : "rgba(255,255,255,0.02)",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
              }}
            >
              <div className="flex items-center justify-between px-1.5 py-1.5 mb-1">
                <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">{STATUS_LABEL[status]}</span>
                <span className="text-[11px] text-[var(--faint)] font-mono">{items.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {items.slice(0, COLUMN_CAP).map((p) => (
                  <ProductionCard
                    key={p.id}
                    p={p}
                    onOpen={onOpen}
                    onFreezeAsk={onFreezeAsk}
                    onUnfreeze={onUnfreeze}
                    onCancelAsk={onCancelAsk}
                    onReviewAsk={onReviewAsk}
                    draggable={canEditStages}
                    onDragStart={() => setDragId(p.id)}
                    onDragEnd={() => setDragId(null)}
                    canEditStages={canEditStages}
                    onSplitAsk={onSplitAsk}
                    onUndoSplit={onUndoSplit}
                    onDupAction={onDupAction}
                    onUnmerge={onUnmerge}
                  />
                ))}
                {items.length > COLUMN_CAP && (
                  <div className="text-[11px] text-[var(--faint)] text-center py-2">
                    ועוד {items.length - COLUMN_CAP} — צמצם עם חיפוש/מסנן
                  </div>
                )}
                {items.length === 0 && <div className="text-[11px] text-[var(--faint)] text-center py-3">—</div>}
              </div>
            </div>
          );
        })}
      </div>
      </div>

      {/* mobile: a single-column list grouped by status. Native drag doesn't
          fire on touch, so cards don't drag here — tapping a card opens the
          drawer, which carries the one-tap "advance stage" control instead
          (owner 2026-07-22). Desktop keeps the drag board above. */}
      <div className="sm:hidden space-y-4 pb-4">
        {STATUS_ORDER.map((status) => {
          const items = byStatus.get(status) ?? [];
          if (items.length === 0) return null;
          return (
            <section key={status}>
              <div className="flex items-center gap-2 mb-1.5 px-0.5">
                <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">{STATUS_LABEL[status]}</span>
                <span className="text-[11px] text-[var(--faint)] font-mono">{items.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {items.slice(0, COLUMN_CAP).map((p) => (
                  <ProductionCard
                    key={p.id}
                    p={p}
                    onOpen={onOpen}
                    onFreezeAsk={onFreezeAsk}
                    onUnfreeze={onUnfreeze}
                    onCancelAsk={onCancelAsk}
                    onReviewAsk={onReviewAsk}
                    draggable={false}
                    canEditStages={canEditStages}
                    onSplitAsk={onSplitAsk}
                    onUndoSplit={onUndoSplit}
                    onDupAction={onDupAction}
                    onUnmerge={onUnmerge}
                  />
                ))}
                {items.length > COLUMN_CAP && (
                  <div className="text-[11px] text-[var(--faint)] text-center py-2">
                    ועוד {items.length - COLUMN_CAP} — צמצם עם חיפוש/מסנן
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

function ReviewLinkModal({ production, onClose }: { production: BoardProduction; onClose: () => void }) {
  const [reelsIncluded, setReelsIncluded] = useState(true);
  const [episodeLink, setEpisodeLink] = useState("");
  const [reelsLink, setReelsLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; share: { whatsapp: string; mailto: string } } | null>(null);
  const [copied, setCopied] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/productions/${production.id}/review-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reels_included: reelsIncluded, episode_link: episodeLink, reels_link: reelsLink }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "יצירת הלינק נכשלה");
        return;
      }
      setResult({ url: body.url, share: body.share });
    } catch {
      setError("שגיאת רשת");
    } finally {
      setBusy(false);
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
        className="w-full max-w-sm border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl"
        style={{ background: "rgba(15,13,28,0.95)", backdropFilter: "blur(24px)" }}
      >
        <h3 className="font-bold mb-1">לינק אישור ללקוח</h3>
        <p className="text-xs text-[var(--dim)] mb-4">{production.show_name}</p>

        {!result ? (
          <>
            <label className="flex items-center gap-2 text-xs mb-3">
              <input type="checkbox" checked={reelsIncluded} onChange={(e) => setReelsIncluded(e.target.checked)} />
              כולל רילז
            </label>
            <input
              value={episodeLink}
              onChange={(e) => setEpisodeLink(e.target.value)}
              placeholder="קישור לפרק (אופציונלי)"
              className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded-xl px-3 py-2 text-sm mb-2"
              dir="ltr"
            />
            {reelsIncluded && (
              <input
                value={reelsLink}
                onChange={(e) => setReelsLink(e.target.value)}
                placeholder="קישור לרילז (אופציונלי)"
                className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded-xl px-3 py-2 text-sm mb-2"
                dir="ltr"
              />
            )}
            {error && <div className="text-[11px] text-[var(--peak)] mb-2">{error}</div>}
            <div className="flex gap-2 mt-2">
              <button
                onClick={create}
                disabled={busy}
                className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
                style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
              >
                {busy ? "יוצר…" : "צור לינק"}
              </button>
              <button onClick={onClose} className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)]">
                סגור
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-[11px] font-mono bg-[var(--panel)] border border-[var(--rule)] rounded-xl px-3 py-2 mb-3 break-all" dir="ltr">
              {result.url}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(result.url);
                  setCopied(true);
                }}
                className="text-xs border border-[var(--rule)] rounded-xl px-3 py-1.5"
              >
                {copied ? "הועתק ✓" : "העתק"}
              </button>
              <a href={result.share.whatsapp} target="_blank" rel="noopener noreferrer" className="text-xs border border-[var(--rule)] rounded-xl px-3 py-1.5">
                וואטסאפ
              </a>
              <a href={result.share.mailto} className="text-xs border border-[var(--rule)] rounded-xl px-3 py-1.5">
                מייל
              </a>
              <button onClick={onClose} className="text-xs border border-[var(--rule)] rounded-xl px-3 py-1.5 text-[var(--dim)] mr-auto">
                סגור
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CancelModal({
  production,
  onClose,
  onCancel,
}: {
  production: BoardProduction;
  onClose: () => void;
  onCancel: (
    id: string,
    reason: string,
    confirm: boolean
  ) => Promise<{ ok?: boolean; needsConfirmation?: boolean; issuedDocs?: { type: string; number: string | null }[]; error?: string }>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // set when the server reports an already-issued document — the second gate
  const [issuedDocs, setIssuedDocs] = useState<{ type: string; number: string | null }[] | null>(null);

  async function submit(confirm: boolean) {
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    const res = await onCancel(production.id, reason.trim(), confirm);
    setBusy(false);
    if (res.needsConfirmation) {
      setIssuedDocs(res.issuedDocs ?? []);
      return;
    }
    if (res.error) {
      setError(res.error);
      return;
    }
    onClose();
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
        <h3 className="font-bold mb-1">ביטול הקלטה</h3>
        <p className="text-xs text-[var(--dim)] mb-3">
          {production.show_name}
          {production.record_date ? ` · ${production.record_date}` : ""}
        </p>

        {issuedDocs && issuedDocs.length > 0 && (
          <div className="mb-3 text-[11px] border border-[var(--amber)] text-[var(--amber)] rounded-xl px-3 py-2">
            {issuedDocs.map((d, i) => (
              <div key={i}>
                {d.type} {d.number ?? ""} כבר הונפקה במורנינג.
              </div>
            ))}
            הביטול יסמן אותה לסגירה ידנית במורנינג (לא נמחק שם דבר).
          </div>
        )}

        <textarea
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="סיבת הביטול (חובה — למשל: הלקוח ביטל בבוקר)"
          rows={2}
          className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded-xl px-3 py-2 text-sm mb-3"
        />
        {error && <div className="mb-3 text-[11px] text-[var(--peak)]">{error}</div>}

        <div className="flex gap-2">
          <button
            onClick={() => submit(!!issuedDocs)}
            disabled={!reason.trim() || busy}
            className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
            style={{ background: "linear-gradient(135deg, var(--red), #b23a4d)", boxShadow: "0 4px 14px rgba(251,113,133,0.3)" }}
          >
            {issuedDocs ? "אשר וסמן לסגירה ידנית" : "בטל הקלטה"}
          </button>
          <button onClick={onClose} className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)]">
            חזור
          </button>
        </div>
      </div>
    </div>
  );
}

function HoldModal({
  production,
  onClose,
  onConfirm,
}: {
  production: BoardProduction;
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
        <h3 className="font-bold mb-1">הקפאת הפקה</h3>
        <p className="text-xs text-[var(--dim)] mb-1">{production.show_name}</p>
        <p className="text-[11px] text-[var(--faint)] mb-4">
          ההפקה תישאר בדיוק במצב שלה ({STATUS_LABEL[production.status]}) ותחזור לשם בשחרור.
        </p>
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && reason.trim() && onConfirm(reason)}
          placeholder="סיבה (למשל: ממתין לחומרים)"
          className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded-xl px-3 py-2 text-sm mb-4"
        />
        <div className="flex gap-2">
          <button
            onClick={() => onConfirm(reason)}
            disabled={!reason.trim()}
            className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
            style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 14px rgba(139,92,246,0.3)" }}
          >
            הקפא
          </button>
          <button onClick={onClose} className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)]">
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}

function SplitModal({
  production,
  onClose,
  onConfirm,
}: {
  production: BoardProduction;
  onClose: () => void;
  onConfirm: (count: number) => void;
}) {
  const [custom, setCustom] = useState("");
  const customCount = Number(custom);
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
        <h3 className="font-bold mb-1">פיצול הפקה</h3>
        <p className="text-xs text-[var(--dim)] mb-4">{production.show_name} — כמה פרקים בפועל?</p>
        <div className="flex gap-2 mb-3">
          {[2, 3, 4].map((n) => (
            <button
              key={n}
              onClick={() => onConfirm(n)}
              className="flex-1 border border-[var(--rule)] rounded-xl py-2 text-sm font-bold hover:bg-[var(--panel3)]"
            >
              {n}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value.replace(/\D/g, ""))}
            placeholder="מספר אחר"
            className="flex-1 bg-[var(--panel)] border border-[var(--rule)] rounded-xl px-3 py-2 text-sm"
          />
          <button
            onClick={() => onConfirm(customCount)}
            disabled={!custom || customCount < 2}
            className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
            style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 14px rgba(139,92,246,0.3)" }}
          >
            אישור
          </button>
        </div>
        <button onClick={onClose} className="mt-3 text-xs text-[var(--dim)] border border-[var(--rule)] rounded-xl px-3 py-1.5">
          ביטול
        </button>
      </div>
    </div>
  );
}

// Manual production creation (owner request 2026-07-21). A show pick drives
// all client/price/studio inheritance server-side (see /api/productions);
// this form only collects what a human knows on the spot. Everything but
// the show and date is optional.
function NewProductionModal({
  shows,
  defaultDate,
  onClose,
  onCreate,
}: {
  shows: { id: string; name: string }[];
  defaultDate: string;
  onClose: () => void;
  onCreate: (input: {
    show_id: string;
    record_date: string;
    record_time: string;
    studio: string;
    guest: string;
    notes: string;
  }) => Promise<{ error?: string }>;
}) {
  const [showId, setShowId] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState("");
  const [studio, setStudio] = useState("");
  const [guest, setGuest] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSubmit = !!showId && !!date && !busy;
  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    const res = await onCreate({ show_id: showId, record_date: date, record_time: time, studio, guest, notes });
    setBusy(false);
    if (res.error) setErr(res.error);
    else onClose();
  }

  const fieldClass =
    "w-full bg-[var(--panel)] border border-[var(--rule)] rounded-xl px-3 py-2 text-sm";

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
        <h3 className="font-bold mb-1">הפקה חדשה</h3>
        <p className="text-[11px] text-[var(--faint)] mb-4">
          התוכנית קובעת לקוח, מחיר ואולפן ברירת מחדל. נכנסת לשרשרת המלאה כמו כל הפקה.
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-[var(--dim)] mb-1">תוכנית</label>
            <select
              autoFocus
              value={showId}
              onChange={(e) => setShowId(e.target.value)}
              className={fieldClass}
            >
              <option value="">— בחר תוכנית —</option>
              {shows.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-xs text-[var(--dim)] mb-1">תאריך</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={fieldClass} />
            </div>
            <div className="w-28">
              <label className="block text-xs text-[var(--dim)] mb-1">שעה</label>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={fieldClass} />
            </div>
          </div>

          <div>
            <label className="block text-xs text-[var(--dim)] mb-1">אולפן</label>
            <input
              value={studio}
              onChange={(e) => setStudio(e.target.value)}
              placeholder="ריק = אולפן ברירת המחדל של התוכנית"
              className={fieldClass}
            />
          </div>

          <div>
            <label className="block text-xs text-[var(--dim)] mb-1">אורח (אופציונלי)</label>
            <input value={guest} onChange={(e) => setGuest(e.target.value)} className={fieldClass} />
          </div>

          <div>
            <label className="block text-xs text-[var(--dim)] mb-1">הערות (אופציונלי)</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={fieldClass} />
          </div>
        </div>

        {err && <div className="mt-3 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2">{err}</div>}

        <div className="flex gap-2 mt-4">
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
            style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 14px rgba(139,92,246,0.3)" }}
          >
            {busy ? "יוצר…" : "צור הפקה"}
          </button>
          <button onClick={onClose} className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)]">
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}
