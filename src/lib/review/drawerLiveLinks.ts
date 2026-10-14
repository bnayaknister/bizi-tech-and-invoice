import type { SupabaseClient } from "@supabase/supabase-js";

// ═══════════════════════════════════════════════════════════════════════════
// T36 — the production drawer's LIVE review links, with a ceiling.
// Extracted from GET /api/entity/[type]/[id] (the "review_links_transcripts"
// step of T35) so the timeout can be tested without a request.
// ═══════════════════════════════════════════════════════════════════════════
//
// LIVE review links (Q7) — the drawer had no way to retrieve a link it had
// already sent, so the tech pressed send again and superseded the one the
// client was holding (20 links on one production in two days). Read through
// the user's own client: the table's select policy is can_view_stages(), the
// same gate the caller already sits behind. Supersession is scope-aware since
// the B1 fix, so an episode link and a reels link can BOTH be live — this is a
// list, not a single row.
//
// ═══ WHY THERE IS A CEILING (14.10) ═══
// Production 6e38aba1 opened in 63.3s, 62.1s of it in this step — while the
// same three queries never executed past 6ms in pg_stat_statements (which
// counts lock waits too), and other opens of the same production took
// 38–224ms. The time was lost on the HTTP hop between the function and
// Supabase REST, not in the database. None of the three reads had a timeout,
// so the whole drawer waited on the one that hung.
//
// Every read here now carries AbortSignal.timeout(timeoutMs). Past it — or on
// ANY error, which until now was silently dropped and rendered as "no live
// link" — the drawer gets `incomplete: true` and `links: null`, shows a small
// notice instead of the block, and one `drawer_partial` line is logged.
// Nothing here calls Drive, Bunny or a transcription service: the transcript
// is METADATA only (0076), and the text is fetched on demand by its own route.

export const DRAWER_LIVE_LINKS_TIMEOUT_MS = 5000;

export type DrawerLiveLink = {
  id: string;
  url: string;
  scope: string;
  created_at: string;
  audio_link: string | null;
  audio_carried_from_at: string | null;
  transcript: { source: string; char_count: number | null; carried_from_at: string | null } | null;
};

export type DrawerLiveLinks = { links: DrawerLiveLink[] | null; incomplete: boolean };

export async function loadDrawerLiveLinks(args: {
  /** the USER's client — RLS decides what the viewer may see */
  supabase: SupabaseClient;
  /** client_review_transcripts is revoked with RLS on and no policies (0076 §3) */
  admin: SupabaseClient;
  productionId: string;
  /** the same base URL the mint route stamps into the link it hands out */
  origin: string;
  timeoutMs?: number;
  log?: (line: string) => void;
}): Promise<DrawerLiveLinks> {
  const { supabase, admin, productionId, origin } = args;
  const timeoutMs = args.timeoutMs ?? DRAWER_LIVE_LINKS_TIMEOUT_MS;
  const start = performance.now();
  let failure: unknown = null;

  const { data: linkRows, error: linkErr } = await supabase
    .from("client_review_links")
    .select("id,token,scope,created_at,expires_at,superseded,responded_at,audio_link,audio_carried_from")
    .eq("production_id", productionId)
    .eq("superseded", false)
    .is("responded_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .abortSignal(AbortSignal.timeout(timeoutMs));
  if (linkErr) failure = linkErr;

  // 0076's transcript, as METADATA ONLY — source and length, never the text.
  const liveIds = failure ? [] : (linkRows ?? []).map((r) => r.id as string);
  let transcriptByLink = new Map<string, { source: string; char_count: number | null; carried_from: string | null }>();
  if (liveIds.length) {
    const { data: trRows, error: trErr } = await admin
      .from("client_review_transcripts")
      .select("link_id,source,char_count,carried_from_link_id")
      .in("link_id", liveIds)
      .abortSignal(AbortSignal.timeout(timeoutMs));
    if (trErr) failure = failure ?? trErr;
    transcriptByLink = new Map(
      (trRows ?? []).map((t) => [
        t.link_id as string,
        {
          source: t.source as string,
          char_count: (t.char_count as number | null) ?? null,
          carried_from: (t.carried_from_link_id as string | null) ?? null,
        },
      ])
    );
  }

  // 0078 — resolve each carry marker to the DATE of the round it points at.
  // The source rounds are SUPERSEDED by definition, so they are not in
  // linkRows and need their own lookup. A marker whose target is gone resolves
  // to null and the drawer renders no chip (ON DELETE SET NULL, 0078).
  const carryIds = failure
    ? []
    : Array.from(
        new Set(
          [
            ...(linkRows ?? []).map((r) => r.audio_carried_from as string | null),
            ...Array.from(transcriptByLink.values()).map((t) => t.carried_from),
          ].filter(Boolean) as string[]
        )
      );
  const carriedAt = new Map<string, string>();
  if (carryIds.length) {
    const { data: srcRows, error: srcErr } = await supabase
      .from("client_review_links")
      .select("id,created_at")
      .in("id", carryIds)
      .abortSignal(AbortSignal.timeout(timeoutMs));
    if (srcErr) failure = failure ?? srcErr;
    for (const s of srcRows ?? []) carriedAt.set(s.id as string, s.created_at as string);
  }

  if (failure) {
    const msg = String((failure as { message?: unknown }).message ?? failure);
    (args.log ?? ((l: string) => console.warn(l)))(
      JSON.stringify({
        tag: "drawer_partial",
        part: "review_links",
        reason: /abort|timeout/i.test(msg) ? "timeout" : "error",
        detail: msg.slice(0, 200),
        ms: Math.round(performance.now() - start),
        production_id: productionId,
      })
    );
    return { links: null, incomplete: true };
  }

  const links = (linkRows ?? []).map((r) => {
    const tr = transcriptByLink.get(r.id as string) ?? null;
    const audioFrom = (r.audio_carried_from as string | null) ?? null;
    return {
      id: r.id as string,
      url: `${origin}/r/${r.token as string}`,
      scope: (r.scope as string) ?? "all",
      created_at: r.created_at as string,
      audio_link: (r.audio_link as string | null) ?? null,
      audio_carried_from_at: audioFrom ? carriedAt.get(audioFrom) ?? null : null,
      transcript: tr
        ? {
            source: tr.source,
            char_count: tr.char_count,
            carried_from_at: tr.carried_from ? carriedAt.get(tr.carried_from) ?? null : null,
          }
        : null,
    };
  });
  return { links, incomplete: false };
}
