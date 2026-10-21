"use client";

import { useState } from "react";
import type { AlertRecipientsView } from "@/lib/whatsapp/opsTest";

// B38-7 — who receives the system's WhatsApp alerts, and a test send (owner
// only; the page renders this card only for role 'owner'). The numbers arrive
// already normalised and masked from the server — the full number never
// reaches the browser.

type Result = { ok: true; dryRun: boolean; to: string; providerWamid?: string } | { ok: false; error: string; to?: string };

export function RecipientsList({ recipients }: { recipients: AlertRecipientsView | null | undefined }) {
  const notify = recipients?.notify ?? [];
  const billing = recipients?.billing ?? [];
  const Num = ({ n }: { n: string }) => (
    <span dir="ltr" className="font-mono">
      {n}
    </span>
  );
  return (
    <div className="text-xs space-y-2 mb-4">
      <div>
        <div className="font-bold mb-0.5">התראות לבעלים (WHATSAPP_NOTIFY_NUMBERS)</div>
        {notify.length === 0 ? (
          <div className="text-[var(--peak)]">לא מוגדר מספר — התראות לא נשלחות</div>
        ) : (
          <ul className="space-y-0.5">
            {notify.map((n, i) => (
              <li key={`n${i}`}>
                <Num n={n} />
                {i === 0 ? <span className="text-[var(--faint)]"> · מקבל את התראות המערכת</span> : null}
              </li>
            ))}
          </ul>
        )}
        {recipients?.notifyRejected ? (
          <div className="text-[var(--amber)] mt-0.5">{recipients.notifyRejected} רשומות לא תקינות — לא מקבלות הודעות</div>
        ) : null}
      </div>
      <div>
        <div className="font-bold mb-0.5">הנהלת חשבונות (WHATSAPP_BILLING_NOTIFY_NUMBERS)</div>
        {billing.length === 0 ? (
          <div className="text-[var(--faint)]">לא מוגדר</div>
        ) : (
          <ul className="space-y-0.5">
            {billing.map((n, i) => (
              <li key={`b${i}`}>
                <Num n={n} />
              </li>
            ))}
          </ul>
        )}
        {recipients?.billingRejected ? (
          <div className="text-[var(--amber)] mt-0.5">{recipients.billingRejected} רשומות לא תקינות — לא מקבלות הודעות</div>
        ) : null}
      </div>
    </div>
  );
}

export function TestResultLine({ result }: { result: Result | null }) {
  if (!result) return null;
  if (!result.ok) {
    return (
      <div className="text-[11px] text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2 mt-2" dir="auto">
        השליחה נכשלה: {result.error}
      </div>
    );
  }
  if (result.dryRun) {
    return <div className="text-[11px] text-[var(--amber)] mt-2">מצב יבש (WHATSAPP_DRY_RUN) — לא נשלחה הודעה</div>;
  }
  return (
    <div className="text-[11px] text-[var(--green)] mt-2">
      נשלח בהצלחה ל-<span dir="ltr" className="font-mono">{result.to}</span> · מזהה ההודעה:{" "}
      <span dir="ltr" className="font-mono break-all">{result.providerWamid}</span>
    </div>
  );
}

export default function WhatsAppAlertsCard({ recipients }: { recipients: AlertRecipientsView | null | undefined }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function sendTest() {
    setBusy(true);
    setResult(null);
    const res = await fetch("/api/settings/whatsapp-test", { method: "POST" });
    const d = (await res.json().catch(() => ({}))) as { ok?: boolean; dryRun?: boolean; to?: string; providerWamid?: string; error?: string };
    setBusy(false);
    if (!res.ok || d.ok === false) {
      setResult({ ok: false, error: d.error ?? `HTTP ${res.status}`, to: d.to });
      return;
    }
    setResult({ ok: true, dryRun: !!d.dryRun, to: d.to ?? "", providerWamid: d.providerWamid });
  }

  return (
    <section className="glass-card-secondary mt-4" style={{ padding: "18px 20px" }}>
      <h2 className="text-sm font-bold">התראות וואטסאפ</h2>
      <p className="text-xs text-[var(--faint)] mt-0.5 mb-3">
        המספרים שמקבלים התראות מהמערכת. מוצגות רק 4 הספרות האחרונות. שינוי — ב-Vercel ואחריו Redeploy.
      </p>
      <RecipientsList recipients={recipients} />
      <button
        data-action="whatsapp-test"
        onClick={() => void sendTest()}
        disabled={busy}
        className="text-xs font-bold rounded-xl px-4 py-2 border border-[var(--rule2)] disabled:opacity-40"
      >
        {busy ? "שולח…" : "שליחת התראת בדיקה"}
      </button>
      <div className="text-[10px] text-[var(--faint)] mt-1">נשלחת רק למספר הבעלים (הראשון ברשימה), פעם בדקה לכל היותר.</div>
      {/* E14-3: the free-text review screen */}
      <a href="/settings/freetext" className="inline-block text-xs text-[var(--violet-light)] hover:underline mt-3">
        טקסט חופשי בבוט — מעקב והודעות שלא הובנו ←
      </a>
      <TestResultLine result={result} />
    </section>
  );
}
