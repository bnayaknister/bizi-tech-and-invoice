"use client";

import { displayDate } from "@/lib/dates";
import {
  chainExtraNumbers,
  failureLine,
  type BilledCandidate,
  type BilledResult,
} from "@/app/contracts/RecordBilledBody";

/**
 * The panel content of "רישום הפקה שכבר בוצעה" — PURE. No hooks, no fetch, no
 * router: every piece of state arrives as a prop, every action leaves as a
 * callback. Its container (RecordPastModal in ShowsClient.tsx) owns all of that
 * and the overlay around it.
 *
 * ═══ WHY PURE, AND WHY IT SHARES RecordBilledBody's HELPERS ═══
 * The render check in this project is `renderToString` under tsx — no jsdom, no
 * testing-library — so effects never run and a stateful modal can only ever be
 * rendered in its loading state. Five states have to be exercised here and each
 * is a place the screen can crash on a payload it did not expect: the empty
 * list, a picked chain, the amount warning, a job that already carries
 * productions, and a partial link.
 *
 * The chain sentence, the failure line and the mismatch copy are IMPORTED from
 * RecordBilledBody rather than retyped. They are the same sentences about the
 * same facts — a document chain does not mean something different because the
 * screen around it changed — and two copies is how they drift.
 *
 * Every value that came from the server is rendered defensively: arrays
 * default, labels fall back, and nothing is indexed into a map without one.
 * That is the 2026-09-15 lesson (`MILESTONE_META[state].color` on a state the
 * bundle did not know) applied ahead of time rather than after.
 */

export type PastEpisode = { record_date: string; title: string };
export type PastJob = {
  id: string;
  campaign: string | null;
  amount: number | null;
  date: string | null;
  paid: string | null;
  doc_number: string | null;
  linked_productions: number;
};
export type BillingMode = "job" | "documents" | "none";
/**
 * The amount warning's numbers. Deliberately NOT RecordBilledBody's
 * BilledMismatch: that one's third field is `milestone_amount`, and the figure
 * being compared here is episodes x the show's rate. Same shape, different
 * noun — and the noun is the half that reaches the reader.
 */
export type PastMismatch = { gross_max: number; net: number; expected_amount: number };

const NIS = new Intl.NumberFormat("he-IL");
const money = (n: number | null | undefined) => (n == null ? "—" : `${NIS.format(Math.round(n))} ₪`);

const MODE_LABEL: Record<BillingMode, string> = {
  job: "חיוב קיים",
  documents: "מסמכים שיצאו ממורנינג",
  none: "בלי חיוב",
};
const MODES: BillingMode[] = ["job", "documents", "none"];

export default function RecordPastBody({
  showName,
  defaultRate,
  loading,
  episodes,
  mode,
  jobs,
  selectedJobId,
  documents,
  picked,
  busy,
  error,
  mismatch,
  ack,
  result,
  warning,
  onEpisodeChange,
  onAddEpisode,
  onRemoveEpisode,
  onMode,
  onSelectJob,
  onToggleDoc,
  onAck,
  onSubmit,
  onClose,
}: {
  showName: string;
  defaultRate: number | null;
  loading: boolean;
  episodes: PastEpisode[];
  mode: BillingMode;
  jobs: PastJob[];
  selectedJobId: string | null;
  documents: BilledCandidate[];
  picked: ReadonlySet<string>;
  busy: boolean;
  error: string | null;
  mismatch: PastMismatch | null;
  ack: boolean;
  result: BilledResult | null;
  warning: string | null;
  onEpisodeChange: (i: number, patch: Partial<PastEpisode>) => void;
  onAddEpisode: () => void;
  onRemoveEpisode: (i: number) => void;
  onMode: (m: BillingMode) => void;
  onSelectJob: (id: string) => void;
  onToggleDoc: (c: BilledCandidate) => void;
  onAck: (v: boolean) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const eps = episodes ?? [];
  const jobRows = jobs ?? [];
  const docs = documents ?? [];
  const sel: ReadonlySet<string> = picked ?? new Set<string>();
  const chainExtra = chainExtraNumbers(docs, sel);
  const failed = result?.failed ?? [];
  const selectedJob = jobRows.find((j) => j.id === selectedJobId) ?? null;
  const expectedNet = defaultRate == null ? null : eps.length * defaultRate;

  const canSubmit =
    !busy &&
    eps.length > 0 &&
    eps.every((e) => !!e?.record_date) &&
    (mode === "none" ||
      (mode === "job" && !!selectedJobId) ||
      (mode === "documents" && sel.size > 0)) &&
    !(mismatch && !ack);

  return (
    <>
      <h3 className="font-bold mb-1">רישום הפקה שכבר בוצעה</h3>
      <p className="text-[11px] text-[var(--dim)] mb-4 leading-relaxed">
        ההפקה כבר בוצעה וחויבה מחוץ למערכת. היא תירשם כהיסטורית, לא תיכנס לתור האישורים ולא תנפיק שום מסמך.
      </p>

      <div className="flex items-baseline gap-2 mb-3 text-xs border border-[var(--rule)] rounded-xl px-3 py-2">
        <span className="font-medium">{showName ?? "—"}</span>
        <div className="flex-1" />
        <span className="text-[var(--faint)]">מחיר לפרק</span>
        <span className="font-mono">{money(defaultRate)}</span>
      </div>

      {error && (
        <div className="mb-3 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2">{error}</div>
      )}
      {warning && (
        <div className="mb-3 text-[11px] text-[var(--dim)] border border-[var(--rule)] rounded-xl px-3 py-2">
          {warning}
        </div>
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

      {/* ---- the episodes ---- */}
      <div className="text-xs font-bold mb-1.5">פרקים ({eps.length})</div>
      <div className="space-y-1.5 mb-2">
        {eps.map((e, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="date"
              value={e?.record_date ?? ""}
              disabled={busy}
              onChange={(ev) => onEpisodeChange(i, { record_date: ev.target.value })}
              className="border border-[var(--rule)] rounded-xl px-2 py-1.5 text-xs bg-transparent"
            />
            <input
              value={e?.title ?? ""}
              disabled={busy}
              onChange={(ev) => onEpisodeChange(i, { title: ev.target.value })}
              placeholder="תיאור / אורח"
              className="flex-1 border border-[var(--rule)] rounded-xl px-2 py-1.5 text-xs bg-transparent"
            />
            {eps.length > 1 && (
              <button
                onClick={() => onRemoveEpisode(i)}
                disabled={busy}
                className="text-[11px] text-[var(--red)] px-1 disabled:opacity-40"
                aria-label="הסר פרק"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        onClick={onAddEpisode}
        disabled={busy}
        className="text-[11px] text-[var(--dim)] border border-dashed border-[var(--rule)] rounded-lg px-3 py-1 mb-4 hover:bg-[var(--panel3)] transition-colors disabled:opacity-40"
      >
        + הוסף פרק
      </button>

      {/* ---- the billing choice ---- */}
      <div className="text-xs font-bold mb-1.5">חיוב</div>
      <div className="flex gap-1 mb-3">
        {MODES.map((m) => (
          <button
            key={m}
            onClick={() => onMode(m)}
            disabled={busy}
            className={`flex-1 rounded-lg py-1.5 text-[11px] border transition-colors disabled:opacity-40 ${
              mode === m
                ? "border-[var(--violet-light)] text-[var(--violet-light)] font-bold"
                : "border-[var(--rule)] text-[var(--dim)]"
            }`}
          >
            {MODE_LABEL[m] ?? m}
          </button>
        ))}
      </div>

      {loading && <div className="text-xs text-[var(--faint)] mb-2">טוען…</div>}

      {mode === "none" && (
        <div className="text-[11px] text-[var(--dim)] border border-[var(--rule)] rounded-xl px-3 py-2 leading-relaxed">
          בלי קישור לחיוב, ההפקה תופיע בהתראת &quot;הופק ולא חויב&quot; עד שתקשר אותה.
        </div>
      )}

      {mode === "job" && !loading && (
        <>
          {jobRows.length === 0 && (
            <div className="text-xs text-[var(--faint)] leading-relaxed">אין ללקוח חיובים פנויים.</div>
          )}
          <div className="space-y-1.5">
            {jobRows.map((j) => {
              const on = j.id === selectedJobId;
              return (
                <button
                  key={j.id}
                  onClick={() => onSelectJob(j.id)}
                  disabled={busy}
                  className={`w-full text-right border rounded-xl px-3 py-2 transition-colors disabled:opacity-40 ${
                    on ? "border-[var(--signal)] bg-[var(--panel3)]" : "border-[var(--rule)] hover:bg-[var(--panel3)]"
                  }`}
                >
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                    <span className="font-mono" style={on ? { color: "var(--signal)" } : undefined}>
                      {on ? "✓" : "○"}
                    </span>
                    <span className="font-medium truncate">{j.campaign ?? "—"}</span>
                    {j.doc_number && <span className="text-[var(--faint)] font-mono">{j.doc_number}</span>}
                    <div className="flex-1" />
                    <span className="font-mono">{money(j.amount)}</span>
                    <span className="text-[var(--faint)] font-mono">{j.date ? displayDate(j.date) : "—"}</span>
                  </div>
                  {(j.linked_productions ?? 0) > 0 && (
                    <div className="text-[10px] text-[var(--dim)] mt-1">
                      החיוב הזה כבר מקושר ל-{j.linked_productions} הפקות. ההפקות החדשות יתווספו אליו.
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          {selectedJob && (selectedJob.linked_productions ?? 0) === 0 && expectedNet != null && (
            <div className="mt-2 text-[10px] text-[var(--faint)]">
              {eps.length} פרקים × {money(defaultRate)} = {money(expectedNet)}
            </div>
          )}
        </>
      )}

      {mode === "documents" && !loading && (
        <>
          {docs.length === 0 && (
            <div className="text-xs text-[var(--faint)] leading-relaxed">
              אין ללקוח מסמכים פנויים לשיוך. מסמך שכבר משויך לעבודה אחרת לא יופיע כאן.
            </div>
          )}
          <div className="space-y-1.5">
            {docs.map((c) => {
              const on = sel.has(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => onToggleDoc(c)}
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
          {expectedNet != null && (
            <div className="mt-2 text-[10px] text-[var(--faint)]">
              {eps.length} פרקים × {money(defaultRate)} = {money(expectedNet)}
            </div>
          )}
        </>
      )}

      {mismatch && (
        <div className="mt-3 text-[11px] border border-[var(--peak)] rounded-xl px-3 py-2 leading-relaxed">
          <div>
            סכום המסמכים הוא {money(mismatch.gross_max)} ברוטו ({money(mismatch.net)} נטו), ולפי מספר הפרקים
            החיוב הוא {money(mismatch.expected_amount)}. אפשר להמשיך — הסכומים יישארו כפי שהם.
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
          disabled={!canSubmit}
          className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
          style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
        >
          {busy ? "רושם…" : "רשום הפקה"}
        </button>
        <button onClick={onClose} className="text-[var(--dim)] text-sm px-3">
          סגור
        </button>
      </div>
    </>
  );
}
