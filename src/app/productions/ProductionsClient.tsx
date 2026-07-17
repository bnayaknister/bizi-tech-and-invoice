"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useDrawer } from "@/components/EntityDrawer";

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
};

// the 9-state machine, in flow order (screens-spec §1)
const STATUS_ORDER = [
  "עתיד_להתחיל",
  "בהקלטה",
  "הוקלט",
  "בעריכה",
  "נערך",
  "נשלח_ללקוח",
  "ממתין_לתגובת_לקוח",
  'אושר_ע"י_לקוח',
  "הופץ",
] as const;

const STATUS_LABEL: Record<string, string> = {
  עתיד_להתחיל: "עתיד להתחיל",
  בהקלטה: "בהקלטה",
  הוקלט: "הוקלט",
  בעריכה: "בעריכה",
  נערך: "נערך",
  נשלח_ללקוח: "נשלח ללקוח",
  ממתין_לתגובת_לקוח: "ממתין לתגובת לקוח",
  'אושר_ע"י_לקוח': 'אושר ע"י לקוח',
  הופץ: "הופץ",
};

// mid-pipeline = actively being worked (for the Today "in progress" bucket)
const IN_PROGRESS_STATES = new Set([
  "בהקלטה",
  "הוקלט",
  "בעריכה",
  "נערך",
  "נשלח_ללקוח",
]);
const TERMINAL_STATES = new Set(['אושר_ע"י_לקוח', "הופץ"]);

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
}: {
  board: BoardProduction[];
  isTech: boolean;
  canEditStages: boolean;
}) {
  const { openEntity } = useDrawer();
  const router = useRouter();
  const [rows, setRows] = useState(board);
  const [tab, setTab] = useState<"today" | "kanban">("today");
  const [onlyMine, setOnlyMine] = useState(isTech); // default on for technicians
  const [activeOnly, setActiveOnly] = useState(true); // scope the kanban to live shows
  const [query, setQuery] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [holdFor, setHoldFor] = useState<BoardProduction | null>(null);
  const [splitFor, setSplitFor] = useState<BoardProduction | null>(null);
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

  const moveStatus = (id: string, status: string) =>
    act(id, { status }, (p) => ({ ...p, status }));

  const setHold = (id: string, on: boolean, reason?: string) =>
    act(id, { hold: { on, reason } }, (p) => ({
      ...p,
      on_hold: on,
      on_hold_reason: on ? reason ?? null : null,
      on_hold_since: on ? new Date().toISOString() : null,
    }));

  const filtered = useMemo(() => rows.filter(matches), [rows, matches]);

  return (
    <div className="max-w-[1400px] mx-auto p-6">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <h1 className="text-lg font-bold">הפקות</h1>
        <div className="flex rounded-lg border border-[var(--rule)] overflow-hidden">
          {(
            [
              ["today", "היום"],
              ["kanban", "קנבן"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`text-xs px-4 py-1.5 ${
                tab === key ? "bg-[var(--violet)] text-white font-bold" : "text-[var(--dim)] hover:bg-[var(--panel3)]"
              }`}
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

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="חיפוש תוכנית, אורח, אולפן…"
          className="mr-auto w-60 max-w-full bg-[var(--panel2)] border border-[var(--rule)] rounded-lg px-3 py-1.5 text-sm"
        />

        {canEditStages && (
          <button
            onClick={syncNow}
            disabled={syncing}
            className="text-xs border border-[var(--rule)] rounded-lg px-3 py-1.5 text-[var(--dim)] hover:bg-[var(--panel3)] disabled:opacity-50"
          >
            {syncing ? "מסנכרן…" : "סנכרן יומן עכשיו"}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-3 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-lg px-3 py-2">{error}</div>
      )}
      {syncResult && (
        <div className="mb-3 text-xs text-[var(--dim)] border border-[var(--rule)] rounded-lg px-3 py-2 font-mono">{syncResult}</div>
      )}

      {tab === "today" ? (
        <TodayView
          rows={filtered}
          onOpen={(id) => openEntity({ type: "production", id })}
          onHold={setHold}
          onFreezeAsk={setHoldFor}
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
      className={`lift group text-right w-full rounded-lg border bg-[var(--panel2)] p-3 cursor-pointer ${
        p.on_hold ? "opacity-60 border-[var(--rule)]" : "border-[var(--rule)]"
      }`}
      style={{ borderInlineStartWidth: 3, borderInlineStartColor: p.show_color ?? "var(--rule2)" }}
    >
      <div className="flex items-center gap-1.5 mb-1">
        {p.needs_attention && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: "var(--red)" }} title="דורש טיפול" />}
        <span className="font-bold text-sm truncate flex-1">{p.show_name}</span>
        {p.on_hold && <span className="text-[10px] text-[var(--amber)] shrink-0">⏸ מוקפא</span>}
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
      </div>
    </div>
  );
}

function TodayView({
  rows,
  onOpen,
  onHold,
  onFreezeAsk,
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
  canEditStages: boolean;
  onSplitAsk: (p: BoardProduction) => void;
  onUndoSplit: (id: string) => void;
  onDupAction: (id: string, action: "confirm" | "merge") => void;
  onUnmerge: (id: string) => void;
}) {
  const today = todayISO();
  const attention = rows.filter((p) => p.needs_attention);
  const todays = rows.filter((p) => p.record_date === today && !TERMINAL_STATES.has(p.status));
  const working = rows.filter((p) => IN_PROGRESS_STATES.has(p.status) && !p.on_hold);
  const stuck = rows.filter((p) => p.on_hold || p.status === "ממתין_לתגובת_לקוח");

  const Section = ({ title, items, tone }: { title: string; items: BoardProduction[]; tone?: string }) => (
    <section className="mb-6">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-bold" style={{ color: tone }}>{title}</h2>
        <span className="text-xs text-[var(--faint)] font-mono">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="text-xs text-[var(--faint)] border border-dashed border-[var(--rule)] rounded-lg px-3 py-4 text-center">
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
      <Section title="היום" items={todays} tone="var(--violet-light)" />
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
    <div className="overflow-x-auto pb-4">
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
              className={`w-64 shrink-0 rounded-lg border p-2 transition-colors ${
                isOver ? "border-[var(--violet)] bg-[var(--panel3)]" : "border-[var(--rule)] bg-[var(--panel2)]/40"
              }`}
            >
              <div className="flex items-center justify-between px-1 py-1.5 mb-1">
                <span className="text-xs font-bold">{STATUS_LABEL[status]}</span>
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
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm border border-[var(--rule2)] rounded-xl bg-[var(--panel2)] p-5">
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
          className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded-lg px-3 py-2 text-sm mb-4"
        />
        <div className="flex gap-2">
          <button
            onClick={() => onConfirm(reason)}
            disabled={!reason.trim()}
            className="bg-[var(--violet)] text-white font-bold rounded-lg px-4 py-2 text-sm disabled:opacity-40"
          >
            הקפא
          </button>
          <button onClick={onClose} className="border border-[var(--rule)] rounded-lg px-4 py-2 text-sm text-[var(--dim)]">
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
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm border border-[var(--rule2)] rounded-xl bg-[var(--panel2)] p-5">
        <h3 className="font-bold mb-1">פיצול הפקה</h3>
        <p className="text-xs text-[var(--dim)] mb-4">{production.show_name} — כמה פרקים בפועל?</p>
        <div className="flex gap-2 mb-3">
          {[2, 3, 4].map((n) => (
            <button
              key={n}
              onClick={() => onConfirm(n)}
              className="flex-1 border border-[var(--rule)] rounded-lg py-2 text-sm font-bold hover:bg-[var(--panel3)]"
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
            className="flex-1 bg-[var(--panel)] border border-[var(--rule)] rounded-lg px-3 py-2 text-sm"
          />
          <button
            onClick={() => onConfirm(customCount)}
            disabled={!custom || customCount < 2}
            className="bg-[var(--violet)] text-white font-bold rounded-lg px-4 py-2 text-sm disabled:opacity-40"
          >
            אישור
          </button>
        </div>
        <button onClick={onClose} className="mt-3 text-xs text-[var(--dim)] border border-[var(--rule)] rounded-lg px-3 py-1.5">
          ביטול
        </button>
      </div>
    </div>
  );
}
