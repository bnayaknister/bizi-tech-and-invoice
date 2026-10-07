"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import CreateMorningClientModal from "@/components/CreateMorningClientModal";
import {
  MappingChangeConfirm,
  SharedMappingModal,
  useMorningMapping,
} from "@/components/MorningMapping";
import {
  MAPPING_ASSIGN,
  MAPPING_CREATE,
  MAPPING_LABEL,
  MAPPING_NO_RESULTS,
  MAPPING_REPLACE,
  MAPPING_SEARCH,
  mappingFailure,
} from "@/lib/clients/morningMapping";
import { NOT_MAPPED } from "@/lib/clients/overview";

/**
 * The client card's Morning MAPPING block (owner 7.10: "the mapping should be
 * reachable from the client's card too, not only from /settings/morning-
 * clients").
 *
 * ═══ WHAT IS NEW HERE AND WHAT IS NOT ═══
 * New: this layout, and the confirmation window the owner approved for
 * changing a card.
 * Not new, and deliberately so:
 *   · the POST and the 409 shared-mapping handshake  → useMorningMapping,
 *     lifted out of MorningClientsClient's `save()`;
 *   · the shared-mapping warning dialog              → SharedMappingModal,
 *     the same markup that screen renders;
 *   · creating a client in Morning                   → CreateMorningClientModal,
 *     used UNCHANGED. It already had a "map-existing" mode (pass `clientId`
 *     and it creates/adopts a Morning card for THAT client of ours), which is
 *     exactly this case — nothing had to be added to it;
 *   · the read                                       → GET /api/clients/[id]/
 *     morning, which already returned one client's mapping plus the searchable
 *     Morning list. It was written for the show card, left without a caller
 *     when that card became read-only, and fits this screen exactly.
 * So: no new route, no second copy of the handshake, no second create modal.
 *
 * ═══ WHY IT FETCHES ITSELF ═══
 * The Morning client list comes from Morning, with a 15s deadline. Loading it
 * with the page would mean Morning being slow = no client card. Same shape as
 * ClientMorningCard beside it: the DB fields render at once, this arrives.
 *
 * ⚠️ UNMAPPING IS NOT OFFERED HERE. /settings/morning-clients has "בטל מיפוי"
 * and keeps it; the owner asked this card for assign and replace. Leaving a
 * client with no card is the state that silently stops it billing, and it is
 * not something to offer beside an edit form.
 */

type MorningOption = { id: string; name: string; taxId: string | null };
type MappingData = {
  client: { id: string; name: string };
  current: { id: string; name: string | null } | null;
  morning_clients: MorningOption[];
};

export default function MorningMappingCard({
  clientId,
  clientName,
  mapped,
  canEdit,
  onChanged,
}: {
  clientId: string;
  clientName: string;
  /** what the server already knows, so a read-only viewer needs no Morning call */
  mapped: boolean;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [data, setData] = useState<MappingData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState("");
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const { assign, busyId, pendingShared, setPendingShared } = useMorningMapping();

  const load = useCallback(async () => {
    const res = await fetch(`/api/clients/${clientId}/morning`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setLoadError(body?.error ?? "שליפת לקוחות ממורנינג נכשלה");
      return;
    }
    setLoadError(null);
    setData(body as MappingData);
  }, [clientId]);

  // 🔴 Only a money EDITOR reads. The route is can_edit_money-gated and would
  // answer 403, but the real reason is upstream of that: a viewer who cannot
  // change the mapping has no use for a live list of Morning cards, and
  // fetching it would spend a 15s Morning deadline to render nothing they can
  // act on. They get the fact, from data the page already had.
  useEffect(() => {
    if (canEdit) void load();
  }, [canEdit, load]);

  const options = useMemo(() => {
    const all = data?.morning_clients ?? [];
    const needle = q.trim();
    if (!needle) return all.slice(0, 40);
    return all
      .filter((m) => m.name.includes(needle) || (m.taxId ?? "").includes(needle))
      .slice(0, 40);
  }, [data, q]);

  const currentName = data?.current?.name ?? null;
  const busy = busyId === clientId;

  async function commit(confirmShared = false) {
    if (!confirm) return;
    setError(null);
    const out = await assign(clientId, confirm.id, confirm.name, confirmShared);
    if (!out.ok) {
      // a 409 is NOT a failure: the shared dialog takes over and retries. Only
      // a real refusal gets the approved sentence.
      if (!out.needsShared) setError(mappingFailure(out.error));
      return;
    }
    setConfirm(null);
    setPicking(false);
    setQ("");
    await load();
    onChanged();
  }

  // ── a viewer who may not edit: the fact, and nothing to press ──
  if (!canEdit) {
    return (
      <div className="rounded-lg border border-[var(--rule)] px-2.5 py-2">
        <div className="text-[11px] font-bold text-[var(--dim)] mb-1">{MAPPING_LABEL}</div>
        <div className="text-[10px] text-[var(--faint)]">{mapped ? "ממופה למורנינג" : NOT_MAPPED}</div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--rule)] px-2.5 py-2 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold text-[var(--dim)]">{MAPPING_LABEL}</div>
        <div className="text-[9px] text-[var(--faint)]">מתוך מורנינג</div>
      </div>

      {loadError ? (
        <div className="text-[10px] text-amber-400">
          {loadError}
          <button onClick={() => void load()} className="ms-2 underline text-[var(--signal)]">
            נסי שוב
          </button>
        </div>
      ) : (
        <MappingStatus
          currentName={currentName}
          canEdit
          disabled={busy || !data}
          onToggle={() => setPicking((v) => !v)}
        />
      )}

      {picking && data && (
        <div className="space-y-1">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={MAPPING_SEARCH}
            className="w-full bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1 text-[11px]"
          />
          <div className="max-h-48 overflow-y-auto space-y-0.5">
            {options.length === 0 && <div className="text-[10px] text-[var(--faint)]">{MAPPING_NO_RESULTS}</div>}
            {options.map((m) => (
              <button
                key={m.id}
                onClick={() => setConfirm({ id: m.id, name: m.name })}
                disabled={busy || m.id === data.current?.id}
                className="block w-full text-right rounded px-2 py-1 text-[11px] hover:bg-[var(--panel3)] disabled:opacity-40"
              >
                {m.name}
                {m.taxId ? <span className="text-[var(--faint)]"> · {m.taxId}</span> : null}
              </button>
            ))}
          </div>
          <button
            onClick={() => setCreateOpen(true)}
            className="text-[10px] underline text-[var(--signal)]"
          >
            {MAPPING_CREATE}
          </button>
        </div>
      )}

      {error && <div className="text-[10px] text-red-400">{error}</div>}

      {/* 🔴 the approved window. `fromName` is null on a first mapping, which
          is what drops the "instead of" clause. */}
      {confirm && (
        <MappingChangeConfirm
          toName={confirm.name}
          fromName={currentName}
          busy={busy}
          onConfirm={() => void commit()}
          onCancel={() => setConfirm(null)}
        />
      )}

      {/* the same dialog /settings/morning-clients shows, from the same file */}
      {pendingShared && (
        <SharedMappingModal
          pending={pendingShared}
          busy={busy}
          onConfirm={() => void commit(true)}
          onCancel={() => {
            setPendingShared(null);
            setConfirm(null);
          }}
        />
      )}

      {createOpen && (
        <CreateMorningClientModal
          clientId={clientId}
          defaultName={clientName}
          onClose={() => setCreateOpen(false)}
          onResolved={() => {
            setCreateOpen(false);
            setPicking(false);
            void load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/**
 * The one line that says where this client bills, and the one control that
 * changes it.
 *
 * Its own pure component so the suite can COUNT the four states — mapped or
 * not, editable or not — without a Morning call. That matters most for the
 * permission case: "a viewer without can_edit_money is offered nothing" is
 * proved by ZERO occurrences of the two action labels, and a state buried
 * behind a fetch can only be asserted by reading the source.
 *
 * `currentName === null` means "no Morning card", and it renders the same
 * approved string the list rows use — one constant, so the card and the list
 * cannot word it differently.
 */
export function MappingStatus({
  currentName,
  canEdit,
  disabled = false,
  onToggle,
}: {
  currentName: string | null;
  canEdit: boolean;
  disabled?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {currentName ? (
        <span className="text-[11px] flex-1 min-w-0 truncate text-emerald-400">{currentName}</span>
      ) : (
        <span className="text-[11px] flex-1 min-w-0 text-amber-400">{NOT_MAPPED}</span>
      )}
      {canEdit && (
        <button
          onClick={onToggle}
          disabled={disabled}
          className="shrink-0 text-[10px] underline text-[var(--signal)] disabled:opacity-40"
        >
          {currentName ? MAPPING_REPLACE : MAPPING_ASSIGN}
        </button>
      )}
    </div>
  );
}
