"use client";

import { CREATE_JOB_COPY, jobAmountError } from "@/lib/productions/createJob";

/**
 * "יצירת עבודה לחיוב" — the button and the window, as PURE components.
 *
 * ═══ WHY PURE, AND WHY NOT INLINE IN EntityDrawer ═══
 * Same argument RecordPastBody makes, and the same lesson behind it: an HTTP
 * suite that greps the /productions HTML proves the SERVER rendered, and says
 * nothing about whether this window can mount. EntityDrawer is 2,800 lines
 * behind a provider, a fetch and a click — nothing about it is reachable from
 * renderToString. These two components are, so the three facts the owner
 * actually asked to be guaranteed can be COUNTED:
 *
 *   · the button appears exactly once when the production has no job
 *   · it appears zero times when it has one
 *   · it appears zero times without can_edit_money
 *
 * Every prop below also arrives from a server fetch, which means every one of
 * them can be undefined under a version skew — the class of break that took
 * the projects screen down on 2026-09-15 while tsc was satisfied. The render
 * test hands them nulls deliberately.
 *
 * ═══ THE DATE FORMAT ═══
 * d.m.yyyy (owner's approved copy), built locally rather than imported.
 * `displayDate` prints dd/MM/yyyy and `shortDate` is FROZEN document text
 * (dates.ts:209) — this is screen text with its own agreed shape, which is the
 * same call parentRef.ts:482-488 made and for the same reason. No `new Date()`
 * touches it: `record_date` is a date column with no time and no zone, and
 * giving it one invents an instant (dates.ts:120-128).
 */
function dmY(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? "").trim());
  if (!m) return null;
  return `${Number(m[3])}.${Number(m[2])}.${m[1]}`;
}

const NIS = new Intl.NumberFormat("he-IL");

/**
 * The button, with its own visibility rule.
 *
 * The rule lives HERE and not at the call site on purpose: that is the thing
 * being tested, and a predicate spelled in the drawer's JSX would be tested by
 * nothing. `hasJob` is passed as the fact rather than as a list, so the caller
 * cannot accidentally make "no links loaded yet" look like "no job".
 */
export function CreateJobButton({
  hasJob,
  canEditMoney,
  onOpen,
}: {
  hasJob: boolean;
  canEditMoney: boolean;
  onOpen: () => void;
}) {
  if (hasJob || !canEditMoney) return null;
  return (
    <button
      data-action="create-job"
      onClick={onOpen}
      className="mt-1.5 text-[11px] rounded-lg px-2.5 py-1.5 border border-[var(--rule2)] text-[var(--signal)] hover:bg-[var(--panel3)] transition-colors"
    >
      {CREATE_JOB_COPY.button}
    </button>
  );
}

export function CreateJobModalBody({
  showName,
  recordDate,
  guest,
  suggested,
  value,
  busy,
  error,
  done,
  onChange,
  onSubmit,
  onCancel,
}: {
  showName: string | null | undefined;
  recordDate: string | null | undefined;
  guest: string | null | undefined;
  /** null/undefined = nothing to offer; the field stays empty and says why */
  suggested: number | null | undefined;
  value: string;
  busy: boolean;
  error: string | null;
  done: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const d = dmY(recordDate);
  const who = (guest ?? "").trim();
  // "{תוכנית} · {d.m.yyyy} · {אורח, אם יש}" — each part dropped when absent, so
  // a production with no date and no guest reads as a name and a sentence
  // rather than as a row of lonely separators.
  const head = [(showName ?? "").trim() || "—", d, who].filter(Boolean).join(" · ");
  const hasSuggestion = suggested != null && Number.isFinite(Number(suggested));
  // The same function the server will run. The button is disabled on exactly
  // what the route would refuse, so the round trip is not how the owner learns
  // they typed a letter.
  const fieldError = jobAmountError(value);

  // Once the job exists there is nothing left to fill in, and leaving a live
  // "יצירה" button under a success line is how a second job gets made. The
  // route's 409 would refuse it — but a button that exists only to be refused
  // is not a button.
  if (done) {
    return (
      <>
        <h3 className="font-bold mb-2">{CREATE_JOB_COPY.title}</h3>
        <div className="text-xs text-[var(--green)] border border-[var(--green)] rounded-xl px-3 py-2 mb-4">
          {CREATE_JOB_COPY.done}
        </div>
        <button
          onClick={onCancel}
          className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)]"
        >
          {CREATE_JOB_COPY.close}
        </button>
      </>
    );
  }

  return (
    <>
      <h3 className="font-bold mb-2">{CREATE_JOB_COPY.title}</h3>

      <p className="text-[11px] text-[var(--dim)] mb-3 leading-relaxed">
        {head}. {CREATE_JOB_COPY.why}
      </p>

      {error ? (
        <div className="mb-3 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2">
          {error}
        </div>
      ) : null}

      <label className="block text-xs font-bold mb-1" htmlFor="create-job-amount">
        {CREATE_JOB_COPY.amountLabel}
      </label>
      <input
        id="create-job-amount"
        inputMode="decimal"
        value={value}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !fieldError && !busy) onSubmit();
        }}
        className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded-xl px-3 py-2 text-sm mb-1 disabled:opacity-40"
      />
      <div className="text-[10px] text-[var(--faint)] mb-3">
        {hasSuggestion
          ? `${CREATE_JOB_COPY.suggested} · ${NIS.format(Number(suggested))} ₪`
          : CREATE_JOB_COPY.noSuggestion}
      </div>

      <div className="text-[10px] text-[var(--dim)] border border-[var(--rule)] rounded-xl px-2.5 py-2 mb-4 leading-relaxed">
        {CREATE_JOB_COPY.note}
      </div>

      <div className="flex gap-2">
        <button
          onClick={onSubmit}
          disabled={busy || !!fieldError}
          className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
          style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
        >
          {busy ? "…" : CREATE_JOB_COPY.submit}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)] disabled:opacity-40"
        >
          {CREATE_JOB_COPY.cancel}
        </button>
      </div>
    </>
  );
}
