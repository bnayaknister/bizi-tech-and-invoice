"use client";

import { displayDate } from "@/lib/dates";

/**
 * The panel content of "רישום מסמכים שכבר יצאו" — PURE. No hooks, no fetch, no
 * router: every piece of state arrives as a prop and every action leaves as a
 * callback. Its container (RecordBilledModal in ContractsClient.tsx) owns all of
 * that and the overlay around it.
 *
 * ═══ WHY IT IS A SEPARATE, PURE COMPONENT ═══
 * This project's render check is `renderToString` under tsx (see
 * scripts/test_projects_render.tsx) — there is no jsdom and no testing-library,
 * so effects never run and a stateful modal can only ever be rendered in its
 * loading state. Four states have to be exercised here and each one is a place
 * the screen can crash on a payload it did not expect: the empty list, a picked
 * chain, the amount warning, and a partial link. Making them props is what makes
 * them testable; scripts/test_record_billed_render.tsx renders all four.
 *
 * The habit this follows is the one 2026-09-15 paid for: `MILESTONE_META[state]`
 * returned undefined for a state the bundle did not know and `.color` took the
 * page down, while tsc was satisfied because the TYPE promised a MilestoneState.
 * Every value below that came from the server is therefore rendered defensively
 * — the arrays default, the labels fall back, and nothing is indexed into a map
 * without one.
 */

export type BilledCandidate = {
  id: string;
  number: string | null;
  type: number;
  type_label: string;
  amount: number | null;
  net: number | null;
  date: string | null;
  chain_id: string;
  parents: string[];
};
export type BilledMismatch = { gross_max: number; net: number; milestone_amount: number };
export type BilledResult = { linked: string[]; failed: { number: string; error: string }[]; total: number };

const NIS = new Intl.NumberFormat("he-IL");
const money = (n: number | null | undefined) => (n == null ? "—" : `${NIS.format(Math.round(n))} ₪`);

/**
 * The tax documents that were selected by riding along with a chain rather than
 * being clicked. Exported because the chain sentence is the one piece of copy
 * here that is computed rather than fixed, and the test asserts it.
 */
export function chainExtraNumbers(cands: BilledCandidate[], picked: ReadonlySet<string>): string[] {
  const byChain = new Map<string, BilledCandidate[]>();
  for (const c of cands ?? []) {
    if (!picked?.has(c.id)) continue;
    byChain.set(c.chain_id, [...(byChain.get(c.chain_id) ?? []), c]);
  }
  return Array.from(byChain.values())
    .filter((g) => g.length > 1)
    .flatMap((g) => g.filter((c) => c.type === 305 || c.type === 320))
    .map((c) => c.number)
    .filter((n): n is string => !!n);
}

/**
 * One failure line. The server phrases the "taken meanwhile" refusal as a whole
 * sentence that already names its document (it is approved copy, rendered
 * verbatim); every other refusal is a bare reason and gets the wrapper. Testing
 * for the document's own number rather than a prefix keeps that true even if
 * either sentence is reworded.
 */
export function failureLine(f: { number: string; error: string }): string {
  const reason = f?.error ?? "";
  const num = f?.number ?? "";
  return num && reason.includes(num) ? reason : `המסמך ${num || "—"} לא שויך: ${reason}`;
}

export default function RecordBilledBody({
  milestoneName,
  milestoneAmount,
  clientName,
  loading,
  candidates,
  picked,
  busy,
  error,
  mismatch,
  ack,
  result,
  onToggle,
  onAck,
  onSubmit,
  onClose,
}: {
  milestoneName: string;
  milestoneAmount: number;
  clientName: string | null;
  loading: boolean;
  candidates: BilledCandidate[];
  picked: ReadonlySet<string>;
  busy: boolean;
  error: string | null;
  mismatch: BilledMismatch | null;
  ack: boolean;
  result: BilledResult | null;
  onToggle: (c: BilledCandidate) => void;
  onAck: (v: boolean) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  // every array from the server is defaulted before it is walked
  const cands = candidates ?? [];
  const sel: ReadonlySet<string> = picked ?? new Set<string>();
  const chainExtra = chainExtraNumbers(cands, sel);
  const failed = result?.failed ?? [];

  return (
    <>
      <h3 className="font-bold mb-1">רישום מסמכים שכבר יצאו</h3>
      <p className="text-[11px] text-[var(--dim)] mb-1 leading-relaxed">
        המסמכים יצאו ממורנינג מחוץ למערכת. הפעולה משייכת אותם לאבן הדרך ואינה מנפיקה מסמך חדש.
      </p>
      <p className="text-[11px] text-[var(--dim)] mb-4 leading-relaxed">
        העבודה תיכנס לחוב לגבייה מתאריך המסמך, עד שתירשם קבלה.
      </p>

      <div className="flex items-baseline gap-2 mb-3 text-xs border border-[var(--rule)] rounded-xl px-3 py-2">
        <span className="font-medium">{milestoneName ?? "—"}</span>
        <span className="text-[var(--dim)]">{clientName ?? "—"}</span>
        <div className="flex-1" />
        <span className="font-mono">{money(milestoneAmount)}</span>
      </div>

      {error && (
        <div className="mb-3 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2">{error}</div>
      )}

      {result && (
        <div className="mb-3 text-xs border border-[var(--peak)] rounded-xl px-3 py-2 leading-relaxed">
          <div>
            שויכו {(result.linked ?? []).length} מתוך {result.total ?? 0} מסמכים.
          </div>
          {failed.map((f, i) => (
            <div key={`${f?.number ?? "x"}-${i}`} className="text-[var(--peak)] mt-1">
              {failureLine(f)}
            </div>
          ))}
          <div className="mt-1 text-[var(--dim)]">אפשר ללחוץ שוב — מה ששויך כבר יידלג.</div>
        </div>
      )}

      {loading && <div className="text-xs text-[var(--faint)] mb-2">טוען מסמכים…</div>}

      {!loading && cands.length === 0 && (
        <div className="text-xs text-[var(--faint)] mb-2 leading-relaxed">
          אין ללקוח מסמכים פנויים לשיוך. מסמך שכבר משויך לעבודה אחרת לא יופיע כאן.
        </div>
      )}

      <div className="space-y-1.5">
        {cands.map((c) => {
          const on = sel.has(c.id);
          return (
            <button
              key={c.id}
              onClick={() => onToggle(c)}
              disabled={busy}
              className={`w-full text-right border rounded-xl px-3 py-2 transition-colors disabled:opacity-40 ${
                on ? "border-[var(--signal)] bg-[var(--panel3)]" : "border-[var(--rule)] hover:bg-[var(--panel3)]"
              }`}
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                <span className="font-mono" style={on ? { color: "var(--signal)" } : undefined}>
                  {on ? "✓" : "○"}
                </span>
                <span className="font-mono font-medium">{c.number ?? "—"}</span>
                {/* the server sends the label already resolved, with its own
                    fallback — this never indexes a map by a server value */}
                <span className="text-[var(--dim)]">{c.type_label ?? `סוג ${c.type}`}</span>
                <div className="flex-1" />
                <span className="font-mono">{money(c.amount)}</span>
                <span className="text-[var(--faint)] font-mono">{c.date ? displayDate(c.date) : "—"}</span>
              </div>
            </button>
          );
        })}
      </div>

      {chainExtra.length > 0 && (
        <div className="mt-3 text-[11px] text-[var(--dim)] leading-relaxed">
          נבחרה גם חשבונית המס {chainExtra.join(", ")} שיצאה על סמך מסמך זה. שני המסמכים הם אותו חיוב ולא מסתכמים.
        </div>
      )}

      {mismatch && (
        <div className="mt-3 text-[11px] border border-[var(--peak)] rounded-xl px-3 py-2 leading-relaxed">
          <div>
            סכום המסמכים הוא {money(mismatch.gross_max)} ברוטו ({money(mismatch.net)} נטו), ואבן הדרך רשומה על{" "}
            {money(mismatch.milestone_amount)}. אפשר להמשיך — הסכומים יישארו כפי שהם.
          </div>
          <label className="flex items-center gap-2 mt-2 cursor-pointer">
            <input type="checkbox" checked={!!ack} onChange={(e) => onAck(e.target.checked)} />
            <span>אני מאשר/ת את הפער</span>
          </label>
        </div>
      )}

      <div className="flex gap-2 mt-4">
        <button
          onClick={onSubmit}
          disabled={busy || sel.size === 0 || (!!mismatch && !ack)}
          className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
          style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
        >
          {busy ? "משייך…" : "רשום כחויב"}
        </button>
        <button onClick={onClose} className="text-[var(--dim)] text-sm px-3">
          סגור
        </button>
      </div>
    </>
  );
}
