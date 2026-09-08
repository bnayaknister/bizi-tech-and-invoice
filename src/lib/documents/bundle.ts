import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DOC_TYPE_TO_MORNING_CODE,
  MORNING_DOC_CODE,
  VAT_TYPE_DEFAULT,
  inheritDocDescription,
  sourceRemark,
  type MorningDocumentRequest,
} from "@/lib/morning/types";
import { todayInIsrael } from "@/lib/dates";

// Bundling: several per-episode documents folded into ONE Morning document with
// a line per episode. Two shapes share this file so redemption (owner spec
// 2026-07-28) reuses the exact same primitives as the manual finance bundle
// (0044) rather than growing a parallel one:
//   • deal invoice (300) — bundles JOBS; the shared invoice_biz set at issue
//     time is what lets a single later payment close them all (mark-paid
//     cascade). This is the function the /documents/bundle route also calls.
//   • work order (100) — bundles the ACCRUED work-order queue rows; touches no
//     job (a work order is not an invoice). The individual rows are marked
//     'consolidated' and point at the new bundle row.
//
// Neither talks to Morning: they enqueue a 'pending' row that flows through the
// existing approval → issue path (same brakes, same human gate).

const present = (v: unknown) => v != null && String(v).trim() !== "";
const LIVE_STATUSES = ["pending", "approved", "issued"];

/**
 * The title line of a bundled document, printed on the real thing.
 *
 * Hebrew has no bare "1 <plural>": "(1 פרקים)" reads as a bug to the client
 * holding the page. A count of one is NAMED, not counted — and a document
 * covering one item is not "מאוגד" (bundled) at all, so that word drops with
 * it. Two or more keep both the number and the bundling.
 */
/**
 * The text of ONE line of a bundled deal invoice — one job, one episode.
 *
 * Exported, and deliberately so: the bundle modal on the finance screen shows
 * the bookkeeper what she is about to create, and until now it composed its own
 * approximation (`campaign ?? show_name ?? date`) while this file built
 * `campaign + date`. A preview that disagrees with the builder is worse than no
 * preview — she approves what the screen said, and Morning receives something
 * else. One function, both callers, no way for them to drift.
 *
 * Kept dependency-free on purpose: it is imported by a client component, so it
 * must stay a pure function of its argument. Anything this file gains later
 * that a browser cannot run belongs BELOW it, never inside it.
 *
 * Takes the loosest shape both callers satisfy rather than a job row type —
 * the finance screen's FinanceJob and the DB row here are different types that
 * happen to agree on these two fields.
 */
export function bundleLineDesc(job: { campaign?: string | null; date?: string | null }): string {
  return `${job.campaign ?? ""} ${job.date ?? ""}`.trim() || "פרק";
}

/**
 * How many EPISODES a set of income lines bills — Σ quantity, not the number of
 * rows.
 *
 * The two are the same only while every line carries one unit, which was true
 * of all 83 lines in the account until bundle-from-show (5.9) wrote its first
 * `7 × 500`. Counting rows then printed "(פרק אחד)" at the head of deal invoice
 * 40316 while the table below it billed seven — on a page the client reads.
 *
 * `?? 1` for the same reason sumIncome uses it (lineBalance.ts:38): a line that
 * omits quantity means one unit, never zero.
 */
function episodeCount(income: { quantity?: number }[] | null | undefined): number {
  const rows = Array.isArray(income) ? income : [];
  return rows.reduce((n, l) => {
    const q = Number(l?.quantity ?? 1);
    return n + (Number.isFinite(q) && q > 0 ? q : 1);
  }, 0);
}

function bundleTitle(kind: string, clientName: string, n: number, one: string, many: string, bundled: string) {
  return n === 1
    ? `${kind} — ${clientName} (${one})`.trim()
    : `${kind} ${bundled} — ${clientName} (${n} ${many})`.trim();
}

export type BundleResult =
  | { ok: true; id: string; amount: number; lines: number }
  | { ok: false; status: number; error: string };

/**
 * ⚠️ מסלול חירום מוצהר — חריג למודל השרשרת.
 *
 * המודל הוא 100 → 300 → 305/320: כל מסמך נוצר "על סמך" ההורה שלו, יורש ממנו
 * income קפוא, וסוגר אותו במורנינג. הפונקציה הזאת יוצרת חשבון עסקה **בלי
 * הורה**, ולכן היא מפרה את המודל במכוון.
 *
 * למה היא בכל זאת נשארת (החלטת בעלים 2026-08-02): יש jobs שלא יכולים לקבל
 * הזמנת עבודה לעולם, ובלעדיה אין להם שום דרך להתחייב —
 *   • ייבוא היסטורי (legacy) — קדם למערכת, אין ולא תהיה לו הזמנה
 *   • jobs בלי שום שורת job_productions — שניים כאלה בפרודקשן, אחד על
 *     250,000 ₪. הזמנת עבודה מעוגנת בהפקה, אז אותם היא לא תכסה לעולם
 *
 * נכון ל-2.8.2026: **אפס jobs חיים זקוקים לה בפועל.** נספר: מתוך 59 jobs,
 * חמישה חיים ולא-legacy בלי הזמנה מונפקת, וארבעה מהם כבר נושאים invoice_biz.
 * החמישי הוא amount=null — לא ניתן לחיוב באף מסלול. הפופולציה היחידה
 * שעשויה להצדיק אותה היא 14 שורות היסטוריות בלי invoice_biz, ולא ידוע אם
 * הן חוב פתוח או ייבוא שכבר חויב מחוץ למערכת.
 *
 * **להעריך מחדש אחרי חודש של שימוש אמיתי בשרשרת** (השרשרת עלתה 2.8, ובאותו
 * יום הונפקה בה הזמנת עבודה אמיתית אחת בלבד — אין עדיין steady state
 * להחליט עליו).
 *
 * כל שימוש בה הוא החלטה מודעת של מנהלת החשבונות, לא ברירת מחדל. אין לקרוא
 * לה משום זרימה אוטומטית, ואין להפוך אותה לנתיב החיוב הרגיל של אף לקוח.
 *
 * ---
 * Build ONE deal invoice for N jobs of the same Morning client. Every job must
 * be unbilled and free of a live pending deal invoice, and all must map to one
 * Morning client. Accepts 1+ jobs (a redemption of a single approved episode is
 * a one-line invoice); the UI route enforces its own ≥2 minimum on top.
 */
export async function createDealInvoiceBundle(
  admin: SupabaseClient,
  jobIds: string[],
  actorId: string | null
): Promise<BundleResult> {
  const ids = Array.from(new Set(jobIds.filter(Boolean)));
  if (ids.length < 1) return { ok: false, status: 400, error: "אין עבודות לאיגוד" };

  const { data: jobs } = await admin
    .from("jobs")
    .select("id,client_id,amount,campaign,date,invoice_biz")
    .in("id", ids);
  if (!jobs || jobs.length !== ids.length) {
    return { ok: false, status: 409, error: "חלק מהעבודות לא נמצאו — רענן ונסה שוב" };
  }

  const alreadyBilled = jobs.filter((j) => present(j.invoice_biz));
  if (alreadyBilled.length) {
    return { ok: false, status: 409, error: `${alreadyBilled.length} מהעבודות כבר חויבו — הסר אותן מהבחירה` };
  }

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
  if (ids.some((id) => claimed.has(id))) {
    return { ok: false, status: 409, error: "לחלק מהעבודות כבר יש חשבון עסקה בתור — רענן ונסה שוב" };
  }

  const clientIds = Array.from(new Set(jobs.map((j) => j.client_id).filter(Boolean))) as string[];
  const { data: clients } = await admin.from("clients").select("id,name,morning_client_id").in("id", clientIds);
  const morningIds = new Set((clients ?? []).map((c) => c.morning_client_id).filter(Boolean));
  if (morningIds.size !== 1) {
    return {
      ok: false,
      status: 400,
      error: "כל העבודות חייבות להיות של אותו לקוח מורנינג — הבחירה כוללת יותר מלקוח אחד או לקוח לא ממופה",
    };
  }
  const morningClientId = Array.from(morningIds)[0] as string;
  const primaryClient = (clients ?? []).find((c) => c.morning_client_id === morningClientId)!;

  if (jobs.some((j) => j.amount == null)) {
    return { ok: false, status: 400, error: "לכל עבודה חייב להיות סכום — השלם אותם קודם" };
  }

  const ordered = ids.map((id) => jobs.find((j) => j.id === id)!);
  const total = ordered.reduce((s, j) => s + Number(j.amount), 0);

  const payload: MorningDocumentRequest = {
    type: DOC_TYPE_TO_MORNING_CODE["deal_invoice"],
    lang: "he",
    currency: "ILS",
    vatType: VAT_TYPE_DEFAULT,
    date: todayInIsrael(), // issuance date, not the work dates (issue.ts re-stamps)
    // ordered.length, NOT episodeCount: the noun here is "עבודות" and one job
    // is one job whatever its line says. This bundle builds its own lines a few
    // rows below, one per job at quantity 1, so a unit count would answer a
    // question nobody asked. Deliberately left alone 2026-09-07.
    description: bundleTitle("חשבון עסקה", primaryClient.name ?? "", ordered.length, "עבודה אחת", "עבודות", "מאוגד"),
    client: { id: morningClientId, name: (primaryClient.name as string | null) ?? undefined, add: false },
    income: ordered.map((j) => ({
      description: bundleLineDesc(j),
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
      bundle_job_ids: ids,
      client_id: primaryClient.id,
      amount: total,
      payload,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) return { ok: false, status: 400, error: error.message };

  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: inserted.id,
    event_type: "document_queued",
    actor_id: actorId,
    payload: { doc_type: "deal_invoice", via: "bundle", job_ids: ids, client_id: primaryClient.id, amount: total, lines: ordered.length },
  });

  return { ok: true, id: inserted.id, amount: total, lines: ordered.length };
}

/** One issued work-order queue row, as read for conversion. */
type WorkOrderRow = {
  id: string;
  doc_type: string;
  status: string;
  client_id: string | null;
  amount: number | null;
  payload: MorningDocumentRequest | null;
  morning_doc_id: string | null;
  morning_doc_number: string | null;
  production_id: string | null;
  job_id: string | null;
};

/**
 * How an order is named in a refusal — always the most human id we hold.
 * Copied from taxFromParent.ts:157: with N parents every message has to say
 * WHICH one failed, and the printed number is what the bookkeeper is looking at.
 */
function nameOfOrder(r: WorkOrderRow): string {
  if (r.morning_doc_number) return `#${r.morning_doc_number}`;
  if (r.morning_doc_id) return r.morning_doc_id;
  return r.id;
}

/**
 * Build ONE deal invoice FROM N already-issued work orders, linked to them in
 * Morning (owner spec 2026-08-02; widened from one parent to N on 2026-09-08).
 * This is the second half of redemption: the work orders go out first, and the
 * invoice is created "based on" them, which is also what closes them on
 * Morning's side (verified live 2026-08-02 — linking flips an order to
 * status=1; linkType is not required, and `remarks` is generated by Morning
 * from the link only for documents raised in its own UI, so we write it).
 *
 * The income lines are INHERITED verbatim from each order's frozen payload and
 * concatenated in the caller's order, so the invoice can never total something
 * different from the orders it closes. `description` is the one field rebuilt —
 * it is independent and stored as sent.
 *
 * THE N SHAPE IS taxFromParent.ts's, field for field. That file's header says
 * it was modelled line for line on this one when it owned a single parent; the
 * widening goes back the other way and copies its answers rather than inventing
 * new ones: income concatenated (:596), amount summed (:597), every parent id
 * in linkedDocumentIds (:646), jobs unioned into one Set (:451-524), and the
 * description rule of 2026-09-07 (:617-632) — one parent inherits its wording,
 * several get the built form, because picking the first source's sentence would
 * print one episode as the title of a document that bills three.
 *
 * Takes explicit queue-row ids, never a client lookup: a monthly client can
 * hold several issued order bundles at once (one per redemption) and nothing
 * distinguishes them, so guessing would bill the wrong month's episodes.
 *
 * Every gate refuses the WHOLE request on a single bad parent (taxFromParent's
 * rule, :201-204). Building from "the valid ones" would hand the client a
 * document covering part of the debt while the operator believes it closed all
 * of it — and once it is in Morning there is no PUT to fix it.
 */
export async function createDealInvoiceFromWorkOrder(
  admin: SupabaseClient,
  workOrderPendingIds: string[],
  actorId: string | null
): Promise<BundleResult> {
  const ids = Array.from(new Set((workOrderPendingIds ?? []).filter(Boolean)));
  if (!ids.length) return { ok: false, status: 400, error: "לא נבחרו הזמנות עבודה" };

  const { data: fetched, error: fetchErr } = await admin
    .from("pending_documents")
    .select("id,doc_type,status,client_id,amount,payload,morning_doc_id,morning_doc_number,production_id,job_id")
    .in("id", ids);
  if (fetchErr) return { ok: false, status: 400, error: fetchErr.message };
  const orderRows = (fetched ?? []) as unknown as WorkOrderRow[];
  // never act on a partial set — the operator's intent no longer matches what
  // we hold (taxFromParent:237-243, same rule and the same message shape)
  if (orderRows.length !== ids.length) {
    return {
      ok: false,
      status: 409,
      error: `נמצאו ${orderRows.length} הזמנות מתוך ${ids.length} — רענני את המסך ונסי שוב`,
    };
  }
  // The caller's order is the order the lines PRINT in — createDealInvoiceBundle
  // (:173) has ordered its lines this way since it was written, and a document
  // whose rows arrive in whatever order PostgREST returned is not reproducible.
  const rows = ids.map((id) => orderRows.find((r) => r.id === id)!);

  // ---- gate: one Morning document per request -----------------------------
  // Copied verbatim in intent from taxFromParent:289-303. The Set on the ids
  // above dedupes a REPEATED id; this catches something else — two DIFFERENT
  // local rows pointing at the SAME Morning document.
  //
  // Unreachable today (pending_documents.morning_doc_id is UNIQUE, 0025) and
  // reachable the moment a second source table is mixed in, exactly as it is on
  // the tax path.
  //
  // REFUSE, NEVER FOLD, and this is the gate the widening makes load-bearing:
  // income and amount are now summed per source, so a duplicate bills twice —
  // while sourceRemark collapses repeated numbers, meaning the payload preview
  // would show a perfectly correct-looking remark above a doubled total. The
  // last visual defence is blind to exactly this case, so it has to stop here,
  // in the server, loudly.
  //
  // Only real ids are compared: a missing morning_doc_id is a per-source
  // failure with its own, more precise message below.
  {
    const seenMorningIds = new Set<string>();
    for (const r of rows) {
      const mid = (r.morning_doc_id ?? "").trim();
      if (!mid) continue;
      if (seenMorningIds.has(mid)) {
        return {
          ok: false,
          status: 400,
          error: `${nameOfOrder(r)}: אותו מסמך מורנינג נבחר יותר מפעם אחת — הסכום היה נכפל`,
        };
      }
      seenMorningIds.add(mid);
    }
  }

  // ---- gate: every parent is a work order that really exists in Morning ----
  // The single-parent gates, now in a loop. Each message names the order it
  // fired on (taxFromParent:345-383) — with three selected, "ההזמנה עדיין לא
  // הונפקה" without a number is not something the bookkeeper can act on.
  for (const r of rows) {
    if (r.doc_type !== "work_order") {
      return {
        ok: false,
        status: 400,
        error: `${nameOfOrder(r)}: אפשר ליצור חשבון עסקה על סמך הזמנת עבודה בלבד`,
      };
    }
    // Only an ISSUED order has a Morning id to link to. The messages name the
    // fix, not the rule — the bookkeeper reads them mid-task.
    if (r.status !== "issued") {
      const why =
        r.status === "pending" || r.status === "approved"
          ? "טרם הונפקה — אשרי אותה קודם"
          : r.status === "accrued"
            ? "מסוכמת וטרם נפדתה"
            : "לא קיימת במורנינג";
      return { ok: false, status: 409, error: `${nameOfOrder(r)}: ${why}` };
    }
    if (!r.morning_doc_id) {
      return { ok: false, status: 409, error: `${nameOfOrder(r)}: לא קיימת במורנינג` };
    }
    // A dry-run issuance mints a synthetic `dry-…` id (morning/client.ts) that
    // is not a real Morning UUID. Sending it as a link would produce a
    // confusing rejection, so it is refused here rather than at the API
    // boundary.
    if (r.morning_doc_id.startsWith("dry-")) {
      return {
        ok: false,
        status: 409,
        error: `${nameOfOrder(r)}: הונפקה במצב הרצה יבשה — אין מסמך אמיתי במורנינג לקשר אליו`,
      };
    }
    // the number is what gets PRINTED on the child (remarks) — refuse, never
    // omit quietly (taxFromParent:367-375)
    if (!r.morning_doc_number || !String(r.morning_doc_number).trim()) {
      return {
        ok: false,
        status: 409,
        error: `${r.morning_doc_id}: אין מספר מסמך — לא ניתן לציין אותו בהערת המקור`,
      };
    }
    if (r.amount === null || r.amount === undefined) {
      return { ok: false, status: 409, error: `${nameOfOrder(r)}: אין סכום — לא ניתן לסכם את ההזמנות` };
    }
    if (!r.payload?.client?.id || (r.payload?.income ?? []).length === 0) {
      return { ok: false, status: 400, error: `${nameOfOrder(r)}: נתוני ההזמנה חסרים — לא ניתן לבנות חשבון עסקה` };
    }
  }

  // ---- gate: idempotency, once per parent ---------------------------------
  // A live deal invoice already carrying this order's id in its
  // linkedDocumentIds means the conversion already happened. Morning also marks
  // the order closed, but that only reaches us on the next daily pull — this
  // check is local and immediate. Same shape as before, now run N times
  // (taxFromParent:431-441).
  for (const r of rows) {
    const { data: already } = await admin
      .from("pending_documents")
      .select("id,status,morning_doc_number")
      .eq("doc_type", "deal_invoice")
      .in("status", LIVE_STATUSES)
      .contains("payload", { linkedDocumentIds: [r.morning_doc_id as string] });
    if (already && already.length) {
      return { ok: false, status: 409, error: `${nameOfOrder(r)}: כבר קיים חשבון עסקה על סמך ההזמנה הזו` };
    }
  }

  // ---- gate: one client across all sources --------------------------------
  // NEW, and it has no single-parent ancestor because with one order there is
  // nothing to compare. Both halves, exactly as createDealInvoiceBundle:156-165
  // and createWorkOrderBundle:568-569 do it, in taxFromParent:386-393's form
  // because the Morning identity here also comes out of the frozen payload:
  // Morning's client id (it goes into the outgoing document) and ours (the
  // child row's attribution and every downstream money screen).
  const morningClientIds = Array.from(new Set(rows.map((r) => r.payload!.client!.id as string)));
  if (morningClientIds.length !== 1) {
    return { ok: false, status: 400, error: "כל ההזמנות חייבות להיות של אותו לקוח" };
  }
  const localClientIds = Array.from(new Set(rows.map((r) => r.client_id).filter(Boolean))) as string[];
  if (localClientIds.length > 1) {
    return { ok: false, status: 400, error: "ההזמנות משויכות ליותר מלקוח אחד באפליקציה" };
  }

  const income = rows.flatMap((r) => r.payload!.income ?? []);
  const total = rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);

  // The jobs this invoice bills: each order's folded source rows still carry
  // their production_id, and by now those episodes are client-approved so a job
  // exists. bundle_job_ids is what makes issue.ts stamp the SAME invoice_biz on
  // every one of them — the shared number the mark-paid cascade needs.
  //
  // No job means REFUSE, not warn (owner 2026-08-02): an invoice that stamps
  // invoice_biz on nothing is a charge nobody can see — the jobs stay "not
  // billed" while the client has a real document in hand — and once the
  // document is issued in Morning the state cannot be undone.
  //
  // The episodes come from one of three shapes, tried in this order:
  //   • a CONSOLIDATED order (redemption) — production_id is null on the row
  //     itself and its episodes hang off it via consolidated_into
  //   • a SINGLE per-episode order — no children at all; the episode is the
  //     row's own production_id
  //   • an order raised from the REGISTRY (/api/documents/enqueue) — it is
  //     anchored to a job directly and carries no production_id at all, so
  //     neither production route can find it
  // Reading only the first shape made a single order unconvertible: the
  // children query came back empty, jobIds stayed empty, and the refusal below
  // fired on an order that had a perfectly good job all along.
  //
  // PER PARENT, THEN UNIONED. The children lookup is keyed on consolidated_into
  // so it can be asked for all N at once, but the "else its own production_id"
  // fallback is a decision about ONE order — a consolidated order among
  // per-episode ones must not lend its children to the others, nor be given
  // their production ids. So the fold is grouped by parent and the shapes are
  // resolved row by row, which is why this reads differently from
  // taxFromParent:499-526: that builder unions productionIds globally because
  // it has no such per-parent fallback to protect.
  const { data: folded, error: foldErr } = await admin
    .from("pending_documents")
    .select("consolidated_into,production_id")
    .in("consolidated_into", ids);
  // an unreadable fold table is not evidence that these orders have no
  // children — same rule as the three lookups in the gate below, and as
  // taxFromParent:507
  if (foldErr) return { ok: false, status: 400, error: foldErr.message };
  const childProdsByParent = new Map<string, string[]>();
  for (const f of (folded ?? []) as { consolidated_into: string | null; production_id: string | null }[]) {
    if (!f.consolidated_into || !f.production_id) continue;
    const acc = childProdsByParent.get(f.consolidated_into) ?? [];
    acc.push(f.production_id);
    childProdsByParent.set(f.consolidated_into, acc);
  }
  const productionIds = new Set<string>();
  for (const r of rows) {
    const kids = childProdsByParent.get(r.id) ?? [];
    if (kids.length) for (const p of kids) productionIds.add(p);
    else if (r.production_id) productionIds.add(r.production_id);
  }
  let jobIds: string[] = [];
  if (productionIds.size) {
    const { data: jp } = await admin
      .from("job_productions")
      .select("job_id")
      .in("production_id", Array.from(productionIds));
    jobIds = Array.from(new Set((jp ?? []).map((r) => r.job_id).filter(Boolean))) as string[];
  }
  // Last resort, and deliberately keyed on the RESOLVED jobs rather than on
  // productionIds: this branch may only run where the refusal below would
  // otherwise have fired unconditionally, so no call that succeeds today can
  // take a different path. It therefore also covers an order whose production
  // exists but carries no job_productions row — that case 409s today too.
  // Across N it stays all-or-nothing for the same reason: it fires only when
  // the structural route found NOTHING for the whole set.
  if (jobIds.length === 0) {
    const own = rows.map((r) => r.job_id).filter(Boolean) as string[];
    if (own.length) jobIds = Array.from(new Set(own));
  }
  if (jobIds.length === 0) {
    return {
      ok: false,
      status: 409,
      error: "לא נמצאו עבודות מאושרות. חשבון עסקה נוצר רק אחרי שהפרקים אושרו ע״י הלקוח.",
    };
  }

  // ---- gate: every resolved job must still be billable --------------------
  // Deliberately AFTER the "none found" refusal above: "no job at all" and
  // "jobs found, but not billable" are different diagnoses and must not
  // collapse into one message.
  //
  // createDealInvoiceBundle has refused an already-billed job since it was
  // written (:116-119). This path never did — it resolves jobs structurally,
  // through job_productions of the folded episodes, and trusted that anything
  // it reached that way was fair game. Migration 0060 is what makes that
  // trust unsafe: a job is now born at הוקלט rather than at client approval,
  // so a job can exist for an episode that was later cancelled, and the old
  // paid jobs sitting unlinked in this account (חתונמיות, ברק) become a real
  // hazard the moment anyone links one to a production by hand — which is an
  // open decision on the owner's desk right now.
  //
  // REFUSE, NEVER SKIP. A non-billable job attached to an episode being
  // redeemed is a sign the data is confused, not noise to route around.
  // Silently dropping it would issue a document on a wrong understanding of
  // what it closes, and there is no PUT on documents in Morning. Same
  // reasoning as the bundle-vs-fold refusal in taxFromParent.ts.
  {
    const { data: gateJobs, error: gateErr } = await admin
      .from("jobs")
      .select("id,campaign,invoice_biz,paid,dismissed")
      .in("id", jobIds);
    // an unreadable table is not evidence that everything is fine
    if (gateErr) {
      return { ok: false, status: 409, error: `קריאת העבודות נכשלה — ${gateErr.message}` };
    }
    const found = (gateJobs ?? []) as { id: string; campaign: string | null; invoice_biz: string | null; paid: string | null; dismissed: boolean }[];
    if (found.length !== jobIds.length) {
      // a job_productions row pointing at a job that no longer exists
      return {
        ok: false,
        status: 409,
        error: `נמצאו ${found.length} עבודות מתוך ${jobIds.length} המקושרות — רענני את המסך ונסי שוב`,
      };
    }

    // a job whose episode was cancelled after it was created (only reachable
    // since 0060 — before it, a cancelled episode never got that far)
    const { data: jobProds, error: jpErr2 } = await admin
      .from("job_productions")
      .select("job_id,production_id")
      .in("job_id", jobIds);
    if (jpErr2) {
      return { ok: false, status: 409, error: `קריאת קישורי העבודות נכשלה — ${jpErr2.message}` };
    }
    const prodIds = Array.from(new Set((jobProds ?? []).map((r) => r.production_id).filter(Boolean))) as string[];
    const deadProds = new Set<string>();
    if (prodIds.length) {
      const { data: prodRows, error: prodErr } = await admin
        .from("productions")
        .select("id,status,cancelled_at")
        .in("id", prodIds);
      if (prodErr) {
        return { ok: false, status: 409, error: `קריאת ההפקות נכשלה — ${prodErr.message}` };
      }
      for (const p of (prodRows ?? []) as { id: string; status: string | null; cancelled_at: string | null }[]) {
        if (p.cancelled_at || p.status === "בוטל") deadProds.add(p.id);
      }
    }
    const jobOfDeadProd = new Set(
      (jobProds ?? []).filter((r) => deadProds.has(r.production_id as string)).map((r) => r.job_id as string)
    );

    // DISMISSED IS EXCLUDED, NOT BLOCKING — and the distinction is the whole
    // point of this branch. A dismissed job is a deliberate admin decision
    // that the work will not be billed (0041, and since 2026-08-25 also what
    // cancelling a recorded episode does to its job). Refusing the whole
    // redemption over it would let one written-off episode hold an entire
    // client's bundle hostage. invoice_biz / paid / a cancelled production
    // stay BLOCKING, because those mean the data is confused rather than
    // decided, and a human has to look.
    const dismissed = found.filter((j) => j.dismissed);
    const billable = found.filter((j) => !j.dismissed);
    if (dismissed.length) {
      jobIds = billable.map((j) => j.id);
    }

    // Collect EVERY offender, not just the first: a redemption folds N
    // episodes, and reporting them one per run would be N runs.
    const blocked: string[] = [];
    for (const j of billable) {
      const name = present(j.campaign) ? `"${j.campaign}"` : j.id;
      if (present(j.invoice_biz)) blocked.push(`${name} — כבר נושאת חשבון עסקה ${j.invoice_biz}`);
      else if (j.paid === "כן") blocked.push(`${name} — כבר שולמה`);
      else if (jobOfDeadProd.has(j.id)) blocked.push(`${name} — ההפקה שלה בוטלה`);
    }
    if (blocked.length) {
      return {
        ok: false,
        status: 409,
        error:
          `${blocked.length} מהעבודות המקושרות אינן ניתנות לחיוב: ${blocked.join("; ")}. ` +
          "בדקי אותן ברישום לפני הנפקת חשבון עסקה.",
      };
    }

    // every job was written off — there is nothing left to bill, and saying so
    // is clearer than falling through to a document with an empty stamp list
    if (jobIds.length === 0) {
      return {
        ok: false,
        status: 409,
        error: `כל העבודות המקושרות הוסתרו (${dismissed.length}) — אין מה לחייב בחשבון עסקה`,
      };
    }
  }

  const { data: clientRow } = localClientIds.length
    ? await admin.from("clients").select("name").eq("id", localClientIds[0]).maybeSingle()
    : { data: null };
  const clientName = ((clientRow?.name as string | null) ?? rows[0].payload?.client?.name ?? "").trim();

  const morningIds = rows.map((r) => r.morning_doc_id as string);
  const sourceNumbers = rows.map((r) => String(r.morning_doc_number));

  // The two halves of "created on the basis of", and they are not the same
  // job: linkedDocumentIds CLOSES the orders in Morning, `remarks` is what the
  // client actually reads. An earlier comment here claimed Morning fills the
  // remark itself — it does, but only for documents raised in its own UI.
  // Through the API it leaves the field null, so 40303 went out closing 10306
  // without naming it anywhere on the page (verified against the PDF).
  //
  // sourceRemark has taken a LIST since it was written (taxFromParent:604 has
  // always passed N) — the widening only stops truncating it to one.
  const remark = sourceRemark("deal_invoice", MORNING_DOC_CODE.order, sourceNumbers);

  // THE ORDER'S OWN WORDING, not a rebuilt title (owner spec 2026-09-07) —
  // WHEN THERE IS ONE ORDER. The rule and its reasoning are taxFromParent's
  // (:617-632), locked the same day, and this is the other half of it.
  //
  // What is written on the work order is what the client has already read, and
  // the invoice that closes it has to say the same thing. Rebuilding threw that
  // away: 40318 (גו מובלין) was created 08:54 as "חשבון עסקה — גו מובלין דיגיטל
  // (פרק אחד)" — client name and a line count, nothing of the order's own
  // "אריאל - ב60 שניות — תשלום מלא 10 סרטונים" — then edited by hand at 08:55
  // to drop the count and AGAIN at 13:33 to retype the order's text. Two manual
  // repairs, four and a half hours apart, to restore something that row was
  // holding all along in its own frozen payload.
  //
  // With SEVERAL orders there is no single sentence to carry across: printing
  // the first one's would put one episode's title on a document that bills
  // three. So the built form stays, exactly as it was — and `episodeCount` is
  // now counting the concatenated lines of every parent, which is what it was
  // written to do (:71-77).
  //
  // inheritDocDescription swaps only the label at the head ("הזמנת עבודה" →
  // "חשבון עסקה") and carries the rest verbatim; free text with no label it
  // recognises comes across untouched, no prefix forced. bundleTitle stays as
  // the fallback for an order that carries no description at all — and stays in
  // use, unchanged, on the two paths that really are bundles of N jobs (:161,
  // :540), where `income.length` genuinely is the episode count.
  const builtDescription = bundleTitle(
    "חשבון עסקה",
    clientName,
    episodeCount(income),
    "פרק אחד",
    "פרקים",
    "מאוגד"
  );
  const description =
    rows.length === 1
      ? inheritDocDescription(rows[0].payload?.description, "deal_invoice") ?? builtDescription
      : builtDescription;

  const payload: MorningDocumentRequest = {
    type: DOC_TYPE_TO_MORNING_CODE["deal_invoice"],
    lang: "he",
    currency: "ILS",
    vatType: VAT_TYPE_DEFAULT,
    date: todayInIsrael(), // issuance date, not the work dates (issue.ts re-stamps)
    description,
    client: { id: morningClientIds[0], name: rows[0].payload?.client?.name, add: false },
    income, // inherited verbatim: the invoice must total exactly what the orders did
    // linkType is deliberately absent — not required by the API
    linkedDocumentIds: morningIds,
    // spread away when the orders somehow carry no number, rather than send
    // an empty remark
    ...(remark ? { remarks: remark } : {}),
  };

  const { data: inserted, error } = await admin
    .from("pending_documents")
    .insert({
      doc_type: "deal_invoice",
      production_id: null,
      job_id: null,
      bundle_job_ids: jobIds, // guaranteed non-empty by the guard above
      client_id: localClientIds[0] ?? null,
      amount: total, // Σ of the orders' own totals, never recomputed from lines
      payload,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) return { ok: false, status: 400, error: error.message };

  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: inserted.id,
    event_type: "document_queued",
    actor_id: actorId,
    payload: {
      doc_type: "deal_invoice",
      via: "from_work_order",
      work_order_pending_ids: ids,
      linked_morning_doc_ids: morningIds,
      linked_morning_doc_numbers: sourceNumbers,
      client_id: localClientIds[0] ?? null,
      amount: total,
      lines: income.length,
      job_ids: jobIds,
    },
  });

  return { ok: true, id: inserted.id, amount: total, lines: income.length };
}

// One accrued work-order queue row, as read for consolidation.
export type AccruedWorkOrder = {
  id: string;
  client_id: string | null;
  amount: number | null;
  production_id: string | null;
  payload: MorningDocumentRequest;
};

/**
 * Fold N accrued work-order rows into ONE consolidated work order (a line per
 * episode) and mark each source row 'consolidated', pointing at the new row.
 * All rows must share one client. Touches no job.
 */
export async function createWorkOrderBundle(
  admin: SupabaseClient,
  rows: AccruedWorkOrder[],
  actorId: string | null
): Promise<BundleResult> {
  if (rows.length < 1) return { ok: false, status: 400, error: "אין הזמנות עבודה מסוכמות לפדיון" };

  const clientIds = Array.from(new Set(rows.map((r) => r.client_id).filter(Boolean)));
  if (clientIds.length !== 1) return { ok: false, status: 400, error: "כל ההזמנות חייבות להיות של אותו לקוח" };

  // every accrued work order carries exactly one income line (the base session
  // — add-ons never touch a work order); concatenating gives one line/episode.
  const baseClient = rows[0].payload?.client;
  const income = rows.flatMap((r) => r.payload?.income ?? []);
  if (!baseClient?.id || income.length === 0) {
    return { ok: false, status: 400, error: "נתוני ההזמנות המסוכמות חסרים — לא ניתן לאחד" };
  }
  const total = rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);

  const payload: MorningDocumentRequest = {
    type: DOC_TYPE_TO_MORNING_CODE["work_order"],
    lang: "he",
    currency: "ILS",
    vatType: VAT_TYPE_DEFAULT,
    date: todayInIsrael(), // issuance date, not the work dates (issue.ts re-stamps)
    // episodeCount(income), not rows.length: the noun is "פרקים", and one
    // source row will not always mean one episode. Identical today (every
    // accrued order carries a single one-unit line) and correct the first time
    // it is not.
    description: bundleTitle("הזמנת עבודה", baseClient.name ?? "", episodeCount(income), "פרק אחד", "פרקים", "מאוגדת"),
    client: { id: baseClient.id, name: baseClient.name, add: false },
    income,
  };

  const { data: inserted, error } = await admin
    .from("pending_documents")
    .insert({
      doc_type: "work_order",
      production_id: null,
      job_id: null,
      client_id: clientIds[0],
      amount: total,
      payload,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) return { ok: false, status: 400, error: error.message };

  // fold the source rows: 'consolidated' is a terminal, still-blocking state
  // (the recast unique index keeps 06:00 from re-queuing these productions).
  await admin
    .from("pending_documents")
    .update({ status: "consolidated", consolidated_into: inserted.id })
    .in("id", rows.map((r) => r.id));

  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: inserted.id,
    event_type: "document_queued",
    actor_id: actorId,
    payload: { doc_type: "work_order", via: "bundle", source_ids: rows.map((r) => r.id), client_id: clientIds[0], amount: total, lines: income.length },
  });

  return { ok: true, id: inserted.id, amount: total, lines: income.length };
}
