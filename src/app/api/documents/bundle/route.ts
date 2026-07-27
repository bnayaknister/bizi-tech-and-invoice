import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DOC_TYPE_TO_MORNING_CODE, VAT_TYPE_DEFAULT, type MorningDocumentRequest } from "@/lib/morning/types";

// Bundle several jobs into ONE deal invoice (owner spec — Feature 3): a podcast
// that records N episodes and pays at the end gets a single חשבון עסקה with a
// line per episode, not N invoices.
//
// ⚠️ Hard condition: every job must belong to the SAME Morning client. Mixed
// clients are refused with an explanation (one Morning document has one client).
//
// The queue row carries bundle_job_ids so issuance flips every job at once and
// stamps them all with the SAME invoice_biz — the shared number is what lets a
// single later payment close them all. Flows through the existing approval →
// issue path (same brakes). can_edit_money.
const LIVE_STATUSES = ["pending", "approved", "issued"];
const present = (v: unknown) => v != null && String(v).trim() !== "";

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { jobIds?: string[] };
  const jobIds = Array.from(new Set((body.jobIds ?? []).filter(Boolean)));
  if (jobIds.length < 2) return NextResponse.json({ error: "יש לבחור לפחות שתי עבודות לאיגוד" }, { status: 400 });

  const admin = createAdminClient();
  const { data: jobs } = await admin
    .from("jobs")
    .select("id,client_id,amount,campaign,date,invoice_biz")
    .in("id", jobIds);
  if (!jobs || jobs.length !== jobIds.length) {
    return NextResponse.json({ error: "חלק מהעבודות לא נמצאו — רענן ונסה שוב" }, { status: 409 });
  }

  // none may be billed already
  const alreadyBilled = jobs.filter((j) => present(j.invoice_biz));
  if (alreadyBilled.length) {
    return NextResponse.json({ error: `${alreadyBilled.length} מהעבודות כבר חויבו — הסר אותן מהבחירה` }, { status: 409 });
  }
  // and none may have a live pending deal invoice (single or bundled)
  const { data: livePending } = await admin
    .from("pending_documents")
    .select("job_id,bundle_job_ids")
    .eq("doc_type", "deal_invoice")
    .in("status", LIVE_STATUSES);
  const claimed = new Set<string>();
  for (const p of livePending ?? []) {
    if (p.job_id) claimed.add(p.job_id as string);
    for (const bid of (p.bundle_job_ids as string[] | null) ?? []) claimed.add(bid);
  }
  if (jobIds.some((id) => claimed.has(id))) {
    return NextResponse.json({ error: "לחלק מהעבודות כבר יש חשבון עסקה בתור — רענן ונסה שוב" }, { status: 409 });
  }

  // all must map to the SAME Morning client
  const clientIds = Array.from(new Set(jobs.map((j) => j.client_id).filter(Boolean))) as string[];
  const { data: clients } = await admin.from("clients").select("id,name,morning_client_id").in("id", clientIds);
  const morningIds = new Set((clients ?? []).map((c) => c.morning_client_id).filter(Boolean));
  if (morningIds.size !== 1) {
    return NextResponse.json(
      { error: "כל העבודות חייבות להיות של אותו לקוח מורנינג — הבחירה כוללת יותר מלקוח אחד או לקוח לא ממופה" },
      { status: 400 }
    );
  }
  const morningClientId = Array.from(morningIds)[0] as string;
  const primaryClient = (clients ?? []).find((c) => c.morning_client_id === morningClientId)!;

  // amounts required
  if (jobs.some((j) => j.amount == null)) {
    return NextResponse.json({ error: "לכל עבודה חייב להיות סכום — השלם אותם קודם" }, { status: 400 });
  }

  // keep the caller's chosen order
  const ordered = jobIds.map((id) => jobs.find((j) => j.id === id)!);
  const lineDesc = (j: (typeof jobs)[number]) =>
    `${(j.campaign as string | null) ?? ""} ${(j.date as string | null) ?? ""}`.trim() || "פרק";
  const total = ordered.reduce((s, j) => s + Number(j.amount), 0);

  const payload: MorningDocumentRequest = {
    type: DOC_TYPE_TO_MORNING_CODE["deal_invoice"],
    lang: "he",
    currency: "ILS",
    vatType: VAT_TYPE_DEFAULT,
    description: `חשבון עסקה מאוגד — ${primaryClient.name ?? ""} (${ordered.length} עבודות)`.trim(),
    client: { id: morningClientId, name: (primaryClient.name as string | null) ?? undefined, add: false },
    income: ordered.map((j) => ({
      description: lineDesc(j),
      quantity: 1,
      price: Number(j.amount),
      currency: "ILS",
      vatType: VAT_TYPE_DEFAULT,
    })),
  };

  const { data: inserted, error } = await admin
    .from("pending_documents")
    .insert({
      doc_type: "deal_invoice",
      production_id: null,
      job_id: null,
      bundle_job_ids: jobIds,
      client_id: primaryClient.id,
      amount: total,
      payload,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: inserted.id,
    event_type: "document_queued",
    actor_id: user.id,
    payload: { doc_type: "deal_invoice", via: "bundle", job_ids: jobIds, client_id: primaryClient.id, amount: total, lines: ordered.length },
  });

  return NextResponse.json({ ok: true, id: inserted.id, jobs: jobIds.length, amount: total });
}
