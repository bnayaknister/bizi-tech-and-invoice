import { NextResponse } from "next/server";
import { createAdminClient, createTypedAdminClient } from "@/lib/supabase/admin";
import { resolveLink } from "@/lib/review/links";
import { itemInLinkScope } from "@/lib/review/clientVersions";
import { shouldRecordView, VIEW_DEDUP_MS } from "@/lib/review/views";

// 0122 (owner 22.10) - POST /api/r/[token]/view { version_id }: the client
// page opened (or switched to) a version. PUBLIC, account-less: the token is
// the credential, checked exactly like the page (resolveLink). One row in
// client_review_version_views: the version, its item, the link, the time -
// NOTHING about the viewer (no IP, no browser, no name). The same link + version
// within VIEW_DEDUP_MS is one view (a reload is not a second visit).
// Never an error the page shows: the answer is only for the log.
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request, { params }: { params: { token: string } }) {
  const state = await resolveLink(createAdminClient(), params.token);
  if (state.status !== "ok") return json({ ok: false, reason: state.status }, 410);
  const body = (await request.json().catch(() => ({}))) as { version_id?: unknown };
  const versionId = typeof body.version_id === "string" ? body.version_id : "";
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) return json({ ok: false, reason: "bad_version" }, 400);

  const admin = createTypedAdminClient();
  const { data: v } = await admin
    .from("client_review_versions")
    .select("id,item_id,number,withdrawn_at")
    .eq("id", versionId)
    .maybeSingle();
  const item = v ? state.items.find((i) => i.id === v.item_id) : null;
  if (!v || !item || v.withdrawn_at || v.number === null || !itemInLinkScope(state.link, { ...item, production_id: state.link.production_id }, state.production.review_reels_required)) {
    return json({ ok: false, reason: "not_in_link" }, 404);
  }

  const { data: last } = await admin
    .from("client_review_version_views")
    .select("viewed_at")
    .eq("version_id", v.id)
    .eq("link_id", state.link.id)
    .order("viewed_at", { ascending: false })
    .limit(1);
  if (!shouldRecordView(last?.[0]?.viewed_at ?? null, new Date())) return json({ ok: true, deduped: true, window_ms: VIEW_DEDUP_MS });

  const { error } = await admin.from("client_review_version_views").insert({ version_id: v.id, item_id: v.item_id, link_id: state.link.id });
  if (error) return json({ ok: false, reason: "write_failed" }, 500);
  return json({ ok: true });
}
