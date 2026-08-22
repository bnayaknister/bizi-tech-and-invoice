import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import RegistryClient, { type DocRow } from "./RegistryClient";
import { registryTabForType, type PendingDocType } from "@/lib/morning/types";
import { ALLOWED_CHILDREN } from "@/lib/documents/taxFromParent";
import { mapPullDocToReceiptSource, mapPullDocToSource, type PullDocRow } from "@/lib/documents/pullSource";

export const dynamic = "force-dynamic";

export default async function RegistryPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_money) redirect("/");

  const admin = createAdminClient();
  const BASE_COLS =
    "id,morning_doc_id,morning_doc_number,type,status,client_id,morning_client_name,amount,currency," +
    "document_date,pdf_url,source,production_id,job_id,clients(name),productions(podcast_name)";
  // cancelled_at (0043) + archived_at (0045) columns — read them, but fall back
  // to the base columns if a migration isn't applied yet so the screen keeps
  // rendering.
  const docsQuery = (cols: string) =>
    admin.from("documents").select(cols).order("document_date", { ascending: false, nullsFirst: false }).limit(5000);
  const [docsRes, { data: settings }] = await Promise.all([
    docsQuery(`${BASE_COLS},cancelled_at,cancel_reason,archived_at,archive_reason`),
    admin.from("app_settings").select("documents_pulled_at").eq("id", true).maybeSingle(),
  ]);
  const data = docsRes.error ? (await docsQuery(BASE_COLS)).data : docsRes.data;

  // Which registry rows can raise a tax document. Two doors, one per source:
  //  • a pending_documents row (app-issued) — the original path, keyed by
  //    morning_doc_id, inherits the frozen payload we actually sent.
  //  • the raw path — a PULLED open document with no queue row, two rungs,
  //    each judged by the SAME pure mapper its server door runs (one function,
  //    two callers, zero drift): a 300 (stage 4, owner approved 2026-08-11)
  //    through mapPullDocToSource, a 305 (2026-08-13) through
  //    mapPullDocToReceiptSource. Either way the button never promises what
  //    the server would refuse: each block shows its own refusal up front
  //    instead of a 4xx after the click.
  //
  // The candidate query is the only one that hauls raw, and it is bounded:
  // open pulled 300s and 305s trend toward zero BECAUSE of this feature (a
  // built child closes its parent on the next pull), so a growing population
  // is itself a pathology. The LIMIT is a circuit breaker, not pagination —
  // and it is not silent: rows beyond it get a block message saying the screen
  // capped, so truncation never reads as "no button for you, no reason given".
  const RAW_CANDIDATE_LIMIT = 120;
  const [{ data: parentRows }, { data: candRows }] = await Promise.all([
    admin
      .from("pending_documents")
      .select("id,morning_doc_id")
      .in("doc_type", ["work_order", "deal_invoice", "tax_invoice"])
      .eq("status", "issued")
      .not("morning_doc_id", "is", null),
    admin
      .from("documents")
      // `status` is hauled, not only filtered on — the receipt mapper judges it
      .select("id,morning_doc_id,morning_doc_number,type,status,source,client_id,job_id,amount,cancelled_at,archived_at,raw")
      .in("type", [300, 305])
      .eq("status", 0)
      .eq("source", "pull")
      .is("cancelled_at", null)
      .is("archived_at", null)
      .order("document_date", { ascending: false, nullsFirst: false })
      .limit(RAW_CANDIDATE_LIMIT),
  ]);
  const pendingIdByMorningId = new Map<string, string>();
  for (const p of (parentRows ?? []) as { id: string; morning_doc_id: string }[]) {
    pendingIdByMorningId.set(p.morning_doc_id, p.id);
  }

  // Parents that already have a tax child WAITING IN THE QUEUE — the screen's
  // mirror of the builder's idempotency gate (taxFromParent, "כבר קיים מסמך מס
  // על סמכו"). Found 2026-08-22 during the manual pass on the ceiling
  // override: the map above only knows ISSUED rows, so between building a tax
  // document from a pulled parent and approving it, the screen kept offering
  // the button. The server refused every time — but a button that asks an
  // admin to justify a 295,000 ₪ override and then 409s is exactly the
  // "promises what the server would refuse" this screen exists not to do.
  // Pre-dates the override and applies to every raw-path build.
  const taxedParentMorningIds = new Set<string>();
  {
    const { data: liveTax } = await admin
      .from("pending_documents")
      .select("payload")
      .in("doc_type", ["tax_invoice", "tax_receipt"])
      .in("status", ["pending", "approved", "issued"]);
    for (const r of (liveTax ?? []) as { payload: { linkedDocumentIds?: string[] } | null }[]) {
      for (const id of r.payload?.linkedDocumentIds ?? []) taxedParentMorningIds.add(id);
    }
  }

  // judge every candidate in exactly the server's order, so the screen's
  // verdict IS the server's: a 300 through the real tax mapper + job
  // pre-checks, a 305 through the real receipt mapper
  // 'over-ceiling' is a THIRD state, not a flavour of blocked: the document is
  // fully valid — identity proven, all three arithmetic layers passed — and the
  // only thing standing in front of it is a policy threshold that an admin may
  // deliberately step over. A flat "blocked" would tell shiri to go do it by
  // hand in Morning, which is exactly what the override exists to avoid.
  //
  // The mapper is called WITHOUT the override flag on purpose: we want to see
  // what a normal request would do, then decide whether THIS viewer is allowed
  // to offer stepping over it. Passing the flag here would hide the signal.
  type RawState =
    | { state: "raw"; net: number | null }
    | { state: "over-ceiling"; reason: string; net: number; ceiling: number }
    | { state: "blocked"; reason: string };
  const canOverrideCeiling = profile.can_manage_users === true;
  const rawStateByDocId = new Map<string, RawState>();
  const cands = (candRows ?? []) as unknown as PullDocRow[];
  // jobs matter only to the tax rung — a receipt has no jobs gate (it stamps
  // nothing; the money side closes via payment reconciliation)
  const candJobIds = Array.from(
    new Set(cands.filter((c) => c.type === 300).map((c) => c.job_id).filter(Boolean))
  ) as string[];
  const taxedByJob = new Map<string, string>();
  if (candJobIds.length) {
    const { data: jobRows } = await admin.from("jobs").select("id,invoice_tax").in("id", candJobIds);
    for (const j of (jobRows ?? []) as { id: string; invoice_tax: string | null }[]) {
      if (j.invoice_tax && String(j.invoice_tax).trim()) taxedByJob.set(j.id, String(j.invoice_tax));
    }
  }

  for (const c of cands) {
    // a pull doc with a queue row cannot occur through any code path, but if
    // one ever does, the pending door wins — same rule as the route
    if (c.morning_doc_id && pendingIdByMorningId.has(c.morning_doc_id)) continue;
    if (c.type === 305) {
      // the SAME pure mapper the builder's raw door runs. No net: a receipt
      // is built on the GROSS, and the modal labels it so.
      const receipt = mapPullDocToReceiptSource(c);
      rawStateByDocId.set(
        c.id,
        receipt.ok ? { state: "raw", net: null } : { state: "blocked", reason: receipt.error }
      );
      continue;
    }
    // already has a tax child in flight — same verdict the builder gives
    if (c.morning_doc_id && taxedParentMorningIds.has(c.morning_doc_id)) {
      rawStateByDocId.set(c.id, {
        state: "blocked",
        reason: "כבר קיים מסמך מס על סמך מסמך זה — בתור האישורים או מונפק",
      });
      continue;
    }
    const res = mapPullDocToSource(c);
    if (!res.ok && !(res.overCeiling && canOverrideCeiling)) {
      rawStateByDocId.set(c.id, { state: "blocked", reason: res.error });
      continue;
    }
    // From here the row is either fully buildable, or buildable-with-override.
    // The job gates below apply to BOTH — offering an override on a row that
    // the builder would refuse two gates later is a worse lie than no button.
    if (!c.job_id) {
      // guidance, not a description of the lack — the assign button sits in
      // the same cell (owner rule 2026-08-11)
      rawStateByDocId.set(c.id, {
        state: "blocked",
        reason: 'יש לשייך את המסמך לעבודה לפני יצירת חשבונית מס — כפתור "שייך ל-job" כאן בשורה',
      });
      continue;
    }
    const taxed = taxedByJob.get(c.job_id);
    if (taxed) {
      rawStateByDocId.set(c.id, {
        state: "blocked",
        reason: `העבודה המקושרת כבר נושאת חשבונית מס ${taxed} — בדקי ברישום לפני הנפקה נוספת`,
      });
      continue;
    }
    if (!res.ok && res.overCeiling) {
      rawStateByDocId.set(c.id, {
        state: "over-ceiling",
        reason: res.error,
        net: res.overCeiling.net,
        ceiling: res.overCeiling.ceiling,
      });
      continue;
    }
    if (res.ok) rawStateByDocId.set(c.id, { state: "raw", net: res.source.amount });
  }
  const candidatesCapped = cands.length === RAW_CANDIDATE_LIMIT;

  // Which child a row may raise, derived from the allow-list in taxFromParent.ts
  // rather than a hand-kept list of type codes on the screen. One source of
  // truth: when a rung opens or closes there, the buttons follow.
  //
  // Resolved here rather than in the client so the builders themselves never
  // reach the browser bundle.
  const childActionFor = (type: number): DocRow["child_action"] => {
    const parent = registryTabForType(type) as PendingDocType;
    const rules = (ALLOWED_CHILDREN[parent] ?? []).filter((r) => r.implemented);
    if (rules.some((r) => r.via === "receipt_from_tax_invoice")) return "receipt";
    if (rules.some((r) => r.via === "tax_from_parent")) return "tax";
    return null;
  };

  // the three action-cell states, resolved per row: 'pending' (queue row —
  // the original door), 'raw' (pulled, judged buildable by the mapper), or
  // null with build_block carrying the exact reason the button is dark
  const buildState = (d: Record<string, unknown>): Pick<DocRow, "buildable" | "build_block" | "net_amount" | "over_ceiling"> => {
    // a 320 is invoice AND receipt in one — the payment is inside it, so a
    // further receipt is never raised on it. Said in words, never null/null:
    // the silent action cell is exactly the hole this screen exists to close.
    if (d.type === 320) {
      return {
        buildable: null,
        build_block: "חשבונית מס קבלה כוללת את התקבול — לא מונפקת עליה קבלה נוספת",
        net_amount: null,
        over_ceiling: null,
      };
    }
    if (pendingIdByMorningId.has(d.morning_doc_id as string)) {
      return { buildable: "pending", build_block: null, net_amount: null, over_ceiling: null };
    }
    const rs = rawStateByDocId.get(d.id as string);
    if (rs?.state === "raw") return { buildable: "raw", build_block: null, net_amount: rs.net, over_ceiling: null };
    if (rs?.state === "over-ceiling") {
      // buildable, but the modal must collect a reason and go through the
      // two-call ticket handshake before the server will accept it
      return {
        buildable: "raw",
        build_block: null,
        net_amount: rs.net,
        over_ceiling: { net: rs.net, ceiling: rs.ceiling },
      };
    }
    if (rs?.state === "blocked") return { buildable: null, build_block: rs.reason, net_amount: null, over_ceiling: null };
    // an open pulled candidate (300 or 305) that is not in the candidate map
    // at all can only mean the LIMIT capped it out — say so rather than go
    // quietly dark
    const isOpenPullCandidate =
      (d.type === 300 || d.type === 305) && d.status === 0 && d.source === "pull" && !d.cancelled_at && !d.archived_at;
    if (isOpenPullCandidate && candidatesCapped) {
      return {
        buildable: null,
        build_block: `יותר מ-${RAW_CANDIDATE_LIMIT} מסמכים פתוחים ממורנינג — המסך ממפה את החדשים תחילה; טפלי בהם ורענני`,
        net_amount: null,
        over_ceiling: null,
      };
    }
    return { buildable: null, build_block: null, net_amount: null, over_ceiling: null };
  };

  const rows: DocRow[] = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((d) => ({
    id: d.id as string,
    morning_doc_id: (d.morning_doc_id as string | null) ?? null,
    number: (d.morning_doc_number as string | null) ?? null,
    type: d.type as number,
    tab: registryTabForType(d.type as number),
    status: (d.status as number | null) ?? null,
    client_id: (d.client_id as string | null) ?? null,
    client_name:
      ((d.clients as { name?: string } | null)?.name as string) ??
      (d.morning_client_name as string | null) ??
      null,
    morning_client_name: (d.morning_client_name as string | null) ?? null,
    amount: (d.amount as number | null) ?? null,
    currency: (d.currency as string | null) ?? "ILS",
    document_date: (d.document_date as string | null) ?? null,
    pdf_url: (d.pdf_url as string | null) ?? null,
    source: d.source as DocRow["source"],
    production_id: (d.production_id as string | null) ?? null,
    job_id: (d.job_id as string | null) ?? null,
    show_name: ((d.productions as { podcast_name?: string } | null)?.podcast_name as string) ?? null,
    cancelled_at: (d.cancelled_at as string | null) ?? null,
    cancel_reason: (d.cancel_reason as string | null) ?? null,
    archived_at: (d.archived_at as string | null) ?? null,
    archive_reason: (d.archive_reason as string | null) ?? null,
    pending_id: pendingIdByMorningId.get(d.morning_doc_id as string) ?? null,
    child_action: childActionFor(d.type as number),
    ...buildState(d),
  }));

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <RegistryClient
        rows={rows}
        canPull={!!profile.can_edit_money}
        lastPull={(settings?.documents_pulled_at as string | null) ?? null}
      />
    </div>
  );
}
