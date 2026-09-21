"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useDrawer } from "@/components/EntityDrawer";
import { displayDate } from "@/lib/dates";

// The fourth block on /documents/gaps: the payment matches the engine WOULD
// link, proposed and never linked on their own (F14 stage B, owner decisions
// 2026-09-21/22). Server side shipped in 927a320 and is not touched here.
//
// ═══ WHY THIS FETCHES INSTEAD OF ARRIVING AS A PROP ═══
// The other three blocks are computed in the server component and handed down.
// This one reads GET /api/finance/payment-matches, which is where the
// fingerprint is minted — and the fingerprint has to be minted by the same
// route that the confirm call is checked against, or the two can drift. It
// also means the list can be re-read after an approval without re-rendering
// the whole screen.
//
// ⚠️ NOTHING HERE LINKS ANYTHING BY ITSELF. A row's button opens a dialog; only
// the dialog's confirm posts, and it posts ONE pair with its own fingerprint.
// There is no "approve all", by decision.

export type PaymentMatch = {
  docId: string;
  jobId: string;
  docNumber: string | null;
  docType: number;
  docTypeLabel: string;
  docAmount: number | null;
  docDate: string | null;
  clientName: string;
  jobLabel: string;
  jobAmount: number | null;
  jobDate: string | null;
  dateGapDays: number | null;
  amountBasis: "vat" | "pre";
  amountBasisLabel: string;
  fingerprint: string;
};

export type PairResult = {
  docId: string;
  jobId: string;
  ok: boolean;
  state?: string;
  reason?: "not_in_set" | "stale" | "link_refused";
  error?: string;
};

const money = (n: number | null) =>
  n === null ? "—" : new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n);

const when = (iso: string | null) => displayDate(iso) ?? "—";

// A document number is Latin digits inside an RTL page, and "#40283" beside a
// Hebrew word is exactly where bidi reorders things. The app's mechanism for
// that is dir="ltr" on the element (there is no literal LRM anywhere in the
// codebase) — and on an inline span it isolates the run, which is what a bare
// LRM would only half do.
function DocNo({ n }: { n: string | null }) {
  return (
    <span dir="ltr" className="font-mono font-bold">
      {n ? `#${n}` : "—"}
    </span>
  );
}

// The two refusals that mean "the world moved under the list" get ONE sentence,
// the owner's, regardless of which server gate fired: to the person reading it
// there is no difference between "a second document arrived" and "the amount
// was edited" — both mean look again. Anything else is the server's own words,
// verbatim, because those name a specific document or job.
const REFUSAL_MOVED =
  "המצב השתנה מאז שהרשימה הוצגה, והזוג כבר אינו התאמה יחידה. לא בוצע שום קישור ושום סימון. יש לרענן את הרשימה.";
export const refusalText = (r: PairResult) =>
  r.reason === "stale" || r.reason === "not_in_set" ? REFUSAL_MOVED : r.error ?? "השיוך נכשל";

// ═══ WHY THE TWO BODIES BELOW ARE SEPARATE AND TAKE PROPS ═══
// Same reason RecordBilledBody is: renderToString never runs an effect, so a
// component that fetches its own rows can only ever be tested in its loading
// state, and the confirm dialog — which is the only thing here that can move
// money — would be unreachable behind internal state. The container keeps the
// fetch and the posting; everything that draws takes what it draws as a prop,
// so scripts/test_payment_approval_render.tsx can reach every state including
// the ones a version skew produces (a null where a string was promised).

/** The list. Pure: it draws what it is handed and posts nothing. */
export function PaymentApprovalBody({
  rows,
  canEdit,
  refused,
  busy,
  onApprove,
  onOpenJob,
}: {
  rows: PaymentMatch[];
  canEdit: boolean;
  refused: Record<string, string>;
  busy: string | null;
  onApprove: (m: PaymentMatch) => void;
  onOpenJob: (jobId: string) => void;
}) {
  return (
    <>
      <p className="text-[11px] text-[var(--faint)] mb-3 leading-relaxed">
        המערכת מצאה מסמכי תשלום (קבלה או חשבונית מס/קבלה) שמתאימים לעבודות שעדיין לא סומנו כשולמו — אותו לקוח, אותו
        סכום, והתאמה יחידה משני הצדדים.
        <br />
        שום דבר לא נכתב לפני אישור. אישור שורה מקשר את המסמך לעבודה ומסמן אותה {"״שולם״"}, ואין לכך כפתור ביטול במסך.
        <br />
        ההתאמה לא בודקת תאריכים — במכוון, כי החיוב מגיע לפעמים חודשים אחרי ההקלטה. הפער בימים מוצג בעמודה, לשיקולכם.
      </p>

      {rows.length === 0 ? (
        <div className="text-center text-xs text-[var(--faint)] py-8 border border-dashed border-[var(--rule)] rounded-2xl px-4 leading-relaxed">
          אין כרגע תשלומים שממתינים לאישור. כשתיכנס קבלה שמתאימה לעבודה פתוחה, היא תופיע כאן — ולא תקושר לפני אישור.
        </div>
      ) : (
        <div className="overflow-x-auto border border-[var(--rule)] rounded-2xl">
          <table className="w-full text-[11px] whitespace-nowrap">
            <thead className="text-[var(--faint)] border-b border-[var(--rule)]">
              <tr>
                <th className="text-right font-normal py-2 px-2">מסמך</th>
                <th className="text-right font-normal py-2 px-2">לקוח</th>
                <th className="text-right font-normal py-2 px-2">סכום המסמך</th>
                <th className="text-right font-normal py-2 px-2">תאריך המסמך</th>
                <th className="text-right font-normal py-2 px-2">העבודה</th>
                <th className="text-right font-normal py-2 px-2">סכום העבודה</th>
                <th className="text-right font-normal py-2 px-2">תאריך העבודה</th>
                <th className="text-right font-normal py-2 px-2">פער בימים</th>
                <th className="text-right font-normal py-2 px-2">בסיס</th>
                {canEdit && <th className="py-2 px-2" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.docId} className="border-b border-[var(--rule)] last:border-0 align-top">
                  <td className="py-2 px-2">
                    <DocNo n={m.docNumber} />
                    <span className="text-[var(--faint)]"> · {m.docTypeLabel ?? "—"}</span>
                  </td>
                  <td className="py-2 px-2">{m.clientName ?? "—"}</td>
                  <td className="py-2 px-2 font-mono">{money(m.docAmount)}</td>
                  <td className="py-2 px-2 font-mono text-[var(--dim)]">{when(m.docDate)}</td>
                  <td className="py-2 px-2 max-w-[220px] whitespace-normal">
                    <button onClick={() => onOpenJob(m.jobId)} className="text-right hover:underline">
                      {m.jobLabel ?? "—"}
                    </button>
                    {refused[m.docId] && (
                      <div className="mt-1 text-[10px] text-[var(--red)] whitespace-normal leading-relaxed">
                        {refused[m.docId]}
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-2 font-mono">{money(m.jobAmount)}</td>
                  <td className="py-2 px-2 font-mono text-[var(--dim)]">{when(m.jobDate)}</td>
                  <td className="py-2 px-2 font-mono">{m.dateGapDays == null ? "—" : m.dateGapDays}</td>
                  <td className="py-2 px-2 text-[var(--faint)]">{m.amountBasisLabel ?? "—"}</td>
                  {canEdit && (
                    <td className="py-2 px-2">
                      <button
                        disabled={busy !== null}
                        onClick={() => onApprove(m)}
                        className="shrink-0 font-bold rounded-lg px-3 py-1 bg-[var(--signal)] text-white disabled:opacity-40"
                      >
                        {busy === m.docId ? "…" : "אישור — קישור וסימון ״שולם״"}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** The confirm dialog. The ONLY thing in this feature that can move money. */
export function PaymentConfirmBody({
  m,
  busy,
  onCancel,
  onConfirm,
}: {
  m: PaymentMatch;
  busy: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="glass-card w-full max-w-md p-5 text-xs leading-relaxed" onClick={(e) => e.stopPropagation()}>
      <h3 className="text-sm font-bold mb-3">לסמן את העבודה כשולמה?</h3>
      <p className="mb-2">
        מסמך <DocNo n={m.docNumber} /> ({m.docTypeLabel ?? "—"}, {money(m.docAmount)}, {when(m.docDate)}) יקושר לעבודה{" "}
        <span className="font-bold">{m.jobLabel ?? "—"}</span> ({money(m.jobAmount)}, {when(m.jobDate)}).
      </p>
      <p className="mb-2">
        העבודה תסומן {"״שולם״"} והחוב יירד ב-{money(m.jobAmount)}.
      </p>
      <p className="mb-4 text-[var(--warn)]">אין ביטול מהמסך — ביטול קישור דורש טיפול ידני במסד.</p>
      <div className="flex items-center justify-end gap-2">
        <button
          disabled={busy !== null}
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 border border-[var(--rule)] disabled:opacity-40"
        >
          ביטול
        </button>
        <button
          disabled={busy !== null}
          onClick={onConfirm}
          className="font-bold rounded-lg px-3 py-1.5 bg-[var(--signal)] text-white disabled:opacity-40"
        >
          {busy ? "…" : "כן, לקשר ולסמן שולם"}
        </button>
      </div>
    </div>
  );
}

export default function PaymentApprovalSection({
  canEdit,
  onCount,
}: {
  canEdit: boolean;
  onCount: (n: number) => void;
}) {
  const router = useRouter();
  const { openEntity } = useDrawer();
  const [rows, setRows] = useState<PaymentMatch[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // rows approved this session, hidden until the next load — the same
  // session-only treatment the other three blocks give their "הסתר"
  const [done, setDone] = useState<Set<string>>(new Set());
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<PaymentMatch | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/finance/payment-matches")
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(b.error ?? "טעינת ההצעות נכשלה"))))
      .then((b) => {
        setRows(b.matches ?? []);
        setLoadErr(null);
      })
      .catch((e) => {
        setRows([]);
        setLoadErr(typeof e === "string" ? e : "שגיאת רשת");
      });
  }, []);

  useEffect(load, [load]);

  const visible = (rows ?? []).filter((r) => !done.has(r.docId));
  useEffect(() => onCount(visible.length), [visible.length, onCount]);

  async function approve(m: PaymentMatch) {
    setBusy(m.docId);
    setRefused((s) => {
      const next = { ...s };
      delete next[m.docId];
      return next;
    });
    try {
      const res = await fetch("/api/finance/reconcile-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // ONE pair, with the fingerprint this row was displayed with.
        body: JSON.stringify({ pairs: [{ docId: m.docId, jobId: m.jobId, fingerprint: m.fingerprint }] }),
      });
      const body = await res.json();
      if (!res.ok) {
        setRefused((s) => ({ ...s, [m.docId]: body.error ?? "השיוך נכשל" }));
        return;
      }
      // The endpoint always answers per pair, so a refusal arrives inside a 200
      // and must be read out of `results` rather than from the status code.
      const r: PairResult | undefined = (body.results ?? [])[0];
      if (r?.ok) {
        setDone((s) => new Set(s).add(m.docId));
        // the job's finance state moved — the rest of the screen is stale too
        router.refresh();
        load();
      } else {
        setRefused((s) => ({ ...s, [m.docId]: refusalText(r ?? { docId: m.docId, jobId: m.jobId, ok: false }) }));
        // a refusal means this row's facts are not what was shown; re-read so
        // the operator is not looking at the stale version of it
        load();
      }
    } catch {
      setRefused((s) => ({ ...s, [m.docId]: "שגיאת רשת" }));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  if (rows === null) {
    return (
      <section className="mb-8">
        <h2 className="text-sm font-bold mb-2">תשלומים לאישור</h2>
        <div className="text-xs text-[var(--faint)] py-6 text-center">טוען…</div>
      </section>
    );
  }

  return (
    <section className="mb-8">
      <h2 className="text-sm font-bold mb-2 flex items-center gap-2">
        <span className="text-[var(--green)]">●</span> תשלומים לאישור ({visible.length})
      </h2>

      <p className="text-[11px] text-[var(--faint)] mb-3 leading-relaxed">
        המערכת מצאה מסמכי תשלום (קבלה או חשבונית מס/קבלה) שמתאימים לעבודות שעדיין לא סומנו כשולמו — אותו לקוח, אותו
        סכום, והתאמה יחידה משני הצדדים.
        <br />
        שום דבר לא נכתב לפני אישור. אישור שורה מקשר את המסמך לעבודה ומסמן אותה {"״שולם״"}, ואין לכך כפתור ביטול במסך.
        <br />
        ההתאמה לא בודקת תאריכים — במכוון, כי החיוב מגיע לפעמים חודשים אחרי ההקלטה. הפער בימים מוצג בעמודה, לשיקולכם.
      </p>

      {loadErr && (
        <div className="mb-3 text-xs text-[var(--red)] border border-[var(--red)] rounded-xl px-3 py-2">{loadErr}</div>
      )}

      <PaymentApprovalBody
        rows={visible}
        canEdit={canEdit}
        refused={refused}
        busy={busy}
        onApprove={setConfirming}
        onOpenJob={(jobId) => openEntity({ type: "job", id: jobId })}
      />

      {/* The dialog is the only thing that posts — the row button only opens it. */}
      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => busy === null && setConfirming(null)}
        >
          <PaymentConfirmBody
            m={confirming}
            busy={busy}
            onCancel={() => setConfirming(null)}
            onConfirm={() => approve(confirming)}
          />
        </div>
      )}
    </section>
  );
}
