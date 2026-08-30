import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import DocumentsClient, { type PendingDocRow } from "./DocumentsClient";
import { isDryRun, morningEnv } from "@/lib/morning/client";
import { DOC_TYPE_TO_MORNING_CODE, requiresPayment, type PendingDocType } from "@/lib/morning/types";
import { sumParentGross } from "@/lib/documents/parentGross";
import { buildLineItemText } from "@/lib/documents/enqueue";

export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_money) redirect("/");

  const admin = createAdminClient();
  const { data } = await admin
    .from("pending_documents")
    .select(
      "id,doc_type,status,amount,created_at,payload,reject_reason,last_error,attempts," +
        "client_id,production_id,job_id,clients(name),productions(podcast_name,record_date,guest,studio)"
    )
    // 'approved' is here because it is a status nothing should ever rest in
    // (owner 2026-08-25). The review route writes it immediately before calling
    // Morning; issue.ts then moves the row to 'issued' or 'failed'. A row still
    // sitting in 'approved' means the process died in that window — a Vercel
    // kill on a hung call, a deploy mid-request — and the document may or may
    // not exist in Morning. Until now such a row appeared on NO screen: the
    // queue read pending/failed, and the radar's aging alert counts 'pending'
    // only. It is surfaced rather than auto-retried on purpose, because a retry
    // would issue a second document if the first one landed.
    .in("status", ["pending", "failed", "approved"])
    .order("created_at", { ascending: true });

  // A 320 or a 400 declares money that moved, and the payment block it carries
  // has to total the gross Morning computed on the parent. Read that here, once,
  // through the SAME helper the approval gate uses — the modal must not show a
  // figure the server would then reject.
  //
  // Read for every row that COULD need it at approval, which is not the same as
  // every row that needs it as stored. A tax row is always queued as 305
  // (DEFAULT_TAX_VARIANT — this app creates nothing else), and the bookkeeper
  // flips it to 320 in the modal. Keying this off the STORED type meant the
  // gross was never read for the one path that ends up needing it: choosing 320
  // left parent_gross null, the modal called that "the parent has not been
  // pulled yet" — about a parent that had been pulled, whose raw carried the
  // amount all along — and disabled the issue button. No 320 could be approved
  // at all. Same defect family as the description label: a value derived from
  // what the row IS instead of from what it is about to BECOME.
  //
  // One read each, and this queue holds pending/failed rows only, so widening
  // it costs a handful of lookups.
  const mayCarryPayment = (docType: PendingDocType): boolean =>
    requiresPayment(DOC_TYPE_TO_MORNING_CODE[docType]) || docType === "tax_invoice";

  const grossByRow = new Map<string, { gross: number | null; error: string | null }>();
  for (const r of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    if (!mayCarryPayment(r.doc_type as PendingDocType)) continue;
    const payload = (r.payload ?? {}) as { linkedDocumentIds?: string[] };
    const linked = Array.isArray(payload.linkedDocumentIds) ? payload.linkedDocumentIds : [];
    if (!linked.length) {
      grossByRow.set(r.id as string, { gross: null, error: "למסמך אין מסמך מקור — לא ניתן לאמת את סכום התקבול" });
      continue;
    }
    const res = await sumParentGross(admin, linked);
    grossByRow.set(r.id as string, res.ok ? { gross: res.gross, error: null } : { gross: null, error: res.error });
  }

  // The guest behind each printed line, index-aligned to payload.income, for
  // the guest-missing flag (owner spec 2026-08-25). See @/lib/documents/guestFlag.
  //
  // A production-anchored row answers this from the join it already does, and
  // that is the whole no-migration story: the guest is NOT on the payload —
  // buildDocumentPayload never took one, so the only guest a payload carries is
  // the substring inside the line, which is the thing under test. The
  // productions join is the source of truth, and this page was already reading
  // it.
  //
  // A BUNDLE has no production of its own (createWorkOrderBundle writes
  // production_id: null), so its lines are resolved from the rows it folded.
  // Matched by the line's own TEXT, never by array position: the bundle copies
  // `rows.flatMap(r => r.payload.income)` verbatim, but the redeem route reads
  // those rows with no ORDER BY, so the order that built the bundle is not one
  // this page can reproduce. The text is copied byte for byte and is the only
  // stable key between the two.
  // Alongside the guest, the line the enqueue WOULD have written — offered as
  // text to copy, never auto-filled (owner spec 2026-08-30). Built with
  // buildLineItemText, the same function that writes the real line, so the
  // suggestion cannot drift from the standard it is suggesting. Server-side
  // rather than in the client component: the helper lives in enqueue.ts, and
  // importing that into a "use client" file drags its whole module graph into
  // the browser bundle to format one string.
  const suggestedByLine = new Map<string, (string | null)[]>();
  const guestsByLine = new Map<string, (string | null)[]>();
  const bundleRows = ((data ?? []) as unknown as Array<Record<string, unknown>>).filter(
    (r) => r.production_id === null && r.doc_type === "work_order"
  );
  for (const r of bundleRows) {
    const lines = (((r.payload as { income?: { description?: string }[] })?.income ?? []) as {
      description?: string;
    }[]);
    if (!lines.length) continue;
    const { data: sources } = await admin
      .from("pending_documents")
      .select("payload,productions(guest,podcast_name,record_date)")
      .eq("consolidated_into", r.id as string);
    // one line's text -> the guest of the production that contributed it
    const guestByText = new Map<string, string | null>();
    const suggestByText = new Map<string, string | null>();
    for (const s of (sources ?? []) as unknown as Array<Record<string, unknown>>) {
      const text = ((s.payload as { income?: { description?: string }[] })?.income ?? [])[0]?.description;
      if (typeof text !== "string") continue;
      const g = (s.productions as { guest?: string } | null)?.guest ?? null;
      // first writer wins: two episodes of one show on one day produce the same
      // line text, and there is no way to tell which is which from the bundle.
      // Flagging the first is honest; flagging both off a coin flip is not.
      if (!guestByText.has(text)) guestByText.set(text, g);
      if (!suggestByText.has(text)) {
        const pr = s.productions as
          | { guest?: string; podcast_name?: string; record_date?: string }
          | null;
        suggestByText.set(
          text,
          pr
            ? buildLineItemText({
                podcast_name: pr.podcast_name ?? null,
                guest: pr.guest ?? null,
                record_date: pr.record_date ?? null,
              })
            : null
        );
      }
    }
    guestsByLine.set(
      r.id as string,
      lines.map((l) => (typeof l.description === "string" ? guestByText.get(l.description) ?? null : null))
    );
    suggestedByLine.set(
      r.id as string,
      lines.map((l) => (typeof l.description === "string" ? suggestByText.get(l.description) ?? null : null))
    );
  }

  const now = Date.now();
  const rows: PendingDocRow[] = (
    (data ?? []) as unknown as Array<Record<string, unknown>>
  ).map((r) => {
    const created = new Date(r.created_at as string).getTime();
    const ageHours = Math.floor((now - created) / 3_600_000);
    const prod = r.productions as { podcast_name?: string; record_date?: string; guest?: string } | null;
    return {
      id: r.id as string,
      doc_type: r.doc_type as PendingDocRow["doc_type"],
      status: r.status as string,
      amount: (r.amount as number | null) ?? null,
      created_at: r.created_at as string,
      age_hours: ageHours,
      aging: ageHours >= 72 ? "critical" : ageHours >= 24 ? "warning" : null,
      client_name: ((r.clients as { name?: string } | null)?.name as string) ?? "—",
      show_name: prod?.podcast_name ?? "—",
      record_date: prod?.record_date ?? null,
      guest: prod?.guest ?? null,
      // `[guest]` on a production-anchored row is not a shortcut: index 0 is
      // the session line and every add-on sits after it, so a one-element
      // array is exactly the claim "the guest belongs on the base line and
      // nowhere else". See missingGuestLines.
      guests_by_line: guestsByLine.get(r.id as string) ?? [prod?.guest ?? null],
      // same index alignment as guests_by_line: one element for a
      // production-anchored row (the session line), one per folded line for a
      // bundle
      suggested_by_line:
        suggestedByLine.get(r.id as string) ??
        (prod
          ? [
              buildLineItemText({
                podcast_name: prod.podcast_name ?? null,
                guest: prod.guest ?? null,
                record_date: prod.record_date ?? null,
              }),
            ]
          : [null]),
      payload: r.payload as Record<string, unknown>,
      last_error: (r.last_error as string | null) ?? null,
      attempts: (r.attempts as number | null) ?? 0,
      parent_gross: grossByRow.get(r.id as string)?.gross ?? null,
      parent_gross_error: grossByRow.get(r.id as string)?.error ?? null,
    };
  });

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <DocumentsClient
        rows={rows}
        canApprove={!!profile.can_edit_money}
        dryRun={isDryRun()}
        env={morningEnv()}
      />
    </div>
  );
}
