"use client";

// EntityDrawer — the one edit surface for every entity in the system.
// Clicking an entity anywhere (table row, kanban card, search result,
// radar alert, calendar event) opens it here instead of navigating away.
//
// Security model: this component renders ONLY what /api/entity returns.
// Fields the viewer may not see are never in the response; fields they may
// not edit arrive with editable=false; and even a forged request dies at
// RLS / the 0010 column-guard triggers. The drawer holds no permission
// logic of its own beyond what the server hands it.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import ClientCombobox from "@/components/ClientCombobox";
import IconTile, { type IconAccent } from "@/components/IconTile";

// entity type -> line icon + tile accent (no emoji, DESIGN.md §12)
const ENTITY_ICON: Record<string, string> = {
  production: "productions",
  job: "finance",
  show: "shows",
  client: "users",
  contract: "contracts",
};
const ENTITY_ACCENT: Record<string, IconAccent> = {
  production: "violet",
  job: "rose",
  show: "cyan",
  client: "violet",
  contract: "violet-light",
};

type EntityRef = { type: string; id: string };

type FieldMeta = {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "date" | "select" | "readonly";
  editable: boolean;
  options: { value: string; label: string }[] | "clients" | "shows" | null;
};

type Stage = {
  id: string;
  track: "episode" | "reels";
  step: "record" | "edit" | "deliver";
  status: "pending" | "in_progress" | "done";
  assignee_id: string | null;
  done_at: string | null;
};

type HistoryEntry = {
  id: string;
  event_type: string;
  actor: string;
  payload: Record<string, unknown> | null;
  created_at: string;
};

type DrawerData = {
  type: string;
  icon: string;
  label: string;
  title: string;
  entity: Record<string, unknown>;
  fields: FieldMeta[];
  optionsData: { clients: { id: string; name: string }[]; shows: { id: string; name: string }[] };
  stages: Stage[] | null;
  linked: Record<string, unknown>[] | null;
  milestones: Record<string, unknown>[] | null;
  history: HistoryEntry[] | null;
};

const DrawerContext = createContext<{ openEntity: (ref: EntityRef) => void }>({
  openEntity: () => {},
});

export function useDrawer() {
  return useContext(DrawerContext);
}

const NIS = new Intl.NumberFormat("he-IL");
const STEP_LABEL: Record<string, string> = { record: "הקלטה", edit: "עריכה", deliver: "מסירה" };
const TRACK_LABEL: Record<string, string> = { episode: "פרק", reels: "רילז" };
const STATUS_LABEL: Record<string, string> = { pending: "ממתין", in_progress: "בעבודה", done: "בוצע" };
const STATUS_NEXT: Record<string, string> = { pending: "in_progress", in_progress: "done", done: "pending" };

export function DrawerProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ref, setRef] = useState<EntityRef | null>(null);
  const [data, setData] = useState<DrawerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // a client-name edit that Morning must be told about, awaiting confirmation
  const [morningConfirm, setMorningConfirm] = useState<
    { key: string; value: unknown; prev: unknown; changes: Record<string, { from: unknown; to: unknown }> } | null
  >(null);
  // dirty text/number edits awaiting blur/Cmd+Enter
  const dirty = useRef<Record<string, unknown>>({});

  const openEntity = useCallback((next: EntityRef) => {
    dirty.current = {};
    setError(null);
    setRef(next);
  }, []);

  const close = useCallback(() => {
    setRef(null);
    setData(null);
    setError(null);
    dirty.current = {};
  }, []);

  const load = useCallback(async (r: EntityRef, quiet = false) => {
    if (!quiet) setLoading(true);
    const res = await fetch(`/api/entity/${r.type}/${r.id}`);
    setLoading(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "שגיאה בטעינה");
      setData(null);
      return;
    }
    setData(await res.json());
  }, []);

  useEffect(() => {
    if (ref) void load(ref);
  }, [ref, load]);

  function broadcast() {
    if (ref) window.dispatchEvent(new CustomEvent("bizi:entity-updated", { detail: ref }));
    router.refresh();
  }

  async function post(
    body: Record<string, unknown>
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    if (!ref) return { ok: false, status: 0, body: {} };
    setError(null);
    const res = await fetch(`/api/entity/${ref.type}/${ref.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const resBody = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) setError(resBody.error ?? "שגיאה בשמירה");
    return { ok: res.ok, status: res.status, body: resBody };
  }

  async function saveField(key: string, value: unknown, undoOf?: string) {
    if (!ref || !data) return;
    const prev = data.entity[key];
    if (prev === value) return;
    // optimistic: paint first, revert on failure
    setData((d) => (d ? { ...d, entity: { ...d.entity, [key]: value } } : d));
    const res = await post({ patch: { [key]: value }, ...(undoOf ? { undoOf } : {}) });
    // a mapped client's name change needs an explicit "also update Morning?"
    // — revert the optimistic paint and hold it for the confirmation modal
    if (res.status === 409 && res.body?.needs_morning_confirmation) {
      setData((d) => (d ? { ...d, entity: { ...d.entity, [key]: prev } } : d));
      setMorningConfirm({ key, value, prev, changes: res.body.changes as Record<string, { from: unknown; to: unknown }> });
      return;
    }
    if (!res.ok) {
      setData((d) => (d ? { ...d, entity: { ...d.entity, [key]: prev } } : d));
      return;
    }
    broadcast();
    void load(ref, true); // refresh history + derived fields
  }

  async function confirmMorning() {
    if (!ref || !morningConfirm) return;
    const { key, value, prev } = morningConfirm;
    setData((d) => (d ? { ...d, entity: { ...d.entity, [key]: value } } : d));
    const res = await post({ patch: { [key]: value }, confirm_morning: true });
    setMorningConfirm(null);
    if (!res.ok) {
      setData((d) => (d ? { ...d, entity: { ...d.entity, [key]: prev } } : d));
      return;
    }
    broadcast();
    void load(ref, true);
  }

  async function saveStage(stage: Stage, patch: Record<string, unknown>) {
    if (!ref) return;
    const ok = await post({ stage: { id: stage.id, patch } });
    if (ok) {
      broadcast();
      void load(ref, true);
    }
  }

  function flushDirty() {
    for (const [k, v] of Object.entries(dirty.current)) void saveField(k, v);
    dirty.current = {};
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!ref) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        flushDirty();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, data]);

  function optionsFor(f: FieldMeta): { value: string; label: string }[] {
    if (f.options === "clients")
      return (data?.optionsData.clients ?? []).map((c) => ({ value: c.id, label: c.name }));
    if (f.options === "shows")
      return (data?.optionsData.shows ?? []).map((s) => ({ value: s.id, label: s.name }));
    return f.options ?? [];
  }

  function renderValue(f: FieldMeta) {
    const v = data?.entity[f.key];
    if (f.type === "readonly")
      return <span className="text-sm">{v == null || v === "" ? "—" : String(v)}</span>;
    if (!f.editable) {
      if (f.type === "select") {
        const opt = optionsFor(f).find((o) => o.value === v);
        return <span className="text-sm">{opt?.label ?? (v == null ? "—" : String(v))}</span>;
      }
      if (f.type === "boolean") return <span className="text-sm">{v ? "כן" : "לא"}</span>;
      return <span className="text-sm">{v == null || v === "" ? "—" : String(v)}</span>;
    }
    switch (f.type) {
      case "boolean":
        return (
          <input
            type="checkbox"
            checked={Boolean(v)}
            onChange={(e) => void saveField(f.key, e.target.checked)}
          />
        );
      case "select":
        if (f.options === "clients") {
          return (
            <ClientCombobox
              clients={data?.optionsData.clients ?? []}
              value={(v as string) ?? null}
              onChange={(clientId) => void saveField(f.key, clientId)}
              onCreated={(c) =>
                setData((d) =>
                  d ? { ...d, optionsData: { ...d.optionsData, clients: [...d.optionsData.clients, c] } } : d
                )
              }
            />
          );
        }
        return (
          <select
            value={(v as string) ?? ""}
            onChange={(e) => void saveField(f.key, e.target.value || null)}
            className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1 text-sm"
          >
            <option value="">—</option>
            {optionsFor(f).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );
      case "date":
        return (
          <input
            type="date"
            value={(v as string) ?? ""}
            onChange={(e) => void saveField(f.key, e.target.value || null)}
            className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1 text-sm"
          />
        );
      default: {
        const isNumber = f.type === "number";
        const display = Array.isArray(v) ? (v as string[]).join(", ") : v == null ? "" : String(v);
        return (
          <input
            type={isNumber ? "number" : "text"}
            defaultValue={display}
            key={`${f.key}:${display}`}
            onChange={(e) => {
              const raw = e.target.value;
              dirty.current[f.key] = Array.isArray(v)
                ? raw.split(",").map((x) => x.trim()).filter(Boolean)
                : isNumber
                  ? raw === "" ? null : Number(raw)
                  : raw === "" ? null : raw;
            }}
            onBlur={() => {
              if (f.key in dirty.current) {
                const val = dirty.current[f.key];
                delete dirty.current[f.key];
                void saveField(f.key, val);
              }
            }}
            className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1 text-sm"
          />
        );
      }
    }
  }

  function renderChanges(h: HistoryEntry) {
    const changes = (h.payload?.changes ?? null) as Record<string, { from: unknown; to: unknown }> | null;
    if (!changes) return <span className="text-[11px] text-[var(--faint)]">{h.event_type}</span>;
    return (
      <div className="space-y-0.5">
        {Object.entries(changes).map(([k, c]) => {
          const field = data?.fields.find((f) => f.key === k);
          return (
            <div key={k} className="flex items-center gap-1.5 text-[11px]">
              <b>{field?.label ?? k}</b>
              <span className="text-[var(--faint)]">{String(c.from ?? "—")}</span>
              <span>←</span>
              <span>{String(c.to ?? "—")}</span>
              {field?.editable && (
                <button
                  onClick={() => void saveField(k, c.from, h.id)}
                  className="text-[10px] border border-[var(--rule)] rounded px-1 hover:bg-[var(--panel3)]"
                >
                  בטל
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <DrawerContext.Provider value={{ openEntity }}>
      {children}

      {morningConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ background: "rgba(3,2,10,0.7)", backdropFilter: "blur(6px)" }}>
          <div
            className="w-full max-w-sm border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl"
            style={{ background: "rgba(15,13,28,0.95)", backdropFilter: "blur(24px)" }}
          >
            <h3 className="font-bold mb-2">השינוי יעודכן גם במורנינג</h3>
            <div className="text-sm mb-3 space-y-1">
              {Object.entries(morningConfirm.changes).map(([k, ch]) => (
                <div key={k}>
                  <span className="text-[var(--faint)]">{k}: </span>
                  <span className="line-through text-[var(--faint)]">{String(ch.from ?? "—")}</span>
                  <span className="mx-1">→</span>
                  <span className="font-bold">{String(ch.to ?? "—")}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-[var(--faint)] mb-4">
              הצלחה → מעודכן בשני המקומות. כישלון → לא מעודכן באף אחד.
            </p>
            <div className="flex gap-2">
              <button
                onClick={confirmMorning}
                className="flex-1 text-white font-bold rounded-xl px-4 py-2 text-sm"
                style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
              >
                אשר ועדכן
              </button>
              <button
                onClick={() => setMorningConfirm(null)}
                className="flex-1 border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)]"
              >
                בטל
              </button>
            </div>
          </div>
        </div>
      )}

      {ref && (
        <>
          <div className="fixed inset-0 z-40" style={{ background: "rgba(3,2,10,0.5)", backdropFilter: "blur(4px)" }} onClick={close} />
          <aside
            className="fixed inset-y-0 left-0 z-50 w-full max-w-md border-e border-[var(--rule2)] shadow-2xl overflow-y-auto"
            style={{ background: "rgba(15,13,28,0.92)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
          >
            <div
              className="sticky top-0 border-b border-[var(--rule)] px-4 py-3 flex items-center gap-2 z-10"
              style={{ background: "rgba(15,13,28,0.85)", backdropFilter: "blur(16px)" }}
            >
              <IconTile icon={ENTITY_ICON[data?.type ?? ""] ?? "search"} accent={ENTITY_ACCENT[data?.type ?? ""] ?? "violet"} size={28} iconSize={15} />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-[var(--faint)]">{data?.label ?? ""}</div>
                <div className="text-sm font-bold truncate">{loading ? "טוען…" : data?.title ?? ""}</div>
              </div>
              <span className="text-[10px] text-[var(--faint)]">Esc סגירה · ⌘⏎ שמירה</span>
              <button onClick={close} className="text-[var(--dim)] hover:text-[var(--fg)] px-1">✕</button>
            </div>

            {error && (
              <div className="m-3 text-xs text-red-400 border border-red-500/40 rounded px-3 py-2">{error}</div>
            )}

            {data && (
              <div className="p-4 space-y-4">
                <div className="space-y-2.5">
                  {data.fields.map((f) => (
                    <div key={f.key} className="grid grid-cols-[110px_1fr] items-center gap-2">
                      <label className="text-xs text-[var(--dim)]">{f.label}</label>
                      {renderValue(f)}
                    </div>
                  ))}
                </div>

                {data.stages && (
                  <div>
                    <div className="text-xs font-bold text-[var(--dim)] mb-1.5">שלבים</div>
                    <div className="space-y-1">
                      {data.stages.map((s) => (
                        <div key={s.id} className="flex items-center gap-2 text-xs">
                          <span className="w-24">{TRACK_LABEL[s.track]} · {STEP_LABEL[s.step]}</span>
                          <button
                            onClick={() => void saveStage(s, { status: STATUS_NEXT[s.status] })}
                            className={`border rounded px-2 py-0.5 ${
                              s.status === "done"
                                ? "border-emerald-500/50 text-emerald-400"
                                : s.status === "in_progress"
                                  ? "border-amber-500/50 text-amber-400"
                                  : "border-[var(--rule)] text-[var(--dim)]"
                            }`}
                            title="לחיצה מקדמת סטטוס"
                          >
                            {STATUS_LABEL[s.status]}
                          </button>
                          {s.done_at && (
                            <span className="text-[10px] text-[var(--faint)]">{s.done_at.slice(0, 10)}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {data.linked && (
                  <div>
                    <div className="text-xs font-bold text-[var(--dim)] mb-1.5">
                      {data.type === "job" ? "הפקות מקושרות" : "חיובים מקושרים"}
                    </div>
                    {data.linked.length === 0 && (
                      <div className="text-xs text-[var(--faint)]">
                        אין קישורים.{" "}
                        <a href="/finance/link" className="underline">מסך הקישור ←</a>
                      </div>
                    )}
                    <div className="space-y-1">
                      {data.linked.map((l) => (
                        <button
                          key={l.id as string}
                          onClick={() =>
                            openEntity({ type: data.type === "job" ? "production" : "job", id: l.id as string })
                          }
                          className="block w-full text-right text-xs border border-[var(--rule)] rounded px-2 py-1.5 hover:bg-[var(--panel3)]"
                        >
                          {data.type === "job"
                            ? `🎬 ${(l.record_date as string) ?? "—"} · ${l.podcast_name}${l.guest ? ` · ${l.guest}` : ""}`
                            : `💰 ${(l.date as string) ?? "—"} · ${l.campaign ?? "—"} · ${
                                l.amount != null ? `${NIS.format(l.amount as number)} ₪` : "—"
                              }`}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {data.milestones && data.milestones.length > 0 && (
                  <div>
                    <div className="text-xs font-bold text-[var(--dim)] mb-1.5">אבני דרך</div>
                    <div className="space-y-1">
                      {data.milestones.map((m) => (
                        <div key={m.id as string} className="text-xs flex gap-2">
                          <span>{m.name as string}</span>
                          <span className="text-[var(--dim)]">
                            {m.amount != null ? `${NIS.format(m.amount as number)} ₪` : "—"}
                          </span>
                          <span className="text-[var(--faint)]">{(m.expected_date as string) ?? ""}</span>
                          <span className="text-[var(--faint)]">{m.status as string}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {data.history && (
                  <div className="border-t border-[var(--rule)] pt-3">
                    <div className="text-xs font-bold text-[var(--dim)] mb-1.5">היסטוריית שינויים</div>
                    {data.history.length === 0 && (
                      <div className="text-xs text-[var(--faint)]">אין אירועים.</div>
                    )}
                    <div className="space-y-2">
                      {data.history.map((h) => (
                        <div key={h.id} className="text-[11px]">
                          <div className="flex gap-2 text-[var(--faint)]">
                            <span>{new Date(h.created_at).toLocaleString("he-IL")}</span>
                            <span>{h.actor}</span>
                            <span>{h.event_type}</span>
                          </div>
                          {renderChanges(h)}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </aside>
        </>
      )}
    </DrawerContext.Provider>
  );
}
