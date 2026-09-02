import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { balanceError } from "@/lib/documents/lineBalance";
import { listClients, MorningError } from "@/lib/morning/client";
import type { MorningDocumentRequest, MorningIncomeRow } from "@/lib/morning/types";

// "ערוך פרטים לפני אישור" (owner spec) — the bookkeeper corrects a queued
// document before it's issued. Amount, description and the RECIPIENT.
//
// The recipient was deliberately NOT editable here until 2026-08-02, and the
// reason was sound as far as it went: the client is set by the mapping and the
// type by the flow, so letting a document name someone else looked like a way
// to bill the wrong party by accident. What overturned it is the account's own
// history — the registry holds eight documents where a child names a different
// recipient than its parent, across four parent/child pairs (ניקסון
// מדיקונסלט → טל מדיקל three times alone), on both the 100→300 and the
// 300→320 hops. It is a normal, deliberate act in this business: the work is
// ordered by one entity and invoiced to another. Refusing it here did not
// prevent the situation, it only pushed the bookkeeper into Morning to fix it
// by hand, outside the queue and outside the audit trail.
//
// So the recipient is editable, under three rules:
//   1. `add: false` stays hard-wired. A document must never create a client in
//      Morning (owner rule 2026-07-19) — that is never the caller's to decide.
//   2. The id must exist in Morning's LIVE client list, checked on every save.
//      A stale id from a cached picker would be rejected by Morning at issue
//      time, when it is far more expensive to discover.
//   3. Only payload.client moves. `pending_documents.client_id` — our FK —
//      stays on whoever owes the money. This is the deliberate split: the
//      documents registry mirrors Morning, `invoices` mirrors the debt, and a
//      gap between them on a document with a different recipient is intended,
//      not drift. Nothing downstream is re-pointed.
//
// Editable only while the row is still pending or failed (a failed row is
// often edited before a retry). An approved/issued row is frozen — its
// document already exists or is being created.
//
// The payload stored on the row is what will be POSTed to Morning, so the
// edit rewrites it in lockstep with the amount column: income[0].price, both
// description fields and client, nothing else, so a hand-edit can't reshape
// the request into something unexpected. income is never touched by a
// recipient change — the amounts are frozen, only who receives them moves.
//
// ---------------------------------------------------------------------------
// MULTI-LINE EDITING (`lines`) — added 2026-08-20
// ---------------------------------------------------------------------------
// A bundled deal invoice carries one income line per episode. Everything above
// this point addresses income[0] and only income[0], so on a 4-episode bundle
// three of the four lines were unreachable — the bookkeeper's only recourse was
// to fix them by hand in Morning, outside the queue and outside the audit trail.
// That is the same failure the recipient rule above was written to end.
//
// `lines` is a SEPARATE branch, not a generalisation of the one above. The old
// path is not modified, not wrapped, and not re-entered: a request without
// `lines` runs the exact code it ran yesterday. Three rules make the new branch
// safe to stand beside it:
//
//   1. MONEY IS LOCKED. A line edit changes text only. `amount` on a bundled
//      document is refused rather than ignored — the column is Σ of the source
//      jobs, and per-line prices that no longer sum to it would be a silent
//      discrepancy between our books and Morning's. (Stated here as "alongside
//      `lines`" until 2026-09-02, which was the rule half-enforced: see the
//      amount gate further down, keyed on the document's own income length.)
//   2. THE TITLE IS INDEPENDENT. The single-line path writes one string to both
//      payload.description and income[0].description, which is right when there
//      is one line: the title IS the line. With N lines there is no line the
//      title could mirror, so it mirrors into none of them.
//   3. ONE LINE MEANS THE OLD PATH. `lines` on a document with income.length<=1
//      is refused (see rule 2 — that document's title must keep moving with its
//      line, and only `description` does that).
//
// Validation is complete before anything is written: a bad index in the middle
// of the array leaves the row untouched rather than half-edited.
//
// ---------------------------------------------------------------------------
// THE TITLE ON A MULTI-LINE DOCUMENT — 2026-09-02
// ---------------------------------------------------------------------------
// Rule 2 said the title is "left alone entirely" on a multi-line row, and that
// was true of INTENT but not of CODE: the description branch mirrored into
// income[0] unconditionally, so sending a title to a 5-line bundle overwrote
// the first episode's line with the heading. Nothing did — the multi-line form
// sent no `description` — so it was latent, never fired.
//
// It is closed here because the field is now EXPOSED beside the line editor.
// The bookkeeper needs her own heading ("הפקת חומרים שיווקיים אוגוסט") on a
// consolidated 320, whose lines are inherited verbatim from the work order
// and still read "הזמנת עבודה — …". Title and lines are now genuinely
// independent: `description` writes the heading and never a line, `lines`
// writes lines and never the heading, and the two remain mutually exclusive in
// one request so neither can race the other.
//
// The money rule is not relaxed by any of this — it is TIGHTENED. Rule 1 was
// only ever enforced against `amount` + `lines` in one request, which is the
// shape the screen produces; `amount` alone on a bundle slipped through and
// wrote income[0]. Both are refused now, keyed on the document rather than on
// the request. A single-line row's amount is still editable, as it must be.

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    amount?: number;
    description?: string;
    morningClientId?: string;
    // sent for the caller's own bookkeeping only — the authoritative name comes
    // from the live list below, never from the request
    morningClientName?: string;
    // multi-line mode — see the block comment above
    lines?: { index?: number; description?: string }[];
    // MERGE MODE (owner spec 2026-09-02) — the FULL replacement line set.
    // Separate from `lines` on purpose, see the block comment above.
    replace_lines?: { description?: string; price?: number; quantity?: number }[];
  };
  if (!body.id) return NextResponse.json({ error: "חסר מזהה מסמך" }, { status: 400 });

  const hasLines = Array.isArray(body.lines);
  const hasReplace = Array.isArray(body.replace_lines);
  if (hasLines && hasReplace) {
    // one describes a patch, the other the final state; together they have no
    // single meaning and the winner would be an accident of statement order
    return NextResponse.json(
      { error: "לא ניתן לשלוח גם עריכת שורות וגם החלפת שורות באותה בקשה" },
      { status: 400 }
    );
  }
  // `amount` alongside `lines` stays refused: a text-only edit must never move
  // money. Alongside `replace_lines` it is REQUIRED (see the balance gate) —
  // that is the whole point of merge mode, and the two numbers are checked
  // against each other rather than either being trusted alone.
  if (hasLines && typeof body.amount === "number") {
    return NextResponse.json(
      { error: "לא ניתן לערוך סכום בעריכה רב-שורתית — הסכום נגזר מהעבודות שאוגדו" },
      { status: 400 }
    );
  }

  const hasAmount = typeof body.amount === "number";
  const newDescription = typeof body.description === "string" ? body.description.trim() : undefined;
  const newMorningClientId =
    typeof body.morningClientId === "string" && body.morningClientId.trim() !== ""
      ? body.morningClientId.trim()
      : undefined;
  // `lines` + `description` together used to be refused here, because both
  // wrote income[0] and the winner would have been an accident of statement
  // order. As of 2026-09-02 the description branch mirrors into a line ONLY on
  // a single-line document, and `lines` is refused outright on one — so on the
  // only document type where both can appear, they write disjoint things and
  // there is nothing left to race.
  //
  // Removing the refusal is what lets the bookkeeper fix the inherited line
  // texts AND set her own heading in ONE save. Two requests would have meant
  // two audit entries and a window where the lines were saved and the title was
  // not — on a document that cannot be corrected after it is issued.
  //
  // `lines` on a single-line row is still refused, just later and with a better
  // sentence: the income-length gate below names the real reason.
  if (!hasAmount && !hasLines && !hasReplace && newDescription === undefined && newMorningClientId === undefined) {
    return NextResponse.json({ error: "אין שינוי" }, { status: 400 });
  }
  // merge mode restates the whole money side, so the amount must be restated
  // with it — there is no "keep whatever the column said" that could be
  // verified against the new lines
  if (hasReplace && !hasAmount) {
    return NextResponse.json(
      { error: "החלפת שורות מחייבת גם את סכום המסמך, כדי שהשניים ייבדקו זה מול זה" },
      { status: 400 }
    );
  }
  if (hasAmount && (!(body.amount! > 0) || !Number.isFinite(body.amount))) {
    return NextResponse.json({ error: "סכום חייב להיות מספר חיובי" }, { status: 400 });
  }
  if (newDescription !== undefined && newDescription.length === 0) {
    return NextResponse.json({ error: "תיאור לא יכול להיות ריק" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("pending_documents")
    .select("id,status,amount,payload,client_id")
    .eq("id", body.id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "המסמך לא נמצא" }, { status: 404 });
  if (row.status === "issued") {
    // an issued Morning document is immutable — there is no update endpoint
    // (owner rule 2026-07-21). The real-world fix is manual, in Morning.
    return NextResponse.json(
      { error: "מסמך שהונפק אינו ניתן לעריכה במורנינג — יש לבטל/לזכות ולהנפיק מחדש שם ישירות" },
      { status: 409 }
    );
  }
  if (row.status !== "pending" && row.status !== "failed") {
    return NextResponse.json({ error: `לא ניתן לערוך מסמך בסטטוס ${row.status}` }, { status: 409 });
  }

  const beforeClient = (row.payload as MorningDocumentRequest)?.client;
  const before = {
    amount: row.amount,
    description: (row.payload as MorningDocumentRequest)?.description,
    morning_client_id: beforeClient?.id ?? null,
    morning_client_name: beforeClient?.name ?? null,
  };

  const payload = { ...(row.payload as MorningDocumentRequest) };

  // ---- the amount is not editable on a BUNDLE, however it is asked for ------
  // The parse-time refusal above only catches `amount` arriving WITH `lines`.
  // That was the shape the screen could produce, so it read as complete — but
  // the rule it was enforcing is about the DOCUMENT, not about the request:
  // a bundled row's amount column is Σ of the source jobs, and only the jobs
  // may move it.
  //
  // `{ id, amount: 9999 }` alone, with no `lines`, walked straight past it and
  // into the income[0] write below: on a 5-episode bundle that set the first
  // line to 9,999 and left four at 600, so the payload summed to 12,399 while
  // the column said 9,999. Our books and Morning's would have disagreed on the
  // same document, and on a 320 that is unrecoverable.
  //
  // Keyed on the ROW's income length rather than on what the request happens to
  // contain, which is why it can only live here — parse time cannot know how
  // many lines the document has. The single-line path is untouched: there the
  // amount and the one line are the same money and editing it is the point.
  //
  // QUALIFIED 2026-09-02, not lifted. Merge mode restates the lines and the
  // amount together and the balance gate below proves they agree, so the thing
  // this refusal protects against — a number moving with nothing to check it
  // against — cannot happen there. `amount` alone on a bundle is still refused,
  // exactly as it was.
  const incomeLen = Array.isArray(payload.income) ? payload.income.length : 0;
  if (hasAmount && incomeLen > 1 && !hasReplace) {
    return NextResponse.json(
      {
        error:
          `הסכום במסמך מאוגד נגזר מהעבודות שאוגדו ואינו נערך — למסמך ${incomeLen} שורות פירוט. ` +
          "לתיקון טקסט השורות יש להשתמש בעריכת השורות; לשינוי סכום יש לתקן את העבודות שאוגדו.",
      },
      { status: 400 }
    );
  }

  // ---- MERGE MODE: the full replacement line set ----------------------------
  // `lines` is a patch map keyed by index and can never change the line COUNT
  // (its output is always payload.income.map(...)). Merging five episode lines
  // into one — the bookkeeper's "הפקת חומרים שיווקיים אוגוסט, 3,000 ₪" — needs
  // a shape that states the FINAL set, so deleting is expressible at all.
  //
  // A replacement array rather than a delete flag on an index, because a
  // per-index delete depends on evaluation order (delete 1 and 3 of 5 — before
  // or after each renumbering?) while a final-state array has one reading and
  // is the same object the balance check runs on.
  //
  // MERGE ONLY, by owner decision 2026-09-02: refused on a single-line document.
  // The contract would support splitting one line into several for free, but
  // nobody has asked for it and an unexercised path through the money side is
  // not worth carrying. One guard, reversible the day it is wanted.
  let replacementIncome: MorningIncomeRow[] | null = null;
  if (hasReplace) {
    const existing = Array.isArray(payload.income) ? payload.income : [];
    if (existing.length <= 1) {
      return NextResponse.json(
        {
          error:
            existing.length === 0
              ? "מסמך זה אינו נושא שורות פירוט"
              : "פיצול שורה בודדת לכמה שורות אינו נתמך — החלפת שורות מיועדת לאיחוד מסמך מאוגד",
        },
        { status: 400 }
      );
    }
    const sent = body.replace_lines!;
    if (sent.length === 0) {
      // income is required on everything except a receipt (the review route's
      // own gate), and a receipt never reaches here — it has no lines to replace
      return NextResponse.json(
        { error: "לא ניתן למחוק את כל שורות הפירוט — מסמך חייב לשאת לפחות שורה אחת" },
        { status: 400 }
      );
    }
    if (sent.length > existing.length) {
      return NextResponse.json(
        { error: `החלפת שורות מיועדת לאיחוד — אי אפשר להגדיל מ-${existing.length} ל-${sent.length} שורות` },
        { status: 400 }
      );
    }
    const built: MorningIncomeRow[] = [];
    for (let i = 0; i < sent.length; i++) {
      const raw = sent[i];
      const description = typeof raw?.description === "string" ? raw.description.trim() : "";
      if (description.length === 0) {
        return NextResponse.json({ error: `תיאור שורה ${i + 1} לא יכול להיות ריק` }, { status: 400 });
      }
      const price = Number(raw?.price);
      // >= 0, not > 0: a zero line is legitimate (a free episode inherited from
      // a work order), and refusing it would be inventing a rule
      if (!Number.isFinite(price) || price < 0) {
        return NextResponse.json({ error: `מחיר שורה ${i + 1} אינו תקין` }, { status: 400 });
      }
      const quantity = raw?.quantity === undefined ? 1 : Number(raw.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) {
        return NextResponse.json({ error: `כמות שורה ${i + 1} אינה תקינה` }, { status: 400 });
      }
      // currency/vatType are carried from the row being replaced, never from the
      // request: they are facts about the document, not about this edit
      const template = existing[Math.min(i, existing.length - 1)];
      built.push({
        description,
        quantity,
        price: Number(price.toFixed(2)),
        currency: template?.currency ?? "ILS",
        vatType: template?.vatType ?? 0,
      });
    }
    replacementIncome = built;
  }

  // ---- multi-line validation: everything, before anything is written --------
  // Resolved here rather than at parse time because every rule needs the row:
  // how many lines it has, and what each one currently says.
  type LineEdit = { index: number; description: string; before: string | null };
  let lineEdits: LineEdit[] = [];
  if (hasLines) {
    const existing = Array.isArray(payload.income) ? payload.income : [];
    if (existing.length === 0) {
      // a receipt (400) carries no income lines at all — 0 of 61 in the account
      return NextResponse.json({ error: "מסמך זה אינו נושא שורות פירוט" }, { status: 400 });
    }
    if (existing.length === 1) {
      // rule 3: one line means the title and the line are the same thing, and
      // only `description` keeps them together
      return NextResponse.json(
        { error: "למסמך יש שורת פירוט אחת — ערוך אותה דרך שדה התיאור, כדי שכותרת המסמך תתעדכן איתה" },
        { status: 400 }
      );
    }
    if (body.lines!.length === 0) {
      return NextResponse.json({ error: "לא נשלחו שורות לעריכה" }, { status: 400 });
    }

    const seen = new Set<number>();
    for (const raw of body.lines!) {
      const index = raw?.index;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= existing.length) {
        return NextResponse.json(
          { error: `שורה ${String(index)} אינה קיימת במסמך (יש ${existing.length} שורות)` },
          { status: 400 }
        );
      }
      if (seen.has(index)) {
        return NextResponse.json({ error: `שורה ${index + 1} נשלחה פעמיים` }, { status: 400 });
      }
      seen.add(index);
      const description = typeof raw?.description === "string" ? raw.description.trim() : "";
      if (description.length === 0) {
        return NextResponse.json({ error: `תיאור שורה ${index + 1} לא יכול להיות ריק` }, { status: 400 });
      }
      lineEdits.push({ index, description, before: existing[index]?.description ?? null });
    }
    // a save that changes nothing is not an error worth blocking, but it must
    // not leave an audit entry claiming an edit happened
    lineEdits = lineEdits.filter((l) => l.description !== l.before);
    if (lineEdits.length === 0 && newMorningClientId === undefined) {
      return NextResponse.json({ error: "אין שינוי" }, { status: 400 });
    }
  }

  // Resolve the recipient against Morning's live list before writing anything.
  // Read-only, so it runs for real even in DRY_RUN — a picker validated against
  // stale data is worse than no validation.
  if (newMorningClientId !== undefined) {
    let morning;
    try {
      morning = await listClients();
    } catch (e) {
      const err = e instanceof MorningError ? e : null;
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "שליפת לקוחות ממורנינג נכשלה", status: err?.status ?? null },
        { status: 502 }
      );
    }
    const match = morning.find((c) => c.id === newMorningClientId);
    if (!match) {
      return NextResponse.json(
        { error: "לקוח מורנינג זה לא קיים ברשימה החיה — רענן את הרשימה ובחר מחדש" },
        { status: 400 }
      );
    }
    // the name is taken from Morning, not from the request, so the payload can
    // never carry a label that disagrees with the id it is paired with. `add`
    // is written here, hard-wired — it is not part of the request body.
    payload.client = { id: match.id, name: match.name, add: false };
  }

  // merge mode replaces the whole set outright — the single-line price write
  // below is the OTHER path and must not also run
  if (replacementIncome) {
    payload.income = replacementIncome;
  } else if (hasAmount) {
    payload.income = (payload.income ?? []).map((r, i) => (i === 0 ? { ...r, price: body.amount! } : r));
  }
  if (newDescription !== undefined) {
    payload.description = newDescription;
    // MIRROR INTO THE LINE ONLY WHEN THERE IS EXACTLY ONE.
    //
    // With one line the title and the line are the same string — that is rule 3
    // above, and why a single-line row is refused the `lines` branch. Writing
    // both keeps them together, and that behaviour is unchanged.
    //
    // With SEVERAL lines each one names its own episode, and line 0 is not a
    // title in any sense — it is the first episode. Mirroring there overwrote
    // "דעה לא פופולרית · עידן טנדלר · 02.08.26" with the document's heading and
    // deleted that episode from the printed page, silently, while the amount
    // column still counted it. On a 320 that is unrecoverable: a tax document
    // cannot be corrected after issuance, only credited.
    //
    // Nothing reached this state through the screen — the multi-line form never
    // sent `description` — so this is a latent path being closed before the
    // field is exposed beside it, not a live bug being cleaned up.
    const lineCount = Array.isArray(payload.income) ? payload.income.length : 0;
    if (lineCount === 1) {
      payload.income = (payload.income ?? []).map((r, i) => (i === 0 ? { ...r, description: newDescription } : r));
    }
  }

  // Multi-line: TEXT only, on the named lines only. price/quantity/currency/
  // vatType ride through untouched, payload.description is not referenced, and
  // the amount column is never patched — see rules 1 and 2 above.
  if (lineEdits.length) {
    const byIndex = new Map(lineEdits.map((l) => [l.index, l.description]));
    payload.income = (payload.income ?? []).map((r, i) =>
      byIndex.has(i) ? { ...r, description: byIndex.get(i)! } : r
    );
  }

  const patch: Record<string, unknown> = { payload };
  if (hasAmount) patch.amount = body.amount;

  // ---- the balance gate ----------------------------------------------------
  // Σ(price × quantity) must equal the amount column. Checked on the FINAL
  // payload, after every branch above has had its say, so one gate covers merge
  // mode, the single-line price write and the text-only path alike — and a
  // future branch cannot slip past it by being written somewhere else.
  //
  // It stops the save while the bookkeeper is still on the form and can fix it.
  // The same rule is enforced again in the review route, where it is the real
  // wall: a row can reach approval by paths that never touch this file.
  const editBalance = balanceError(payload.income, (patch.amount as number | undefined) ?? row.amount);
  if (editBalance) return NextResponse.json({ error: editBalance }, { status: 400 });

  const { error } = await admin.from("pending_documents").update(patch).eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: body.id,
    event_type: "document_edited",
    actor_id: user.id,
    payload: {
      before,
      after: {
        amount: hasAmount ? body.amount : row.amount,
        description: payload.description,
        morning_client_id: payload.client?.id ?? null,
        morning_client_name: payload.client?.name ?? null,
      },
      // the FK deliberately does not move with the recipient — recorded so the
      // gap is legible later as a decision, not as a bug
      owes_client_id: row.client_id,
      // present only on the multi-line branch. `before`/`after` above stay the
      // shape they have always been, so nothing that reads this event has to
      // learn a second one to keep working.
      ...(hasLines
        ? {
            mode: "lines",
            lines: lineEdits.map((l) => ({ index: l.index, before: l.before, after: l.description })),
          }
        : {}),
      // merge mode records BOTH line sets in full. A deleted line leaves no
      // trace anywhere else — there is no index to point at afterwards — so if
      // this event does not carry the old set, the money that used to be on
      // those lines is unreconstructable.
      ...(replacementIncome
        ? {
            mode: "replace_lines",
            income_before: (row.payload as MorningDocumentRequest)?.income ?? [],
            income_after: replacementIncome,
          }
        : {}),
    },
  });

  return NextResponse.json({ ok: true });
}
