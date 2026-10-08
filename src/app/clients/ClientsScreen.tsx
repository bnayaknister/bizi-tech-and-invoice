"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import EntityFieldRows from "@/components/EntityFieldRows";
import ClientMorningCard from "@/components/ClientMorningCard";
import ClientBookingContactsCard from "@/components/ClientBookingContactsCard";
import MorningMappingCard from "@/components/MorningMappingCard";
import {
  EMPTY_LIST,
  NOT_MAPPED,
  NO_DEBT,
  filterClients,
  sortClients,
  type ClientListRow,
  type ListScope,
  type ListSort,
} from "@/lib/clients/overview";
import type { ClientsScreenData } from "./data";

/**
 * /clients — the owner's 7.10 screen. A list on the right, the open client's
 * card beside it.
 *
 * ═══ NOTHING HERE IS A SECOND COPY OF ANYTHING ═══
 * · The six billing fields are <EntityFieldRows>, the component the drawer
 *   renders. Same labels, same permission flags, same controls — the owner's
 *   rule was "אותו רכיב בדיוק … לא שכפול שדות".
 * · Morning's facts (ח.פ, emails, phone, contact person, the read-only `send`)
 *   are <ClientMorningCard>, also the drawer's.
 * · The save goes to POST /api/entity/client/[id] — the drawer's route, with
 *   the drawer's permission walls and the drawer's Morning confirmation.
 * · The debt number comes from the server, which computes it with
 *   `isUnpaidDebt` — the /finance and radar function.
 * So this file is a LAYOUT plus the search/sort/filter the owner asked for, and
 * the editing behaviour it offers is not its own.
 *
 * ═══ SELECTION IS A LINK, NOT STATE ═══
 * A row is an <a href="/clients/{id}">, so the card is addressable, the back
 * button works, and the list works with JavaScript off. The card is rendered by
 * the SERVER for the id in the path; this component never fetches it.
 *
 * 🔴 `contact_name` appears nowhere, and that is deliberate: it still holds
 * three values that contradict Morning (entities.ts:159-176). A wide screen is
 * where someone would be tempted to "use the space".
 */

const SORTS: { key: ListSort; label: string }[] = [
  { key: "name", label: "שם" },
  { key: "debt", label: "חוב" },
  { key: "activity", label: "פעילות אחרונה" },
];

const SCOPES: { key: ListScope; label: string }[] = [
  { key: "active", label: "פעילים" },
  { key: "all", label: "הכול" },
  // merged rows are their own view and never mixed into "הכול" — a retired row
  // must not be billed or mapped (0051), and counting them as ordinary clients
  // is what made the mapping screen look like it had eight jobs waiting
  { key: "merged", label: "מוזגו" },
];

const nis = (n: number) => `₪${n.toLocaleString("he-IL")}`;

export default function ClientsScreen({ data }: { data: ClientsScreenData }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<ListSort>("name");
  const [scope, setScope] = useState<ListScope>("active");

  const shown = useMemo(
    () => sortClients(filterClients(data.rows, scope, q), sort),
    [data.rows, scope, q, sort]
  );

  return (
    <main className="max-w-6xl mx-auto p-6">
      <h1 className="text-sm font-bold text-[var(--dim)] mb-4">לקוחות</h1>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.1fr] gap-4 items-start">
        <section className="rounded-2xl border border-[var(--rule)] p-3">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="חיפוש לקוח"
              className="flex-1 min-w-[10rem] bg-transparent border border-[var(--rule)] rounded-xl px-3 py-1.5 text-sm"
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as ListSort)}
              aria-label="מיון"
              className="bg-[var(--panel)] border border-[var(--rule)] rounded-xl px-2 py-1.5 text-xs"
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1.5 mb-2">
            {SCOPES.map((s) => (
              <button
                key={s.key}
                onClick={() => setScope(s.key)}
                className={`text-[11px] rounded-full px-2.5 py-1 border transition-colors ${
                  scope === s.key
                    ? "border-[var(--violet-light)] text-[var(--ink)]"
                    : "border-[var(--rule)] text-[var(--dim)] hover:text-[var(--ink)]"
                }`}
                style={scope === s.key ? { background: "rgba(139,92,246,0.16)" } : undefined}
              >
                {s.label}
              </button>
            ))}
            <span className="flex-1" />
            <span className="text-[11px] text-[var(--faint)] font-mono">{shown.length}</span>
          </div>

          {shown.length === 0 ? (
            <div className="py-12 text-center text-sm text-[var(--faint)]">{EMPTY_LIST}</div>
          ) : (
            <div className="space-y-1">
              {shown.map((r) => (
                <ClientRowItem key={r.id} row={r} selected={data.card?.id === r.id} />
              ))}
            </div>
          )}
        </section>

        {data.card ? (
          <ClientCardPanel data={data} />
        ) : (
          <section className="rounded-2xl border border-dashed border-[var(--rule)] p-6 text-center text-xs text-[var(--faint)]">
            בחרי לקוח מהרשימה.
          </section>
        )}
      </div>
    </main>
  );
}

function ClientRowItem({ row, selected }: { row: ClientListRow; selected: boolean }) {
  return (
    <Link
      href={`/clients/${row.id}`}
      aria-current={selected ? "page" : undefined}
      className={`block rounded-xl px-3 py-2 border transition-colors ${
        selected
          ? "border-[var(--violet-light)]"
          : "border-transparent hover:border-[var(--rule)] hover:bg-[var(--panel3)]"
      }`}
      style={selected ? { background: "rgba(139,92,246,0.14)" } : undefined}
    >
      <div className="flex items-center gap-2">
        <span className="font-bold text-sm flex-1 min-w-0 truncate">{row.name}</span>
        {row.debt > 0 ? (
          <span className="text-xs font-mono text-[var(--red)]">{nis(row.debt)}</span>
        ) : (
          <span className="text-[10px] text-[var(--faint)]">{NO_DEBT}</span>
        )}
      </div>
      <div className="flex items-center gap-2 mt-0.5">
        <span className="text-[11px] text-[var(--faint)] flex-1 min-w-0 truncate">
          {row.activeShows.length > 0 ? row.activeShows.join(" · ") : "אין תוכנית פעילה"}
        </span>
        {row.overdueCount > 0 && (
          <span className="text-[10px] text-amber-400 shrink-0">
            {row.overdueCount} בפיגור · {row.worstOverdueDays} ימים
          </span>
        )}
        {/* ✓/✗ on the Morning mapping — an unmapped client cannot be billed at
            all, so it belongs on the row and not only inside the card */}
        <span
          className={`text-[10px] shrink-0 ${row.mapped ? "text-emerald-400" : "text-amber-400"}`}
          title={row.mapped ? "ממופה למורנינג" : NOT_MAPPED}
        >
          {row.mapped ? "✓" : "✗"}
        </span>
      </div>
    </Link>
  );
}

function ClientCardPanel({ data }: { data: ClientsScreenData }) {
  const card = data.card!;
  const router = useRouter();
  const [entity, setEntity] = useState<Record<string, unknown>>(card.entity);
  const [error, setError] = useState<string | null>(null);
  const [morningConfirm, setMorningConfirm] = useState<{
    key: string;
    value: unknown;
    prev: unknown;
    changes: Record<string, { from: unknown; to: unknown }>;
  } | null>(null);
  const dirty = useRef<Record<string, unknown>>({});

  /**
   * The drawer's save, field for field: optimistic paint, revert on failure,
   * and the 409 `needs_morning_confirmation` handshake for a mapped client's
   * NAME. Not a simplified version — a name edit here reaches Morning exactly
   * as it does from the drawer, and skipping the handshake would mean this
   * screen could rename a client in our DB and not in the books.
   */
  async function post(patch: Record<string, unknown>, confirmMorning = false) {
    const res = await fetch(`/api/entity/client/${card.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch, ...(confirmMorning ? { confirm_morning: true } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: body as Record<string, unknown> };
  }

  async function saveField(key: string, value: unknown) {
    if (entity[key] === value) return;
    const prev = entity[key];
    setError(null);
    setEntity((e) => ({ ...e, [key]: value }));
    const res = await post({ [key]: value });
    if (res.status === 409 && res.body?.needs_morning_confirmation) {
      setEntity((e) => ({ ...e, [key]: prev }));
      setMorningConfirm({
        key,
        value,
        prev,
        changes: res.body.changes as Record<string, { from: unknown; to: unknown }>,
      });
      return;
    }
    if (!res.ok) {
      setEntity((e) => ({ ...e, [key]: prev }));
      setError(String(res.body?.error ?? "השמירה נכשלה"));
      return;
    }
    router.refresh();
  }

  async function confirmMorningNow() {
    if (!morningConfirm) return;
    const { key, value, prev } = morningConfirm;
    setMorningConfirm(null);
    setEntity((e) => ({ ...e, [key]: value }));
    const res = await post({ [key]: value }, true);
    if (!res.ok) {
      setEntity((e) => ({ ...e, [key]: prev }));
      setError(String(res.body?.error ?? "השמירה נכשלה"));
      return;
    }
    router.refresh();
  }

  const row = data.rows.find((r) => r.id === card.id);

  return (
    <section className="rounded-2xl border border-[var(--rule)] p-4 space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="font-bold text-base flex-1 min-w-0 truncate">{card.name}</h2>
        {row && !row.mapped && <span className="text-[10px] text-amber-400">{NOT_MAPPED}</span>}
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      {/* ── סקירה ── the drawer's own rows, plus the drawer's own Morning card */}
      <div className="space-y-3">
        <SectionTitle>סקירה</SectionTitle>
        <EntityFieldRows
          fields={card.fields}
          entity={entity}
          optionsData={{ clients: [], shows: [] }}
          onSave={(k, v) => void saveField(k, v)}
          dirtyRef={dirty}
          labelWidth={130}
        />
        {/* the Morning CARD this client bills on — beside the ח.פ and the
            contacts, because all three are Morning's facts about the same
            client and the owner asked for them in one place (7.10) */}
        <MorningMappingCard
          clientId={card.id}
          clientName={card.name}
          mapped={!!row?.mapped}
          canEdit={data.canEditMoney}
          onChanged={() => router.refresh()}
        />
        <ClientMorningCard
          clientId={card.id}
          clientName={card.name}
          onChanged={() => router.refresh()}
        />
        {/* the same component the drawer renders — see its own header */}
        <ClientBookingContactsCard clientId={card.id} />
      </div>

      {/* ── תוכניות וחוזים ── */}
      <div className="space-y-2">
        <SectionTitle>תוכניות וחוזים</SectionTitle>
        {card.shows.length === 0 && <Empty>אין תוכניות</Empty>}
        {card.shows.map((s) => (
          <div key={s.id} className="flex items-center gap-2 text-xs">
            <span className="flex-1 min-w-0 truncate">{s.name}</span>
            <span className={s.active ? "text-emerald-400 text-[10px]" : "text-[var(--faint)] text-[10px]"}>
              {s.active ? "פעילה" : "לא פעילה"}
            </span>
          </div>
        ))}
        {card.contracts.length === 0 ? (
          <Empty>אין חוזים</Empty>
        ) : (
          card.contracts.map((c) => (
            <div key={c.id} className="flex items-center gap-2 text-xs">
              <span className="flex-1 min-w-0 truncate">{c.name ?? "—"}</span>
              {c.total_amount != null && <span className="font-mono">{nis(Number(c.total_amount))}</span>}
              <span className="text-[10px] text-[var(--faint)]">{c.status ?? "—"}</span>
            </div>
          ))
        )}
      </div>

      {/* ── כספים ── */}
      <div className="space-y-2">
        <SectionTitle>כספים</SectionTitle>
        <div className="flex items-baseline gap-2">
          {card.debt > 0 ? (
            <>
              <span className="text-2xl font-mono text-[var(--red)]">{nis(card.debt)}</span>
              <span className="text-[10px] text-[var(--faint)]">חוב לגבייה</span>
            </>
          ) : (
            <span className="text-sm text-[var(--faint)]">{NO_DEBT}</span>
          )}
        </div>
        {card.debtJobs.map((j) => (
          <div key={j.id} className="flex items-center gap-2 text-xs">
            <span className="flex-1 min-w-0 truncate">{j.campaign ?? "—"}</span>
            {j.overdueDays != null && (
              <span className="text-[10px] text-amber-400 shrink-0">בפיגור {j.overdueDays} ימים</span>
            )}
            <span className="font-mono shrink-0">{nis(Number(j.amount ?? 0))}</span>
          </div>
        ))}
        <div className="pt-1 border-t border-[var(--rule)]">
          <div className="text-[10px] text-[var(--faint)] mb-1">מסמכים אחרונים</div>
          {card.documents.length === 0 && <Empty>אין מסמכים</Empty>}
          {card.documents.map((d) => (
            <div key={d.id} className="flex items-center gap-2 text-xs">
              <span className="text-[10px] text-[var(--faint)] shrink-0 font-mono">
                {d.document_date ?? "—"}
              </span>
              <span className="flex-1 min-w-0 truncate">
                {d.type ?? "—"} {d.morning_doc_number ? `· ${d.morning_doc_number}` : ""}
              </span>
              {d.cancelled_at && <span className="text-[10px] text-[var(--faint)]">מבוטל</span>}
              {d.amount != null && <span className="font-mono shrink-0">{nis(Number(d.amount))}</span>}
            </div>
          ))}
        </div>
      </div>

      {/* ── פעילות ── */}
      <div className="space-y-2">
        <SectionTitle>פעילות</SectionTitle>
        {card.productions.length === 0 && <Empty>אין הפקות</Empty>}
        {card.productions.map((p) => (
          <div key={p.id} className="flex items-center gap-2 text-xs">
            <span className="text-[10px] text-[var(--faint)] shrink-0 font-mono">{p.record_date ?? "—"}</span>
            <span className="flex-1 min-w-0 truncate">{p.podcast_name ?? "—"}</span>
            <span className="text-[10px] text-[var(--faint)] shrink-0">{p.status ?? "—"}</span>
          </div>
        ))}
      </div>

      {morningConfirm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          style={{ background: "rgba(3,2,10,0.7)", backdropFilter: "blur(6px)" }}
        >
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
            <div className="flex gap-2">
              <button
                onClick={() => void confirmMorningNow()}
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
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-bold text-[var(--dim)]">{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] text-[var(--faint)]">{children}</div>;
}
