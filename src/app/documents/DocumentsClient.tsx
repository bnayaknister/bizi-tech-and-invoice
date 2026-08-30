"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import ClientCombobox, { type ComboboxClient } from "@/components/ClientCombobox";
import { STUDIOS } from "@/lib/calendar/studios";
import { missingGuestLines } from "@/lib/documents/guestFlag";
import {
  DOC_TYPE_TO_MORNING_CODE,
  MORNING_DOC_CODE,
  PAYMENT_METHODS,
  relabelDocDescription,
  requiresPayment,
} from "@/lib/morning/types";

// NOTE: a local copy of the type in lib/morning/types.ts, not an import — it
// has to stay in step with it or this screen mislabels a row it is handed.
// 'receipt' added with 0053.
export type PendingDocType = "work_order" | "deal_invoice" | "tax_invoice" | "tax_receipt" | "receipt";

export type PendingDocRow = {
  id: string;
  doc_type: PendingDocType;
  status: string;
  amount: number | null;
  created_at: string;
  age_hours: number;
  aging: "warning" | "critical" | null;
  client_name: string;
  show_name: string;
  record_date: string | null;
  guest: string | null;
  /**
   * The guest behind each printed line, index-aligned to payload.income —
   * built server-side (see page.tsx), because a bundle's lines belong to
   * productions this row does not point at. Feeds missingGuestLines.
   */
  guests_by_line: (string | null)[];
  /**
   * The line buildLineItemText would have written for each printed line, same
   * index alignment. Offered as text to copy when a line is flagged — never
   * auto-filled, because the operator is the one who decides what the client
   * reads.
   */
  suggested_by_line: (string | null)[];
  payload: Record<string, unknown>;
  last_error: string | null;
  attempts: number;
  // 320 / 400 only: the gross Morning computed on the parent, read server-side
  // through the same helper the approval gate uses. null with a reason set means
  // we cannot know it yet — almost always a parent issued after the last pull.
  parent_gross: number | null;
  parent_gross_error: string | null;
};

// The four payment methods come from lib/morning/types.ts — the SAME list the
// review route refuses everything outside of. Deliberately not a copy with an
// `enabled` flag beside it: a flag only this file honoured would be a rule the
// screen enforces and the server does not, which is exactly how a 305's printed
// label once reached a 320. Removing a method there removes it from the picker
// and from the server in one edit.
//
// The bank transfer stays the default (222 of 278 lines in the books); the
// modal resets to it on every open, so a method chosen for one document never
// leaks into the next.
//
// A document with withholding still cannot be issued from this screen, and that
// is correct rather than pending: the payment gate on the server sums an ARRAY
// and is ready for it, but this modal builds exactly one line. Two-line entry is
// its own piece of work, with its own arithmetic on screen.

const TYPE_LABEL: Record<PendingDocType, string> = {
  work_order: "הזמנות עבודה",
  deal_invoice: "חשבוניות עסקה",
  tax_invoice: "חשבוניות מס",
  tax_receipt: "חשבוניות מס קבלה",
  receipt: "קבלות",
};

// Tax documents are issued one at a time behind their own confirmation.
// Mirrors the server rule in the review route — the UI must not offer what
// the server will refuse.
const TAX_TYPES: PendingDocType[] = ["tax_invoice", "tax_receipt"];
const isTax = (t: PendingDocType) => TAX_TYPES.includes(t);

const money = (n: number | null) =>
  n === null ? "—" : new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n);

// The recipient picker (owner spec 2026-07-29). Morning emails a document only
// at creation, to client.emails, capped at 3. The bookkeeper picks who from the
// client's LIVE Morning emails + the local accountant default. Reused by both
// the non-tax approve modal and the tax-confirm modal.
type RecipientData = { clientEmails: string[]; clientFetchFailed: boolean; accountantEmail: string | null; cap: number };

function buildRecipientOptions(data: RecipientData): { email: string; isAccountant: boolean }[] {
  const seen = new Set<string>();
  const out: { email: string; isAccountant: boolean }[] = [];
  const push = (email: string | null, isAccountant: boolean) => {
    const e = (email ?? "").trim();
    if (!e || seen.has(e.toLowerCase())) return;
    seen.add(e.toLowerCase());
    out.push({ email: e, isAccountant });
  };
  for (const e of data.clientEmails) push(e, false); // client emails are the defaults
  push(data.accountantEmail, true); // our accountant copy — an optional extra, last
  return out;
}

function RecipientPicker({
  loading,
  data,
  selected,
  onToggle,
}: {
  loading: boolean;
  data: RecipientData | null;
  selected: string[];
  onToggle: (email: string) => void;
}) {
  if (loading) return <div className="text-xs text-[var(--faint)] py-4 text-center">טוען נמענים…</div>;
  if (!data) return null;
  const options = buildRecipientOptions(data);
  const has = (email: string) => selected.some((e) => e.toLowerCase() === email.toLowerCase());
  return (
    <div className="mb-3">
      {data.clientFetchFailed && (
        <div className="text-[11px] text-[var(--warn)] mb-2">לא ניתן למשוך מיילי לקוח ממורנינג — בחר נמענים ידנית או הנפק בלי שליחה.</div>
      )}
      {options.length === 0 ? (
        <div className="text-[11px] text-[var(--faint)]">אין כתובות מייל זמינות — המסמך יונפק בלי שליחה.</div>
      ) : (
        <div className="space-y-1.5">
          {options.map((o) => {
            const checked = has(o.email);
            const disabled = !checked && selected.length >= data.cap;
            return (
              <label key={o.email} className={`flex items-center gap-2 text-sm ${disabled ? "opacity-40" : ""}`}>
                <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle(o.email)} />
                <span className="truncate flex-1">{o.email}</span>
                {o.isAccountant && <span className="text-[10px] text-[var(--faint)] shrink-0">עותק להנה״ח שלנו</span>}
              </label>
            );
          })}
        </div>
      )}
      <div className="text-[11px] text-[var(--faint)] mt-2">
        {selected.length === 0 ? "לא יישלח לאף אחד — המסמך רק יונפק." : `נבחרו ${selected.length}/${data.cap}`} · מורנינג מגביל ל-3 נמענים.
      </div>
    </div>
  );
}

/**
 * The exact body that will be POSTed to Morning, shown before the last click.
 *
 * Deliberately reads the STORED payload and never re-derives anything. The
 * remark in particular is rebuilt server-side when the variant is switched
 * (review route) — deriving a second version here is how the printed page and
 * the screen end up saying different things.
 */
function TaxPayloadPreview({
  payload,
  finalType,
  gross,
  paid,
}: {
  payload: Record<string, unknown>;
  /**
   * The type that will ACTUALLY be issued — the modal's finalType, not the tax
   * selector. It used to be the selector, which meant a receipt (400) was
   * measured against 305 and told the operator its remark would be rebuilt when
   * nothing of the sort was going to happen.
   */
  finalType: PendingDocType;
  /** the parent's gross, when this type has one — see PendingDocRow */
  gross?: number | null;
  /** what the payment fields currently add up to, when they are shown */
  paid?: number | null;
}) {
  const linked = Array.isArray(payload?.linkedDocumentIds) ? (payload.linkedDocumentIds as string[]) : [];
  const income = Array.isArray(payload?.income)
    ? (payload.income as { description?: string; quantity?: number; price?: number }[])
    : [];
  const remarks = typeof payload?.remarks === "string" ? payload.remarks : null;
  const description = typeof payload?.description === "string" ? payload.description : null;
  // a receipt carries no income lines, so there is no net to show for it —
  // only the gross it collects
  const net = income.length
    ? income.reduce((s, l) => s + Number(l.price ?? 0) * Number(l.quantity ?? 1), 0)
    : null;
  const willRebuildRemark = remarks !== null && payload?.type !== DOC_TYPE_TO_MORNING_CODE[finalType];

  // The description carries a printed label too, and the server normalizes it at
  // approval — same function, so what is promised here is what will be sent.
  // Only a 305/320 is normalized server-side, so only those are promised here.
  // The stored value stays on screen above; this states what it becomes, because
  // a line that is about to change without saying so is worse than no preview.
  const relabelled = isTax(finalType) ? relabelDocDescription(description, finalType) : ({ ok: false } as const);
  const nextDescription = relabelled.ok && relabelled.changed ? relabelled.description : null;
  // hand-edited: left exactly as written, which is right — and worth saying,
  // because on a 320 it is the one case where the label can still contradict
  // the document, and there is no fixing that after the click
  const descriptionStuck =
    isTax(finalType) && description !== null && !relabelled.ok;

  return (
    <div className="border-t border-[var(--rule)] pt-3 mb-3">
      <div className="text-xs font-bold mb-2">מה יישלח למורנינג</div>
      <div className="text-[11px] space-y-1.5">
        {description && (
          <div className="flex gap-2">
            <span className="text-[var(--faint)] shrink-0">תיאור:</span>
            <span className="break-all">{description}</span>
          </div>
        )}
        {nextDescription && (
          <div className="text-[var(--warn)] break-all">
            התיאור יעודכן בעת האישור ל: {nextDescription}
          </div>
        )}
        {descriptionStuck && (
          <div className="text-[var(--warn)]">
            התיאור נערך ידנית ולא יעודכן אוטומטית — ודאי שהוא תואם את סוג המסמך שנבחר.
          </div>
        )}
        <div className="flex gap-2">
          <span className="text-[var(--faint)] shrink-0">הערה מודפסת:</span>
          <span className="break-all">{remarks ?? "— (אין הערת מקור)"}</span>
        </div>
        {willRebuildRemark && (
          <div className="text-[var(--warn)]">ההערה תיבנה מחדש לפי הסוג שנבחר בעת האישור.</div>
        )}
        <div className="flex gap-2">
          <span className="text-[var(--faint)] shrink-0">סוגר במורנינג:</span>
          <span className="font-mono break-all">{linked.length ? linked.join(", ") : "— (ללא קישור)"}</span>
        </div>
        {income.length > 0 && (
          <div>
            <div className="text-[var(--faint)] mb-1">שורות הכנסה ({income.length})</div>
            <div className="space-y-0.5">
              {income.map((l, i) => (
                <div key={i} className="flex justify-between gap-2 font-mono">
                  <span className="truncate">{l.description ?? "—"}</span>
                  <span className="shrink-0">
                    {l.quantity ?? 1} × {l.price ?? 0}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* The arithmetic laid out, so the jump from the net lines above to the
            gross the payment has to match is visible rather than suspicious.
            The VAT is shown as the DIFFERENCE, never as a rate we applied —
            the gross is Morning's own number, read back from the parent. */}
        {(gross !== null && gross !== undefined) && (
          <div className="border-t border-[var(--rule)] mt-2 pt-2 space-y-0.5">
            {net !== null && (
              <div className="flex justify-between gap-2 font-mono">
                <span className="text-[var(--faint)]">נטו</span>
                <span>{net.toFixed(2)}</span>
              </div>
            )}
            {net !== null && (
              <div className="flex justify-between gap-2 font-mono">
                <span className="text-[var(--faint)]">מע״מ</span>
                <span>{(gross - net).toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between gap-2 font-mono font-bold">
              <span className="text-[var(--faint)]">ברוטו</span>
              <span>{gross.toFixed(2)}</span>
            </div>
            {paid !== null && paid !== undefined && (
              <div
                className={`flex justify-between gap-2 font-mono font-bold ${
                  Math.abs(paid - gross) > 0.01 ? "text-[var(--peak)]" : "text-[var(--green)]"
                }`}
              >
                <span>תקבול</span>
                <span>{paid.toFixed(2)}</span>
              </div>
            )}
            {paid !== null && paid !== undefined && Math.abs(paid - gross) > 0.01 && (
              <div className="text-[10px] text-[var(--peak)]">
                התקבול אינו שווה לברוטו — ההנפקה תידחה.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The guest behind a flagged line, and the line the enqueue would have written.
 *
 * Extracted so it can be rendered on its own (scripts/test_documents_edit_render.tsx):
 * the edit form only enters the DOM after a click, which renderToString cannot
 * perform, so without this the one thing that regressed had no coverage at all.
 * Both call sites — a bundle's per-line block and the single-line description —
 * render THIS, so the test exercises the real component rather than a copy.
 *
 * The guest used to live only in a title="…" on an 8px ⚠ glyph. It was there
 * the whole time; the person who needed it left the screen to look it up.
 *
 * The suggestion is display-only and deliberately not a fill button: what the
 * client reads is the operator's decision, not ours.
 */
export function GuestHint({ guest, suggestion }: { guest: string | null; suggestion: string | null }) {
  if (!guest && !suggestion) return null;
  return (
    <>
      {guest && (
        <div className="text-[10px] text-[var(--warn)]">
          ⚠ אורח ההפקה: <span className="font-bold">{guest}</span>
        </div>
      )}
      {suggestion && (
        <div className="text-[10px] text-[var(--faint)]">
          הפורמט המלא: <span className="font-mono text-[var(--dim)] select-all">{suggestion}</span>
        </div>
      )}
    </>
  );
}

export default function DocumentsClient({
  rows,
  canApprove,
  dryRun,
  env,
}: {
  rows: PendingDocRow[];
  canApprove: boolean;
  dryRun: boolean;
  env: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  // the second gate for a tax document
  const [confirming, setConfirming] = useState<PendingDocRow | null>(null);
  // 305 by default, matching DEFAULT_TAX_VARIANT — a receipt declares the money
  // arrived and cannot be taken back, so it is chosen on purpose, never by
  // leaving the selector alone
  const [taxVariant, setTaxVariant] = useState<"tax_receipt" | "tax_invoice">("tax_invoice");
  // the payment block, for the types that declare money actually moved
  const [payMethod, setPayMethod] = useState<number>(4);
  const [payAmount, setPayAmount] = useState<string>("");
  const [payDate, setPayDate] = useState<string>("");
  // inline "edit before approve"
  const [editing, setEditing] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState<string>("");
  const [editDesc, setEditDesc] = useState<string>("");
  // A bundled invoice carries one income line per episode. With more than one,
  // the form edits the LINES and locks the money (the amount is the sum of the
  // bundled jobs); with one, it stays the amount+description form it has always
  // been, because there the title and the line are the same string.
  const [editLines, setEditLines] = useState<string[]>([]);
  // The recipient the document will be MADE OUT TO. Separate from the client
  // who owes — a document ordered by one entity and invoiced to another is
  // normal here (owner 2026-08-02), so this picker lists all of Morning's
  // clients, not only the ones mapped to ours. Fetched once per session, on
  // first open: it is a live Morning read and the list barely moves.
  const [editClient, setEditClient] = useState<string | null>(null);
  const [morningClients, setMorningClients] = useState<ComboboxClient[] | null>(null);
  const [loadingClients, setLoadingClients] = useState(false);
  // recipient picker (owner spec 2026-07-29). recipientFor drives the non-tax
  // modal; the tax-confirm modal reuses the same recipientData/selectedEmails.
  const [recipientFor, setRecipientFor] = useState<PendingDocRow | null>(null);
  const [recipientData, setRecipientData] = useState<RecipientData | null>(null);
  const [selectedEmails, setSelectedEmails] = useState<string[]>([]);
  const [loadingRecipients, setLoadingRecipients] = useState(false);

  async function loadRecipients(r: PendingDocRow) {
    setRecipientData(null);
    setSelectedEmails([]);
    setLoadingRecipients(true);
    try {
      const res = await fetch(`/api/documents/pending/${r.id}/recipients`);
      const b = await res.json();
      if (!res.ok) {
        setError(b.error ?? "טעינת נמענים נכשלה");
        return;
      }
      setRecipientData({
        clientEmails: b.clientEmails ?? [],
        clientFetchFailed: !!b.clientFetchFailed,
        accountantEmail: b.accountantEmail ?? null,
        cap: b.cap ?? 3,
      });
      setSelectedEmails(b.defaultSelected ?? []);
    } catch {
      setError("שגיאת רשת");
    } finally {
      setLoadingRecipients(false);
    }
  }

  function toggleEmail(email: string) {
    setSelectedEmails((cur) => {
      const has = cur.some((e) => e.toLowerCase() === email.toLowerCase());
      if (has) return cur.filter((e) => e.toLowerCase() !== email.toLowerCase());
      if (cur.length >= (recipientData?.cap ?? 3)) return cur; // hard cap 3
      return [...cur, email];
    });
  }

  // non-tax: the recipient modal's confirm → issue with the chosen recipients
  function submitRecipients() {
    const r = recipientFor;
    if (!r) return;
    setRecipientFor(null);
    send([r.id], "approve", { recipients: selectedEmails });
  }

  const groups = useMemo(() => {
    const g = new Map<PendingDocType, PendingDocRow[]>();
    for (const r of rows) {
      const arr = g.get(r.doc_type) ?? [];
      arr.push(r);
      g.set(r.doc_type, arr);
    }
    return g;
  }, [rows]);

  const critical = rows.filter((r) => r.aging === "critical").length;
  const warning = rows.filter((r) => r.aging === "warning").length;

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function send(ids: string[], action: "approve" | "reject", extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/documents/pending/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action, ...extra }),
      });
      const body = await res.json();
      if (res.status === 412 && body.needs_confirmation) {
        // server insisted on the second gate — open it rather than retrying
        const row = rows.find((r) => r.id === ids[0]);
        if (row) {
          setTaxVariant(row.doc_type === "tax_invoice" ? "tax_invoice" : "tax_receipt");
          setConfirming(row);
        }
        return;
      }
      if (!res.ok) {
        setError(body.error ?? "הפעולה נכשלה");
        return;
      }
      // One filter, both actions. Reject used to answer with a bare
      // `{ok:true, rejected:N}` and no `results` at all — so `body.results ?? []`
      // was always empty, `failed` was always zero, and a rejection that never
      // reached the database reported success on this screen. The server now
      // returns the same `{id, ok, detail}` shape for reject as for approve
      // (2026-08-30), which is what lets this line cover it unchanged.
      //
      // `error` is read as a fallback so a caller that reports a per-row failure
      // under that key still renders instead of printing "undefined".
      const failed = (body.results ?? []).filter((r: { ok: boolean }) => !r.ok);
      if (failed.length) {
        setError(
          failed
            .map((f: { detail?: string; error?: string }) => f.detail ?? f.error ?? "הפעולה נכשלה")
            .join(" · ")
        );
      }
      setSelected(new Set());
      setConfirming(null);
      setRecipientFor(null);
      setRecipientData(null);
      setSelectedEmails([]);
      router.refresh();
    } catch {
      setError("שגיאת רשת");
    } finally {
      setBusy(false);
    }
  }

  function approveOne(r: PendingDocRow) {
    // both paths pick recipients first (owner spec 2026-07-29): a tax document
    // folds the picker into its own confirmation modal; everything else gets the
    // dedicated recipient modal.
    //
    // A receipt (400) goes down the confirmation path too — not because it needs
    // the 305/320 choice (it has none) but because that modal is where the
    // payment block is filled, and it cannot be issued without one.
    if (isTax(r.doc_type) || requiresPayment(DOC_TYPE_TO_MORNING_CODE[r.doc_type])) {
      if (isTax(r.doc_type)) setTaxVariant(r.doc_type === "tax_invoice" ? "tax_invoice" : "tax_receipt");
      // the amount defaults to the parent's gross — the exact figure the server
      // will compare against — and the date to today, editable backwards because
      // money usually arrives before anyone gets to this screen
      setPayMethod(4);
      setPayAmount(r.parent_gross !== null ? String(r.parent_gross) : "");
      setPayDate(new Date().toISOString().slice(0, 10));
      setConfirming(r);
      void loadRecipients(r);
      return;
    }
    setRecipientFor(r);
    void loadRecipients(r);
  }

  function reject(r: PendingDocRow) {
    const reason = window.prompt("סיבת דחייה (חובה):")?.trim();
    if (!reason) return;
    send([r.id], "reject", { reason });
  }

  async function loadMorningClients() {
    if (morningClients || loadingClients) return;
    setLoadingClients(true);
    try {
      const res = await fetch("/api/morning/clients");
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "שליפת לקוחות ממורנינג נכשלה");
        return;
      }
      setMorningClients(
        ((body.morning_clients ?? []) as { id: string; name: string }[]).map((c) => ({ id: c.id, name: c.name }))
      );
    } catch {
      setError("שגיאת רשת בשליפת לקוחות מורנינג");
    } finally {
      setLoadingClients(false);
    }
  }

  // The income lines of a queued row, as the form needs them. One place, so the
  // opener, the renderer and the save all agree on how many lines there are.
  function incomeLines(r: PendingDocRow): { description?: string; quantity?: number; price?: number }[] {
    const income = (r.payload as { income?: unknown })?.income;
    return Array.isArray(income) ? (income as { description?: string; quantity?: number; price?: number }[]) : [];
  }

  // Which printed lines were supposed to name a guest and do not (owner spec
  // 2026-08-25). Derived on every render from the row we already hold — no
  // state, so it cannot go stale against an edit that just saved.
  //
  // STUDIOS is imported here and passed down, rather than reached for inside
  // missingGuestLines, so the studio list has exactly one home in the codebase
  // (@/lib/calendar/studios — the same list the calendar parser is handed).
  function missingGuest(r: PendingDocRow): number[] {
    return missingGuestLines(
      r.guests_by_line ?? [],
      incomeLines(r).map((l) => l.description),
      STUDIOS
    );
  }

  function openEdit(r: PendingDocRow) {
    setEditing(r.id);
    setEditAmount(r.amount === null ? "" : String(r.amount));
    const desc = (r.payload as { description?: string })?.description ?? "";
    setEditDesc(desc);
    setEditLines(incomeLines(r).map((l) => l.description ?? ""));
    setEditClient((r.payload as { client?: { id?: string } })?.client?.id ?? null);
    void loadMorningClients();
  }

  async function saveEdit(r: PendingDocRow) {
    const lines = incomeLines(r);
    const multi = lines.length > 1;

    // Only the changed lines are sent. An untouched line must not appear in the
    // audit trail as an edit, and the server refuses a no-op save outright.
    const changedLines = multi
      ? editLines
          .map((description, index) => ({ index, description: description.trim() }))
          .filter((l) => l.description !== (lines[l.index]?.description ?? ""))
      : [];
    if (multi && changedLines.some((l) => l.description.length === 0)) {
      setError("תיאור שורה לא יכול להיות ריק");
      return;
    }

    const amountNum = editAmount.trim() === "" ? undefined : Number(editAmount);
    if (!multi && amountNum !== undefined && !(amountNum > 0)) {
      setError("סכום חייב להיות מספר חיובי");
      return;
    }
    // only send the recipient when it actually moved — an unchanged pick must
    // not cost a live Morning lookup on every save
    const originalClient = (r.payload as { client?: { id?: string } })?.client?.id ?? null;
    const clientChanged = editClient !== null && editClient !== originalClient;
    if (multi && changedLines.length === 0 && !clientChanged) {
      setError("אין שינוי");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/documents/pending/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: r.id,
          // The two modes are mutually exclusive on the wire, exactly as the
          // server requires: a multi-line row sends neither amount nor
          // description, a single-line row sends no lines.
          ...(multi
            ? { ...(changedLines.length ? { lines: changedLines } : {}) }
            : { amount: amountNum, description: editDesc.trim() || undefined }),
          ...(clientChanged
            ? {
                morningClientId: editClient,
                morningClientName: morningClients?.find((c) => c.id === editClient)?.name,
              }
            : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "העריכה נכשלה");
        return;
      }
      setEditing(null);
      router.refresh();
    } catch {
      setError("שגיאת רשת");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="max-w-4xl mx-auto p-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-bold mb-1">מסמכים לאישור</h1>
        <a href="/documents/accrued" className="text-xs text-[var(--violet)] hover:underline">פרקים מסוכמים · פדיון →</a>
      </div>
      <p className="text-xs text-[var(--faint)] mb-4">
        שום מסמך לא יוצא למורנינג בלי אישור אנושי · סביבה: <span className="font-mono">{env}</span>
        {dryRun && <span className="mr-2 text-[var(--peak)] font-bold">DRY RUN — לא נשלח בפועל</span>}
      </p>

      {(critical > 0 || warning > 0) && (
        <div
          className={`mb-4 text-xs rounded-xl px-3 py-2 border ${
            critical > 0 ? "border-[var(--peak)] text-[var(--peak)]" : "border-[var(--warn)] text-[var(--warn)]"
          }`}
        >
          {critical > 0 && <div>🔴 {critical} מסמכים ממתינים מעל 72 שעות</div>}
          {warning > 0 && <div>🟡 {warning} מסמכים ממתינים מעל 24 שעות</div>}
        </div>
      )}

      {error && (
        <div className="mb-4 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2">{error}</div>
      )}

      {rows.length === 0 && (
        <div className="text-center text-sm text-[var(--faint)] py-12 border border-dashed border-[var(--rule)] rounded-2xl">
          אין מסמכים ממתינים לאישור
        </div>
      )}

      {Array.from(groups.entries()).map(([type, list]) => {
        const groupIds = list.filter((r) => r.status === "pending").map((r) => r.id);
        const allSelected = groupIds.length > 0 && groupIds.every((id) => selected.has(id));
        return (
          <section key={type} className="mb-8">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[10px] uppercase tracking-wider font-semibold text-[var(--faint)]">
                {TYPE_LABEL[type]} ({list.length})
              </h2>
              {/* bulk approval — the busy-day case. Never offered for tax
                  documents: each of those needs its own confirmation. */}
              {canApprove && !isTax(type) && groupIds.length > 1 && (
                <button
                  disabled={busy}
                  onClick={() =>
                    allSelected
                      ? send(groupIds, "approve")
                      : setSelected(new Set([...Array.from(selected), ...groupIds]))
                  }
                  className="text-[11px] rounded-xl px-3 py-1 border border-[var(--rule)] hover:bg-[var(--hover)] disabled:opacity-40"
                >
                  {allSelected ? `אשר את כל ${groupIds.length} המסמכים` : `בחר את כל ${groupIds.length}`}
                </button>
              )}
            </div>

            <div className="flex flex-col gap-2">
              {list.map((r) => (
                <div
                  key={r.id}
                  className={`rounded-2xl border p-3 ${
                    r.aging === "critical"
                      ? "border-[var(--peak)]"
                      : r.aging === "warning"
                      ? "border-[var(--warn)]"
                      : "border-[var(--rule)]"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {canApprove && r.status === "pending" && !isTax(r.doc_type) && (
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggle(r.id)}
                        className="mt-1"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm">{r.client_name}</span>
                        <span className="text-xs text-[var(--dim)]">{r.show_name}</span>
                        {r.record_date && <span className="text-xs font-mono text-[var(--faint)]">{r.record_date}</span>}
                        <span className="text-sm font-bold">{money(r.amount)}</span>
                        {r.aging && <span className="text-[10px]">{r.aging === "critical" ? "🔴" : "🟡"} {r.age_hours}ש׳</span>}
                        {r.status === "failed" && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-[var(--peak)] text-[var(--peak)]">
                            נכשל ×{r.attempts}
                          </span>
                        )}
                        {/* Distinct from "נכשל" on purpose: a failed row is a
                            known non-event and may simply be retried, while this
                            one is an UNKNOWN — the document may exist in Morning
                            under a number we never recorded. Same colour, because
                            both need attention; different words, because the
                            correct next action is not the same. */}
                        {r.status === "approved" && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-[var(--peak)] text-[var(--peak)]">
                            אושר ולא הונפק
                          </span>
                        )}
                      </div>
                      {r.last_error && <div className="mt-1 text-xs text-[var(--peak)]">{r.last_error}</div>}
                      {/* The guest flag, and it IS the way in to the edit form
                          (owner spec 2026-08-25). "ערוך לפני אישור" below has
                          always been here, but nothing on this screen ever told
                          the bookkeeper she had a reason to press it — the
                          printed line is not on the row at all, and the only way
                          to read it is the raw JSON behind "מה יישלח למורנינג".
                          So the warning is the button: one click from "something
                          is wrong" to the field that fixes it.

                          Rendered only when a real guest is really missing, so a
                          clean queue looks exactly as it did yesterday. */}
                      {canApprove && editing !== r.id && missingGuest(r).length > 0 && (
                        <button
                          onClick={() => openEdit(r)}
                          className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--warn)] border border-[var(--warn)] rounded-lg px-2 py-1"
                        >
                          <span>⚠️</span>
                          <span>אורח חסר בפירוט — בדקי לפני אישור</span>
                        </button>
                      )}
                      <div className="mt-1 flex items-center gap-3">
                        <button
                          onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                          className="text-[11px] text-[var(--faint)] underline"
                        >
                          {expanded === r.id ? "הסתר" : "מה יישלח למורנינג"}
                        </button>
                        {canApprove && editing !== r.id && (
                          <button onClick={() => openEdit(r)} className="text-[11px] text-[var(--faint)] underline">
                            ערוך לפני אישור
                          </button>
                        )}
                      </div>
                      {editing === r.id && (
                        <div className="mt-2 border border-[var(--rule)] rounded-xl p-2 flex flex-col gap-2">
                          {/* the recipient comes first: it is the context for
                              everything under it, not a detail of it */}
                          <div className="text-[11px]">
                            <span className="text-[var(--faint)]">נמען (לקוח מורנינג)</span>
                            {loadingClients && !morningClients ? (
                              <div className="mt-0.5 text-[var(--faint)]">טוען לקוחות ממורנינג…</div>
                            ) : (
                              <ClientCombobox
                                clients={morningClients ?? []}
                                value={editClient}
                                onChange={setEditClient}
                                morningCreate={false}
                                className="mt-0.5"
                                placeholder="— בחר נמען —"
                              />
                            )}
                            <div className="mt-0.5 text-[10px] text-[var(--faint)]">
                              שינוי הנמען משנה למי המסמך יוצא במורנינג. הסכומים והשורות לא משתנים, והחוב נשאר רשום על{" "}
                              {r.client_name}.
                            </div>
                          </div>
                          {incomeLines(r).length > 1 ? (
                            <>
                              <div className="text-[11px]">
                                <span className="text-[var(--faint)]">
                                  שורות פירוט ({incomeLines(r).length})
                                </span>
                                <div className="mt-0.5 flex flex-col gap-1">
                                  {incomeLines(r).map((l, i) => {
                                    // which line to fix, not merely that one of
                                    // them needs fixing — on a 4-episode bundle
                                    // the difference is the whole point
                                    const flagged = missingGuest(r).includes(i);
                                    const lineGuest = r.guests_by_line?.[i] ?? null;
                                    const suggestion = r.suggested_by_line?.[i] ?? null;
                                    return (
                                      <div key={i} className="flex flex-col gap-0.5">
                                        {/* The guest as READABLE TEXT, not a tooltip on a ⚠ glyph.
                                            It was already here, hidden in a title attribute — which
                                            meant the one person who needed it had to leave the
                                            screen and search the board by date to find a name the
                                            row was already holding. */}
                                        {flagged && <GuestHint guest={lineGuest} suggestion={suggestion} />}
                                        <div className="flex items-center gap-2">
                                          {flagged && (
                                            <span
                                              className="shrink-0 text-[var(--warn)]"
                                              title={`אורח ההפקה (${lineGuest ?? ""}) לא מופיע בשורה הזאת`}
                                            >
                                              ⚠
                                            </span>
                                          )}
                                          <input
                                            value={editLines[i] ?? ""}
                                            onChange={(e) =>
                                              setEditLines((prev) => {
                                                const next = [...prev];
                                                next[i] = e.target.value;
                                                return next;
                                              })
                                            }
                                            className={`flex-1 min-w-0 bg-transparent border rounded-lg px-2 py-1 ${
                                              flagged ? "border-[var(--warn)]" : "border-[var(--rule)]"
                                            }`}
                                          />
                                          <span className="shrink-0 font-mono text-[10px] text-[var(--faint)]">
                                            {l.quantity ?? 1} × {l.price ?? 0}
                                          </span>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                              <div className="text-[10px] text-[var(--faint)]">
                                הסכום ({r.amount ?? 0} ₪) וכותרת המסמך נגזרים מהעבודות שאוגדו ואינם נערכים כאן —
                                עריכה כאן משנה את הטקסט של השורות בלבד.
                              </div>
                            </>
                          ) : (
                            <>
                              <label className="text-[11px]">
                                <span className="text-[var(--faint)]">סכום (₪)</span>
                                <input
                                  type="number"
                                  value={editAmount}
                                  onChange={(e) => setEditAmount(e.target.value)}
                                  className="w-full mt-0.5 bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1"
                                />
                              </label>
                              <label className="text-[11px]">
                                <span className="text-[var(--faint)]">תיאור</span>
                                {missingGuest(r).includes(0) && (
                                  <GuestHint guest={r.guest} suggestion={r.suggested_by_line?.[0] ?? null} />
                                )}
                                <input
                                  value={editDesc}
                                  onChange={(e) => setEditDesc(e.target.value)}
                                  className={`w-full mt-0.5 bg-transparent border rounded-lg px-2 py-1 ${
                                    missingGuest(r).includes(0) ? "border-[var(--warn)]" : "border-[var(--rule)]"
                                  }`}
                                />
                              </label>
                            </>
                          )}
                          <div className="flex gap-2">
                            <button
                              disabled={busy}
                              onClick={() => saveEdit(r)}
                              className="text-[11px] bg-[var(--signal)] text-white font-bold rounded-lg px-3 py-1 disabled:opacity-40"
                            >
                              שמור
                            </button>
                            <button
                              onClick={() => setEditing(null)}
                              className="text-[11px] rounded-lg px-3 py-1 border border-[var(--rule)]"
                            >
                              ביטול
                            </button>
                          </div>
                        </div>
                      )}
                      {expanded === r.id && (
                        <pre className="mt-2 text-[10px] bg-[var(--hover)] rounded-xl p-2 overflow-x-auto" dir="ltr">
                          {JSON.stringify(r.payload, null, 2)}
                        </pre>
                      )}
                    </div>

                    {/* A stranded row gets NO actions. The server refuses both
                        approve and reject on it (ACTIONABLE_STATUSES), so any
                        button here could only produce an error — and offering
                        "דחה" on a document that may already exist in Morning is
                        the one click that would do real damage. What she needs
                        is not a button but the next step, so that is what is
                        rendered. */}
                    {canApprove && r.status === "approved" && (
                      <div className="shrink-0 max-w-[13rem] text-[11px] text-[var(--peak)] leading-snug">
                        ייתכן שהמסמך נוצר במורנינג — בדקי שם לפני כל פעולה
                      </div>
                    )}

                    {canApprove && r.status !== "approved" && (
                      <div className="flex flex-col gap-2 shrink-0">
                        <button
                          disabled={busy}
                          onClick={() => approveOne(r)}
                          className="bg-[var(--signal)] text-white text-xs font-bold rounded-xl px-4 py-1.5 disabled:opacity-40"
                        >
                          {r.status === "failed" ? "נסה שוב" : "אשר"}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => reject(r)}
                          className="text-xs rounded-xl px-4 py-1.5 border border-[var(--red)] text-[var(--red)] disabled:opacity-40"
                        >
                          דחה
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {canApprove && !isTax(type) && selected.size > 0 && groupIds.some((id) => selected.has(id)) && (
              <button
                disabled={busy}
                onClick={() => send(groupIds.filter((id) => selected.has(id)), "approve")}
                className="mt-3 bg-[var(--signal)] text-white text-xs font-bold rounded-xl px-4 py-2 disabled:opacity-40"
              >
                אשר {groupIds.filter((id) => selected.has(id)).length} מסמכים שנבחרו
              </button>
            )}
          </section>
        );
      })}

      {/* ---- the second gate for a tax document ---- */}
      {confirming && (() => {
        // The type that will actually be issued: for a 305/320 row that is the
        // variant chosen right here, for anything else it is what the row
        // already is. Everything below keys off THIS, never off taxVariant —
        // a receipt has no variant to read.
        const finalType = isTax(confirming.doc_type) ? taxVariant : confirming.doc_type;
        const finalCode = DOC_TYPE_TO_MORNING_CODE[finalType];
        const needsPayment = requiresPayment(finalCode);
        const isReceipt = finalCode === MORNING_DOC_CODE.receipt;
        // we cannot know the total until the parent has been pulled, and the
        // server will refuse for exactly the same reason — so say so here and
        // do not offer the button at all
        const grossUnknown = needsPayment && confirming.parent_gross === null;
        const paidNum = Number(payAmount);
        const paymentReady =
          !needsPayment ||
          (!grossUnknown && Number.isFinite(paidNum) && paidNum > 0 && /^\d{4}-\d{2}-\d{2}$/.test(payDate));
        const paymentRows = needsPayment
          ? [{
              type: payMethod,
              date: payDate,
              // verified on all 278 payment lines in the account: these two are
              // always the same number
              price: paidNum,
              amount: paidNum,
              currency: "ILS",
              currencyRate: 1,
            }]
          : undefined;

        return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-[var(--bg)] border border-[var(--rule)] rounded-2xl p-5 max-w-md w-full max-h-[88vh] overflow-y-auto">
            <h3 className="font-bold text-sm mb-3">{isReceipt ? "אישור הנפקת קבלה" : "אישור הנפקת מסמך מס"}</h3>
            <div className="text-sm space-y-1 mb-4">
              <div>
                <span className="text-[var(--faint)]">לקוח: </span>
                {confirming.client_name}
              </div>
              <div>
                <span className="text-[var(--faint)]">תוכנית: </span>
                {confirming.show_name}
              </div>
              <div>
                <span className="text-[var(--faint)]">סכום: </span>
                <span className="font-bold">{money(confirming.amount)}</span>
              </div>
              {/* only a 305/320 row has this choice — a receipt is what it is */}
              {isTax(confirming.doc_type) && (
                <label className="block pt-2">
                  <span className="text-[var(--faint)] text-xs">סוג המסמך</span>
                  <select
                    value={taxVariant}
                    onChange={(e) => setTaxVariant(e.target.value as "tax_receipt" | "tax_invoice")}
                    className="w-full mt-1 bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-sm"
                  >
                    {/* 305 first and default: it is the reversible one. 320 says
                        the money is in, and says it to the tax authority. */}
                    <option value="tax_invoice">חשבונית מס</option>
                    <option value="tax_receipt">חשבונית מס קבלה — הכסף התקבל</option>
                  </select>
                </label>
              )}
            </div>

            {/* ---- the money side, only for the types that declare it ---- */}
            {needsPayment && (
              <div className="border-t border-[var(--rule)] pt-3 mb-3">
                <div className="text-xs font-bold mb-2">פרטי התקבול</div>
                {grossUnknown ? (
                  /* The server's own sentence, or nothing. The default that used
                     to sit here guessed "the source document has not been pulled
                     from Morning yet" — and said it about a document that HAD
                     been pulled, whose raw held the amount, because the gross was
                     never read for a 305 row at all. A guessed diagnosis sends
                     the bookkeeper to wait for a sync that will not change a
                     thing. The trailing "issue after the next sync" went with it
                     for the same reason: the real errors already say what to do,
                     and for a parentless row a sync is not the answer. */
                  confirming.parent_gross_error ? (
                    <div className="text-[11px] text-[var(--warn)] border border-[var(--warn)] rounded-xl px-3 py-2 leading-relaxed">
                      {confirming.parent_gross_error}
                    </div>
                  ) : null
                ) : (
                  <div className="space-y-2">
                    <label className="block">
                      <span className="text-[var(--faint)] text-[11px]">אמצעי</span>
                      <select
                        value={payMethod}
                        onChange={(e) => setPayMethod(Number(e.target.value))}
                        className="w-full mt-1 bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-sm"
                      >
                        {PAYMENT_METHODS.map((m) => (
                          <option key={m.code} value={m.code}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-[var(--faint)] text-[11px]">סכום שהתקבל (ברוטו)</span>
                      <input
                        value={payAmount}
                        onChange={(e) => setPayAmount(e.target.value)}
                        inputMode="decimal"
                        className="w-full mt-1 bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-sm font-mono"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[var(--faint)] text-[11px]">תאריך התקבול</span>
                      <input
                        type="date"
                        value={payDate}
                        onChange={(e) => setPayDate(e.target.value)}
                        className="w-full mt-1 bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-sm font-mono"
                      />
                      <span className="text-[10px] text-[var(--faint)]">
                        מתי הכסף התקבל בפועל — לא בהכרח תאריך המסמך.
                      </span>
                    </label>
                  </div>
                )}
              </div>
            )}

            {/* The real thing, not a summary of it (owner spec 2026-08-06): the
                links that close the parents, the remark that gets PRINTED, and
                every income line. A tax document cannot be corrected once it is
                in Morning, so whatever is wrong has to be visible HERE.
                remarks and the description's label both re-render on the variant
                switch because the server rebuilds them — the three must never
                contradict each other. */}
            <TaxPayloadPreview
              payload={confirming.payload}
              finalType={finalType}
              gross={confirming.parent_gross}
              paid={needsPayment && Number.isFinite(paidNum) ? paidNum : null}
            />

            <div className="border-t border-[var(--rule)] pt-3 mb-2">
              <div className="text-xs font-bold mb-2">שליחה במייל</div>
              <RecipientPicker loading={loadingRecipients} data={recipientData} selected={selectedEmails} onToggle={toggleEmail} />
            </div>
            <p className="text-[11px] text-[var(--peak)] mb-4">
              מסמך מס אינו הפיך מהאפליקציה. ביטול מחייב חשבונית זיכוי במורנינג ישירות.
            </p>
            <div className="flex gap-2">
              <button
                disabled={busy || !paymentReady}
                onClick={() =>
                  send([confirming.id], "approve", {
                    confirmed: true,
                    tax_variant: taxVariant,
                    recipients: selectedEmails,
                    ...(paymentRows ? { payment: paymentRows } : {}),
                  })
                }
                className="flex-1 bg-[var(--signal)] text-white text-xs font-bold rounded-xl px-4 py-2 disabled:opacity-40"
              >
                כן, הנפק
              </button>
              <button
                disabled={busy}
                onClick={() => setConfirming(null)}
                className="flex-1 text-xs rounded-xl px-4 py-2 border border-[var(--rule)]"
              >
                ביטול
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* recipient picker for a non-tax document (owner spec 2026-07-29) */}
      {recipientFor && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-[var(--bg)] border border-[var(--rule)] rounded-2xl p-5 max-w-md w-full">
            <h3 className="font-bold text-sm mb-1">שליחת המסמך במייל</h3>
            <div className="text-xs text-[var(--faint)] mb-3">
              {recipientFor.client_name} · {TYPE_LABEL[recipientFor.doc_type]}
            </div>
            <RecipientPicker loading={loadingRecipients} data={recipientData} selected={selectedEmails} onToggle={toggleEmail} />
            <div className="flex gap-2">
              <button
                disabled={busy || loadingRecipients}
                onClick={submitRecipients}
                className="flex-1 bg-[var(--signal)] text-white text-xs font-bold rounded-xl px-4 py-2 disabled:opacity-40"
              >
                {selectedEmails.length ? "אשר ושלח" : "אשר בלי שליחה"}
              </button>
              <button
                disabled={busy}
                onClick={() => setRecipientFor(null)}
                className="flex-1 text-xs rounded-xl px-4 py-2 border border-[var(--rule)]"
              >
                ביטול
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
