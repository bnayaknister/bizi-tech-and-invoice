import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// "חומרים נוספים" on a review round (0076): a transcript and a separate audio
// file. Things the client RECEIVES — the public page shows them with no
// approve/reject buttons, and nothing here touches approvals, statuses or
// documents.
//
// PERMISSION — measured, not assumed (rule 49). can_edit_stages, the same gate
// the three routes that already write a round's media use: review-link mint
// (route.ts:16-17), review-items (route.ts:22), review-current (route.ts:38).
// Then the service role does the writing: client_review_transcripts is revoked
// outright with RLS on and zero policies (0076 §3), exactly like
// client_review_items, so `authenticated` cannot reach it directly at all.
//
// ═══ WHICH ROUND IT WRITES TO — it refuses rather than guesses ═══
// "The production's live link" is NOT a single row. createReviewLink only
// supersedes OVERLAPPING scopes (links.ts:35-42), so an 'episode' link and a
// 'reels' link live side by side by design — that is the B1 behaviour the
// comment there protects. Picking the newest of the two would attach an hour of
// speech to whichever round happened to be minted last.
//
// So: `link_id` is honoured when the caller sends one, and when it does not,
// this resolves the live round ONLY if there is exactly one. Two live rounds is
// a 409 that names them, not a coin flip. Same shape as
// resolveParentWorkOrderLink (issue.ts:268-270), which refuses to pick between
// two issued work orders for the same reason: there is no undo.
//
// A superseded or already-answered round is refused too. The transcript
// describes the cut the client is being shown; writing one onto a round that
// has already been answered changes the record of what they answered to.

type TranscriptIn = { content?: unknown; source?: unknown };

// The transcript BODY, on explicit request only.
//
// The drawer's own payload carries source + char_count and never the text
// (entity route): a one-line summary does not need an hour of speech, and
// shipping it on every drawer open would put it in memory, in the network log
// and in any future cache, for a reader who did not ask. "הצג" is the ask, and
// this is what answers it. Same gate as the write — the table is service-role
// only, so there is no path to it that skips this check.
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_stages").eq("id", user.id).single();
  if (!profile?.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  const linkId = new URL(request.url).searchParams.get("link_id");
  if (!linkId) return NextResponse.json({ error: "חסר link_id" }, { status: 400 });

  const admin = createAdminClient();
  // production-scoped, so a link id from another production cannot be read
  // through this production's URL
  const { data: link } = await admin
    .from("client_review_links")
    .select("id")
    .eq("id", linkId)
    .eq("production_id", params.id)
    .maybeSingle();
  if (!link) return NextResponse.json({ error: "הלינק אינו שייך להפקה הזאת" }, { status: 404 });

  const { data: tr, error } = await admin
    .from("client_review_transcripts")
    .select("content,source,char_count,created_at")
    .eq("link_id", linkId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!tr) return NextResponse.json({ transcript: null });

  return NextResponse.json({
    transcript: {
      content: tr.content as string,
      source: tr.source as string,
      char_count: (tr.char_count as number | null) ?? null,
      created_at: tr.created_at as string,
    },
  });
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_stages").eq("id", user.id).single();
  if (!profile?.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    link_id?: unknown;
    audio_link?: unknown;
    transcript?: TranscriptIn | null;
  };

  // `undefined` and `null` are different instructions here and the difference is
  // the whole editing model: absent = leave alone, null = clear. A single
  // `?? null` anywhere in this route would turn "I only changed the audio" into
  // "delete the transcript".
  const wantsAudio = Object.prototype.hasOwnProperty.call(body, "audio_link");
  const wantsTranscript = Object.prototype.hasOwnProperty.call(body, "transcript");
  if (!wantsAudio && !wantsTranscript) {
    return NextResponse.json({ error: "אין מה לעדכן" }, { status: 400 });
  }

  const admin = createAdminClient();

  // ---- resolve the round -------------------------------------------------
  const linkId = typeof body.link_id === "string" && body.link_id.trim() ? body.link_id.trim() : null;
  const { data: liveLinks, error: linksErr } = await admin
    .from("client_review_links")
    .select("id,scope,superseded,responded_at,expires_at")
    .eq("production_id", params.id)
    .eq("superseded", false)
    .is("responded_at", null)
    .order("created_at", { ascending: false });
  if (linksErr) return NextResponse.json({ error: linksErr.message }, { status: 500 });

  const live = liveLinks ?? [];
  let target: { id: string; scope: string } | null = null;

  if (linkId) {
    // Scoped to THIS production on purpose: link_id is client-supplied, and
    // without the production filter above it would address any round in the
    // table. The row is only accepted if it is also live.
    const hit = live.find((l) => l.id === linkId);
    if (!hit) {
      return NextResponse.json(
        { error: "הלינק אינו סבב חי של ההפקה הזאת (נעקף, כבר נענה, או שייך להפקה אחרת)" },
        { status: 404 }
      );
    }
    target = { id: hit.id, scope: hit.scope as string };
  } else if (live.length === 1) {
    target = { id: live[0].id, scope: live[0].scope as string };
  } else if (live.length === 0) {
    return NextResponse.json(
      { error: "אין סבב ביקורת חי להפקה — צור לינק אישור לפני הוספת חומרים" },
      { status: 409 }
    );
  } else {
    return NextResponse.json(
      {
        error: `יש ${live.length} סבבים חיים (${live.map((l) => l.scope).join(", ")}) — ציין לאיזה סבב לשמור`,
        links: live.map((l) => ({ id: l.id, scope: l.scope })),
      },
      { status: 409 }
    );
  }

  // ---- validate before writing anything ----------------------------------
  let audioLink: string | null = null;
  if (wantsAudio) {
    const raw = typeof body.audio_link === "string" ? body.audio_link.trim() : "";
    audioLink = raw || null; // empty string clears, same as the media-link fields
    if (audioLink && !/^https?:\/\//i.test(audioLink)) {
      return NextResponse.json({ error: "קישור האודיו חייב להתחיל ב-http:// או ב-https://" }, { status: 400 });
    }
  }

  type Parsed = { content: string; source: "pasted" | "link" } | null;
  let transcript: Parsed = null;
  if (wantsTranscript && body.transcript !== null) {
    const t = body.transcript ?? {};
    const source = t.source;
    // 'auto' is a valid value in the CHECK constraint and is deliberately NOT
    // writable here: it is reserved for the future job that transcribes from
    // the audio, and that job needs `source` to tell its own previous output
    // from an hour of a human's corrections (0076, on the source column). A
    // human paste that claimed to be 'auto' would be overwritten by it.
    if (source === "auto") {
      return NextResponse.json(
        { error: "source=auto שמור לתמלול אוטומטי עתידי ואינו נכתב מכאן" },
        { status: 400 }
      );
    }
    if (source !== "pasted" && source !== "link") {
      return NextResponse.json({ error: "source חייב להיות pasted או link" }, { status: 400 });
    }
    const content = typeof t.content === "string" ? t.content.trim() : "";
    if (!content) {
      return NextResponse.json({ error: "תמלול ריק — לשמירה יש להזין תוכן, ולמחיקה לשלוח transcript: null" }, { status: 400 });
    }
    if (source === "link" && !/^https?:\/\//i.test(content)) {
      return NextResponse.json({ error: "תמלול מסוג link חייב להיות כתובת http:// או https://" }, { status: 400 });
    }
    transcript = { content, source };
  }

  // ---- write -------------------------------------------------------------
  if (wantsAudio) {
    const { error } = await admin
      .from("client_review_links")
      .update({ audio_link: audioLink })
      .eq("id", target.id);
    if (error) return NextResponse.json({ error: `שמירת האודיו נכשלה: ${error.message}` }, { status: 500 });
  }

  // char_count is GENERATED (0076) — never sent, always read back. Sending it
  // would be rejected by Postgres, and computing it here would be the second
  // source of a fact the column already owns.
  let charCount: number | null = null;
  if (wantsTranscript) {
    if (transcript) {
      const { data: saved, error } = await admin
        .from("client_review_transcripts")
        .upsert(
          {
            link_id: target.id,
            content: transcript.content,
            source: transcript.source,
            created_by: user.id,
          },
          { onConflict: "link_id" }
        )
        .select("char_count")
        .single();
      if (error) return NextResponse.json({ error: `שמירת התמלול נכשלה: ${error.message}` }, { status: 500 });
      charCount = (saved?.char_count as number | null) ?? null;
    } else {
      const { error } = await admin.from("client_review_transcripts").delete().eq("link_id", target.id);
      if (error) return NextResponse.json({ error: `מחיקת התמלול נכשלה: ${error.message}` }, { status: 500 });
    }
  }

  // One event per round, describing what actually moved. The transcript's own
  // text never enters the payload — events are read on screens that have no
  // business holding an hour of speech, and pipeline logs are sanitised for
  // exactly this class of content.
  const changed: string[] = [];
  if (wantsAudio) changed.push(audioLink ? "אודיו עודכן" : "אודיו הוסר");
  if (wantsTranscript) {
    changed.push(
      transcript === null
        ? "תמלול הוסר"
        : transcript.source === "link"
          ? "תמלול עודכן (קישור)"
          : `תמלול עודכן, ${charCount ?? 0} תווים`
    );
  }
  await admin.from("events").insert({
    entity_type: "production",
    entity_id: params.id,
    event_type: "review_materials_updated",
    actor_id: user.id,
    payload: {
      link_id: target.id,
      scope: target.scope,
      summary: changed.join(" · "),
      ...(wantsAudio ? { audio_link: audioLink } : {}),
      ...(wantsTranscript ? { transcript_source: transcript?.source ?? null, char_count: charCount } : {}),
    },
  });

  return NextResponse.json({
    ok: true,
    link_id: target.id,
    scope: target.scope,
    ...(wantsAudio ? { audio_link: audioLink } : {}),
    ...(wantsTranscript
      ? { transcript: transcript ? { source: transcript.source, char_count: charCount } : null }
      : {}),
  });
}
