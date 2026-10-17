import { NextResponse } from "next/server";
import { createAdminClient, createTypedAdminClient } from "@/lib/supabase/admin";
import { resolveLink, enqueueDealInvoiceAfterApproval } from "@/lib/review/links";
import { CLIENT_VERSION_SELECT, itemInLinkScope } from "@/lib/review/clientVersions";
import { checkAgainstVersions, mapRpcError, parseItemAction, type VersionWithDuration } from "@/lib/review/itemComments";

// E13-8b — POST /api/r/[token]/items/[itemId]: a pin, a general comment, or a
// re-approval on ONE item (plan §9.2 E13-8 (b); owner decisions 16.10 +
// 17.10). PUBLIC, account-less: the token is the credential, checked exactly
// like the page. Works on a live link (decision 1: pins before the first
// response) and on an answered one (post_response) — never on a replaced or
// expired link (resolveLink refuses those).
//
//   { action: "pin",     version_id, time_ms, body }  — Bunny version only
//   { action: "comment", version_id, body }            — any version; null only for an item with none
//   { action: "approve", version_id }                  — only after a revoke by a comment from this link
//
// The version must be the LATEST one the client is shown (409 otherwise): the
// "respond on the latest only" rule is enforced here, not only in the page.
// The writes are 0118's functions — one transaction each, item row locked.
// After a re-approval that completes the set, the deal invoice takes the same
// path as applyResponse (enqueueDealInvoiceAfterApproval → findBilledEvidence:
// no second invoice; on_production_approved: no second job).
export const dynamic = "force-dynamic";

const lastHit = new Map<string, number>();
const THROTTLE_MS = 1000;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request, { params }: { params: { token: string; itemId: string } }) {
  const key = `${params.token}|${params.itemId}`;
  const now = Date.now();
  const prev = lastHit.get(key);
  if (prev && now - prev < THROTTLE_MS) return json({ error: "נסו שוב בעוד רגע" }, 429);
  lastHit.set(key, now);

  const state = await resolveLink(createAdminClient(), params.token);
  if (state.status !== "ok") return json({ error: "הלינק אינו זמין יותר", reason: state.status }, 410);

  const item = state.items.find((i) => i.id === params.itemId);
  if (!item || !itemInLinkScope(state.link, { ...item, production_id: state.link.production_id }, state.production.review_reels_required)) {
    return json({ error: "הפריט אינו בקישור הזה" }, 404);
  }

  const parsed = parseItemAction(await request.json().catch(() => ({})));
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const action = parsed.value;

  const admin = createTypedAdminClient();
  const { data: rows, error: vErr } = await admin
    .from("client_review_versions")
    .select(`${CLIENT_VERSION_SELECT},duration_ms`)
    .eq("item_id", item.id);
  if (vErr) return json({ error: "השמירה נכשלה. נסו שוב בעוד רגע" }, 500);
  const check = checkAgainstVersions(action, (rows ?? []) as unknown as VersionWithDuration[]);
  if (!check.ok) return json({ error: check.error }, check.status);

  if (action.action === "approve") {
    const { data, error } = await admin.rpc("review_item_reapprove", {
      p_link_id: state.link.id,
      p_item_id: item.id,
      p_version_id: action.versionId,
    });
    if (error) {
      const m = mapRpcError(error.message);
      return json({ error: m.error }, m.status);
    }
    const res = (data ?? {}) as { approved_all?: boolean; from_status?: string; status?: string };
    if (res.status === 'אושר_ע"י_לקוח' && res.from_status !== 'אושר_ע"י_לקוח') {
      await enqueueDealInvoiceAfterApproval(createAdminClient(), state.link.production_id);
    }
    return json({ ok: true, approved: true, approved_all: !!res.approved_all });
  }

  const { data, error } = await admin.rpc("review_item_comment", {
    p_link_id: state.link.id,
    p_item_id: item.id,
    // the generated Args type has no nulls; 0118 takes null for a general
    // comment on an item without versions, and for the time of a general one
    p_version_id: action.versionId as string,
    p_kind: action.action === "pin" ? "pin" : "general",
    p_time_ms: (action.action === "pin" ? action.timeMs : null) as number,
    p_body: action.body,
  });
  if (error) {
    const m = mapRpcError(error.message);
    return json({ error: m.error }, m.status);
  }
  const res = (data ?? {}) as { comment_id?: string; pin_number?: number | null; revoked?: boolean };
  return json({
    ok: true,
    comment: {
      id: res.comment_id,
      version_id: action.versionId,
      kind: action.action === "pin" ? "pin" : "general",
      pin_number: res.pin_number ?? null,
      time_ms: action.action === "pin" ? action.timeMs : null,
      body: action.body,
      created_at: new Date().toISOString(),
    },
    revoked: !!res.revoked,
  });
}
