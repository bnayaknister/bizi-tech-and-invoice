import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listClients, MorningError } from "@/lib/morning/client";
import type { MorningDocumentRequest } from "@/lib/morning/types";

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
//   1. MONEY IS LOCKED. A line edit changes text only. `amount` alongside
//      `lines` is refused rather than ignored — the column is Σ of the source
//      jobs, and per-line prices that no longer sum to it would be a silent
//      discrepancy between our books and Morning's.
//   2. THE TITLE IS INDEPENDENT. The single-line path writes one string to both
//      payload.description and income[0].description, which is right when there
//      is one line: the title IS the line. With N lines there is no line the
//      title could mirror, so it is left alone entirely.
//   3. ONE LINE MEANS THE OLD PATH. `lines` on a document with income.length<=1
//      is refused (see rule 2 — that document's title must keep moving with its
//      line, and only `description` does that).
//
// Validation is complete before anything is written: a bad index in the middle
// of the array leaves the row untouched rather than half-edited.

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
  };
  if (!body.id) return NextResponse.json({ error: "חסר מזהה מסמך" }, { status: 400 });

  const hasLines = Array.isArray(body.lines);
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
  if (hasLines && newDescription !== undefined) {
    // both write income[0]; letting them race inside one request would make the
    // winner an accident of statement order
    return NextResponse.json(
      { error: "לא ניתן לשלוח גם תיאור מסמך וגם עריכת שורות באותה בקשה" },
      { status: 400 }
    );
  }
  if (!hasAmount && !hasLines && newDescription === undefined && newMorningClientId === undefined) {
    return NextResponse.json({ error: "אין שינוי" }, { status: 400 });
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

  if (hasAmount) {
    payload.income = (payload.income ?? []).map((r, i) => (i === 0 ? { ...r, price: body.amount! } : r));
  }
  if (newDescription !== undefined) {
    payload.description = newDescription;
    payload.income = (payload.income ?? []).map((r, i) => (i === 0 ? { ...r, description: newDescription } : r));
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
    },
  });

  return NextResponse.json({ ok: true });
}
