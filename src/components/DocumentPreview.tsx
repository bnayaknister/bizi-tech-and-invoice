"use client";

import {
  DOC_TYPE_TO_MORNING_CODE,
  MORNING_DOC_CODE,
  MORNING_DOC_NAME,
  type MorningDocumentRequest,
  type PendingDocType,
} from "@/lib/morning/types";
import { BALANCE_EPSILON, sumIncome } from "@/lib/documents/lineBalance";

/**
 * The document as Morning will PRINT it, before it is issued.
 *
 * WHY A FACSIMILE AND NOT A SUMMARY. The queue row shows a client name and a
 * total; the payload behind it was readable only as raw LTR JSON. So the one
 * question the bookkeeper actually has at the moment of approval — "what does
 * this document say?" — had no answer on the screen, and a tax document cannot
 * be corrected after issuance.
 *
 * The structure below is not a design. It was read off 11 real PDFs pulled from
 * documents.pdf_url on 2026-09-07 (types 100/300/305/320/400, including
 * multi-line and withholding cases) and reproduced block for block: the order of
 * the blocks, the exact title wording per type, the column order, the summary
 * labels, and which blocks each type omits. A layout that merely LOOKS like a
 * document would teach the reader to trust a shape that is not the shape.
 *
 * WHAT IS DELIBERATELY NOT SHOWN AS A NUMBER. VAT and the gross total are
 * Morning's own arithmetic and do not exist until the nightly pull — POST
 * /documents returns no amount at all. Multiplying by 1.18 here would put a tax
 * rate inside our issuance path, which is exactly what parentGross.ts:16 refuses
 * to do, and would print a number nobody computed as though someone had. They
 * are placeholders instead (owner decision 2026-09-07).
 *
 * Everything Morning adds from its own account settings — the company block, the
 * bank line, the document number, the footer — is reproduced as static text or
 * as a placeholder, and is marked as such in the constants below.
 */

// ---- what Morning prints from ITS OWN account settings ---------------------
// Not in the payload, not in `raw` (raw.business carries flags only, no name or
// address). Copied verbatim off the PDFs pulled 2026-09-07 — 10326, 40269 and
// 60192 all print these bytes. If the owner changes them in Morning this block
// goes stale silently, which is the price of showing them at all; showing a
// document with no letterhead would misrepresent the page more.
const COMPANY_LINES = [
  'ביזי פודקלאב בע"מ',
  "עוסק מורשה (ח.פ): 517145926",
  "החשמונאים 105, תל אביב-יפו 6713320",
  "טלפון 0542242526 · נייד 0542242526",
  "bi-zi.co.il · eli@bi-zi.co.il",
];

// Same provenance, same caveat. Morning prints this beside "סה\"כ לתשלום" on a
// document that DECLARES A DEBT and omits it entirely on one that declares the
// money already arrived (verified: absent on 60192, 60020, 80063).
const BANK_LINE = "בנק 31, סניף 095, מס' חשבון 274203, מוטב: ביזי פודקלאב בע״מ";

// Paper, not the app's palette — the same reason the review-notes print page
// spells its colours out (review-notes/print/page.tsx:34). The card around this
// sheet is near-black; the sheet is a printed page.
const INK = "#111111";
const MUTED = "#6b7280";
const RULE = "#d4d4d4";
const RULE_SOFT = "#e8e8e8";
const ALARM = "#b91c1c";

/** ₪1,000.00 — sign attached, thousands separated, always two decimals. */
const sheetMoney = (n: number) =>
  "₪" + new Intl.NumberFormat("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

/**
 * DD/MM/YYYY — Morning's format on the page. Deliberately not the screen's own
 * formatter: this block is a reproduction, and the separator is the difference
 * between a facsimile and an approximation.
 *
 * NOT A DUPLICATE OF displayDate (lib/dates.ts), however identical it looks —
 * examined and kept 2026-09-10, when the screen-wide date unification folded
 * every other local formatter into that file and stopped here. The shapes
 * agree today by coincidence: displayDate is what WE decided screens should
 * show, this is what MORNING prints. They are independent variables, and
 * merging them would mean the next screen-format change silently restyles a
 * facsimile that a bookkeeper approves uncorrectable tax documents from.
 *
 * Note the pairing with the description block below (:195), which carries our
 * own authored work date in the OTHER document format (shortDate, dots). Both
 * formats on one sheet is not an inconsistency — it is what the real PDF does.
 * The full three-way rule is written out at the top of lib/dates.ts.
 */
function sheetDate(iso: string | undefined): string {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** A value Morning fills in and we cannot know yet. Never styled as a number. */
function Pending({ text, bold = false }: { text: string; bold?: boolean }) {
  return (
    <span style={{ color: MUTED, fontSize: 11, fontWeight: bold ? 700 : 400 }}>{text}</span>
  );
}

export default function DocumentPreview({
  payload,
  docType,
  amount,
}: {
  payload: MorningDocumentRequest;
  docType: PendingDocType;
  amount: number | null;
}) {
  const code = DOC_TYPE_TO_MORNING_CODE[docType];

  // Morning's vocabulary for the printed title, not ours. MORNING_DOC_NAME is
  // already the single source for it — read off 1,000 documents in the account
  // and used by sourceRemark and docDescriptionLabel for the same reason. A
  // sixth copy of "חשבונית מס / קבלה" is how a page ends up naming itself two
  // ways, which is the bug docDescriptionLabel exists to prevent.
  const title = MORNING_DOC_NAME[code] ?? "מסמך";

  // A receipt carries no income lines and no totals at all (0 of 63 in the
  // account do) — it jumps from the description straight to the payment block.
  const isReceipt = code === MORNING_DOC_CODE.receipt;
  // The money side prints on the two types that declare money actually moved.
  const showsPayment = code === MORNING_DOC_CODE.receipt || code === MORNING_DOC_CODE.tax_receipt;
  // ...and the bank line prints on exactly the complement: a document that says
  // "you already paid" does not tell anyone where to pay.
  const showsBank = !showsPayment;

  // The payload is a JSON blob typed by a cast at the call site, so the shape is
  // re-checked here rather than trusted.
  const income = Array.isArray(payload?.income) ? payload.income : [];
  const clientName =
    typeof payload?.client?.name === "string" && payload.client.name.trim() !== ""
      ? payload.client.name
      : "—";
  const description = typeof payload?.description === "string" ? payload.description : null;
  const remarks = typeof payload?.remarks === "string" && payload.remarks.trim() !== "" ? payload.remarks : null;

  // ONE arithmetic with the balance gate, imported rather than rewritten. The
  // edit form's own Σ was written separately and forgot to multiply by quantity,
  // which is precisely how a screen ends up contradicting the server it posts to.
  const net = sumIncome(income);
  const declared = amount === null ? null : Number(amount);
  const mismatch = declared !== null && income.length > 0 && Math.abs(net - declared) > BALANCE_EPSILON;

  return (
    <div
      dir="rtl"
      style={{
        background: "#ffffff",
        color: INK,
        border: `1px solid ${RULE}`,
        borderRadius: 10,
        padding: "22px 24px",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', Arial, sans-serif",
        fontSize: 12,
        lineHeight: 1.55,
      }}
    >
      {/* ---- 1. recipient (right) and document date (left) ------------------ */}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 24, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: MUTED }}>לכבוד:</div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{clientName}</div>
          {/* Morning prints the tax id, address and phone from ITS client
              record. None of the three is in the payload, and none is in
              raw.client either — so they cannot be shown before issuance, and
              saying so is more honest than leaving a gap that reads as "the
              client has no tax id". */}
          <div style={{ color: MUTED, fontSize: 10, marginTop: 2 }}>
            ח.פ · כתובת · טלפון — מרשומת הלקוח במורנינג
          </div>
        </div>
        <div style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          {sheetDate(payload?.date)}
        </div>
      </div>

      {/* ---- 2. title (right) and the company block (left) ------------------ */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 24,
          alignItems: "flex-start",
          marginTop: 20,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {title} <Pending text="מספר יינתן במורנינג" />
          </div>
          {/* a separate, smaller line on every one of the 11 PDFs */}
          <div style={{ color: MUTED, fontSize: 11 }}>מקור</div>
        </div>
        <div style={{ textAlign: "left", fontSize: 10, color: MUTED, whiteSpace: "nowrap" }}>
          {COMPANY_LINES.map((line, i) => (
            <div key={i} style={i === 0 ? { color: INK, fontWeight: 700, fontSize: 12 } : undefined}>
              {line}
            </div>
          ))}
        </div>
      </div>

      {/* ---- 3. description: the bold line ABOVE the item table ------------- */}
      <div style={{ marginTop: 22, fontWeight: 700, wordBreak: "break-word" }}>
        {description ?? "—"}
      </div>

      {/* ---- 4. the item table (every type except a receipt) ---------------- */}
      {/* No מק"ט column: it prints only when a line carries catalogNum, and we
          never send one. */}
      {!isReceipt && (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12, fontSize: 11 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${RULE}` }}>
              <th style={{ textAlign: "center", fontWeight: 400, color: MUTED, padding: "4px 6px", width: "8%" }}>
                כמות
              </th>
              <th style={{ textAlign: "right", fontWeight: 400, color: MUTED, padding: "4px 6px" }}>פירוט</th>
              <th style={{ textAlign: "left", fontWeight: 400, color: MUTED, padding: "4px 6px", width: "20%" }}>
                מחיר
              </th>
              <th style={{ textAlign: "left", fontWeight: 400, color: MUTED, padding: "4px 6px", width: "20%" }}>
                סה״כ
              </th>
            </tr>
          </thead>
          <tbody>
            {income.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: "10px 6px", color: MUTED }}>
                  — אין שורות פירוט
                </td>
              </tr>
            )}
            {income.map((line, i) => {
              // `quantity ?? 1` for the same reason sumIncome does it: a row
              // that omits it means one unit, never zero.
              const qty = Number(line?.quantity ?? 1);
              const price = Number(line?.price ?? 0);
              return (
                <tr key={i} style={{ borderBottom: `1px solid ${RULE_SOFT}` }}>
                  <td
                    style={{
                      textAlign: "center",
                      padding: "7px 6px",
                      verticalAlign: "middle",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {Number.isFinite(qty) ? qty : "—"}
                  </td>
                  <td style={{ textAlign: "right", padding: "7px 6px", wordBreak: "break-word" }}>
                    {typeof line?.description === "string" && line.description.trim() !== ""
                      ? line.description
                      : "—"}
                  </td>
                  <td
                    style={{
                      textAlign: "left",
                      padding: "7px 6px",
                      verticalAlign: "middle",
                      whiteSpace: "nowrap",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {Number.isFinite(price) ? sheetMoney(price) : "—"}
                  </td>
                  <td
                    style={{
                      textAlign: "left",
                      padding: "7px 6px",
                      verticalAlign: "middle",
                      whiteSpace: "nowrap",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {Number.isFinite(price) && Number.isFinite(qty) ? sheetMoney(price * qty) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* ---- 5 + 6. the bank line (right) and the summary rows (left) ------- */}
      {!isReceipt && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            gap: 24,
            marginTop: 14,
          }}
        >
          {/* Morning prints this on the same line as "סה״כ לתשלום". */}
          <div style={{ fontSize: 10, color: MUTED, maxWidth: "55%" }}>{showsBank ? BANK_LINE : ""}</div>
          <div style={{ width: 250, flexShrink: 0 }}>
            <SummaryRow label="סה״כ" value={sheetMoney(net)} />
            {/* The label carries the rate because Morning's does. The VALUE is
                Morning's arithmetic and does not exist yet — see the header. */}
            <SummaryRow label="מע״מ 18%" value={<Pending text="יחושב במורנינג" />} />
            <div style={{ height: 6 }} />
            <SummaryRow label="סה״כ לתשלום" value={<Pending text="יחושב במורנינג" bold />} bold />
            {/* The lines and the amount column are two independent statements of
                the same money. When they disagree the row cannot be approved
                (lineBalance.ts), so the disagreement belongs on the page rather
                than in a refusal the bookkeeper meets after clicking. */}
            {mismatch && (
              <div style={{ color: ALARM, fontSize: 10, marginTop: 4, textAlign: "left" }}>
                סכום המסמך: {sheetMoney(declared!)} — אינו תואם את שורות הפירוט
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---- 7. payment details, on the two types that carry them ----------- */}
      {showsPayment && (
        <div style={{ marginTop: 20, borderTop: `1px solid ${RULE_SOFT}`, paddingTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>פרטי תשלומים</div>
          {/* The payment block is built in the approval modal and posted with
              the approve request — it is not on the queued payload, so there is
              nothing real to render here yet. */}
          <div style={{ color: MUTED, fontSize: 11 }}>פרטי התשלום יוצגו לפי מה שנרשם במורנינג</div>
        </div>
      )}

      {/* ---- 8. remarks: below every table, above the footer ---------------- */}
      {remarks && (
        <div style={{ marginTop: 20, wordBreak: "break-word" }}>{remarks}</div>
      )}

      {/* ---- 9. footer ------------------------------------------------------ */}
      <div style={{ marginTop: 22, borderTop: `1px solid ${RULE_SOFT}`, paddingTop: 8, fontSize: 10, color: MUTED }}>
        {title} · מספר יינתן במורנינג
      </div>
    </div>
  );
}

/** One summary row: label on the right, figure on the left. */
function SummaryRow({
  label,
  value,
  bold = false,
}: {
  label: string;
  value: React.ReactNode;
  bold?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        fontWeight: bold ? 700 : 400,
        fontSize: bold ? 13 : 11,
      }}
    >
      <span>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}
