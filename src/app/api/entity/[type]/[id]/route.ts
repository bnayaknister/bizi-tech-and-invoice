import { NextResponse } from "next/server";
import { PERF_OFF, perfTimer } from "@/lib/perf/timing";
import { entityGet } from "@/lib/drawer/entityGet";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionAndProfile } from "@/lib/profile";
import {
  ENTITY_CONFIG,
  ENTITY_TYPES,
  editableKeys,
  selectColumns,
  MORNING_ONLY_CLIENT_KEYS,
  type EntityType,
} from "@/lib/entities";
import { validateTaxId } from "@/lib/clients/taxId";
import { morningFailureMessage } from "@/lib/clients/morningFailure";
import { SupabaseReadError } from "@/lib/supabase/unwrap";
import { getAppBaseUrl } from "@/lib/appUrl";

// EntityDrawer backend. Everything flows through the user's own client so
// RLS and the 0010 column-guard triggers are the real gates; the field
// registry decides which columns are even selected (a field without view
// permission is never in the response), and events are written through the
// service client stamped with the acting user.
//
// ─── This route stays on the UNTYPED supabase client. By decision, not debt.
//
// It is a generic entity gateway: both the table (`config.table`) and the
// column list (`selectColumns(type, profile)`) are resolved at runtime from
// the field registry and the caller's permissions. That indirection is the
// feature — one route serves every entity, and a field's visibility is
// declared once in lib/entities.ts rather than duplicated per endpoint.
//
// A schema-aware client wants both of those as compile-time literals. Measured
// 2026-08-12: adding the generic here produces 12 of the repo's 35 errors, and
// every one of them is TypeScript objecting to the dynamism on purpose. The
// only way to satisfy it would be to unroll the registry into a literal per
// entity — trading the single source of truth for type coverage on a route
// whose whole job is to not have one.
//
// So: this file is deliberately excluded. Its safety net is the field registry
// plus RLS plus the DB guards, not the type system. Everything else in the repo
// should move to the typed client; do not "fix" this one to match.

function parseType(type: string): EntityType | null {
  return (ENTITY_TYPES as string[]).includes(type) ? (type as EntityType) : null;
}

// A read that fails must reach the caller as a failure. Without this the
// SupabaseReadError below would surface as a bare 500 with no message; with
// it, the drawer shows which read broke and why (see lib/supabase/unwrap.ts).
export async function GET(
  request: Request,
  ctx: { params: { type: string; id: string } }
) {
  try {
    return await handleGet(request, ctx);
  } catch (e) {
    if (e instanceof SupabaseReadError) {
      console.error("[entity]", e);
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    throw e;
  }
}

async function handleGet(
  request: Request,
  { params }: { params: { type: string; id: string } }
) {
  const type = parseType(params.type);
  if (!type) return NextResponse.json({ error: "סוג ישות לא מוכר" }, { status: 400 });
  // T35: only the production drawer is timed (PERF_TIMING=true); every other
  // entity type gets the no-op timer
  const perf = type === "production" ? perfTimer("/api/entity/production/[id]") : PERF_OFF;
  const { user, profile } = await getSessionAndProfile(perf);
  if (!user || !profile?.approved) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  // T34: everything after authentication lives in lib/drawer/entityGet.ts,
  // in two parallel waves instead of ~12 sequential steps.
  const r = await entityGet({
    type,
    id: params.id,
    user,
    profile,
    supabase: createClient(),
    admin: createAdminClient(),
    origin: getAppBaseUrl(request),
    perf,
  });
  const res = NextResponse.json(r.json, { status: r.status });
  perf.lap("build_response");
  if (perf.on) res.headers.set("Server-Timing", perf.done({ production_id: params.id, status: r.status }));
  return res;
}

export async function POST(
  request: Request,
  { params }: { params: { type: string; id: string } }
) {
  const type = parseType(params.type);
  if (!type) return NextResponse.json({ error: "סוג ישות לא מוכר" }, { status: 400 });
  const { user, profile } = await getSessionAndProfile();
  if (!user || !profile?.approved) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const body = (await request.json()) as {
    patch?: Record<string, unknown>;
    stage?: { id: string; patch: Record<string, unknown> };
    undoOf?: string; // event id this change reverts, for the audit trail
    confirm_morning?: boolean; // client edit: user confirmed the Morning propagation
  };
  const supabase = createClient();
  const admin = createAdminClient();
  const config = ENTITY_CONFIG[type];

  // --- stage sub-update (production drawer): RLS on stages is the gate ---
  if (type === "production" && body.stage) {
    const allowed = ["status", "assignee_id"];
    const stagePatch = Object.fromEntries(
      Object.entries(body.stage.patch).filter(([k]) => allowed.includes(k))
    );
    if (!Object.keys(stagePatch).length)
      return NextResponse.json({ error: "אין שדות מותרים בעדכון" }, { status: 400 });
    const { data, error } = await supabase
      .from("stages")
      .update(stagePatch)
      .eq("id", body.stage.id)
      .eq("production_id", params.id)
      .select("id,track,step,status,assignee_id,done_at");
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (!data?.length) return NextResponse.json({ error: "אין הרשאה לעדכן שלבים" }, { status: 403 });
    await admin.from("events").insert({
      entity_type: "production",
      entity_id: params.id,
      event_type: "stage_updated",
      actor_id: user.id,
      payload: { stage_id: body.stage.id, patch: stagePatch, source: "entity_drawer" },
    });
    return NextResponse.json({ ok: true, stage: data[0] });
  }

  // --- entity field update ---
  //
  // MORNING-ONLY FIELDS, lifted out BEFORE the allow-list runs.
  //
  // emails / phone / contactPerson live in Morning and nowhere else — `clients`
  // has no column for any of them. They cannot be registered in entities.ts:
  // selectColumns() turns every registered key straight into the PostgREST
  // select list (entities.ts:239-241), so a key with no column would 400 the
  // ENTIRE client card for every viewer, not just fail the new field. And they
  // must not reach `.update(patch)` below for the same reason.
  //
  // So they ride in the same PATCH, through the same double-confirmation gate,
  // the same event and the same 502/partial contract as the client NAME — and
  // are simply never part of the local write. One write path, not two.
  const rawPatch = (body.patch ?? {}) as Record<string, unknown>;
  // The list is DERIVED from entities.ts (MORNING_ONLY_CLIENT_FIELDS) and no
  // longer written out here. It used to be a hard-coded copy of three keys
  // sitting a file away from the client card they belong to; adding `taxId`
  // (7.10) would have made that two lists to keep in step, on a field that
  // prints on a tax document.
  const morningOnly: Record<string, unknown> = {};
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawPatch)) {
    if (MORNING_ONLY_CLIENT_KEYS.includes(k)) morningOnly[k] = v;
    else patch[k] = v;
  }
  const hasMorningOnly = Object.keys(morningOnly).length > 0;

  if (hasMorningOnly) {
    // Not a third gate: can_edit_money is exactly what guards the client name
    // (entities.ts:158). Contact details travel with the name.
    if (type !== "client")
      return NextResponse.json({ error: "פרטי קשר קיימים ללקוח בלבד" }, { status: 400 });
    if (!profile.can_edit_money)
      return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });
  }

  // 🔴 ח.פ / ע.מ — VALIDATED BEFORE ANYTHING ELSE HAPPENS, and refused rather
  // than coerced. This number prints on the client's invoice and the write is
  // remote, so a malformed value must not reach `updateClient`: there is no
  // local row to roll back and nothing to notice afterwards. Exactly 9 digits,
  // or an explicit "" to clear (owner 7.10) — the rule and the message both
  // live in lib/clients/taxId.ts, so no screen can reword either.
  if ("taxId" in morningOnly) {
    const verdict = validateTaxId(morningOnly.taxId);
    if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: 400 });
    // the normalised value replaces what arrived: trimmed, and "" when cleared
    morningOnly.taxId = verdict.value;
  }

  const allowed = editableKeys(type, profile);
  const rejected = Object.keys(patch).filter((k) => !allowed.has(k));
  if (rejected.length) {
    return NextResponse.json(
      { error: `אין הרשאה לערוך: ${rejected.join(", ")}` },
      { status: 403 }
    );
  }
  if (!Object.keys(patch).length && !hasMorningOnly)
    return NextResponse.json({ error: "אין שינויים" }, { status: 400 });

  const { data: before, error: beforeErr } = await supabase
    .from(config.table)
    .select(selectColumns(type, profile))
    .eq("id", params.id)
    .maybeSingle();
  if (beforeErr || !before)
    return NextResponse.json({ error: "לא נמצא או שאין הרשאה" }, { status: 404 });

  // Editing a MAPPED client's details propagates to Morning. We only propagate
  // the fields Morning actually holds — the client name, and since 2026-09-09
  // the contact block (emails / phone / contactPerson), which lives ONLY there.
  //
  // (Documents are deliberately absent here: an issued Morning document has
  // NO update endpoint — it's immutable by design — so it can never be edited
  // from the app. That boundary is enforced by there being no code path.)
  //
  // ---- POLICY CHANGE, owner 2026-08-23 -------------------------------------
  // This was Morning-first: a failed Morning write aborted the whole edit and
  // nothing was saved locally ("כשלון → לא מעודכן באף אחד", 2026-07-21). The
  // owner reversed it — local is the source of truth, Morning is a sync target.
  // So the local write ALWAYS happens; a Morning failure is reported, not
  // obeyed. The caller gets 502 with partial:true, meaning "your change is
  // saved, Morning is out of step, try the sync again".
  //
  // Consequence, stated rather than discovered later: a client can now be named
  // one thing here and another thing in Morning. Morning is what prints on the
  // client's invoice, so a partial edit that nobody retries is a real
  // divergence — which is exactly why it returns 502 and writes an event
  // instead of a quiet 200.
  //
  // The double-confirmation gate below is KEPT. Its old job was "you are about
  // to touch two systems, both or neither"; its job now is "you are about to
  // touch two systems, and one of them may not follow" — still worth a click.
  let morningPartial: { error: string; morning_client_id: string } | null = null;
  if (type === "client" && ("name" in patch || hasMorningOnly)) {
    const { data: mc } = await admin
      // clients-status: by id — the row being edited
      .from("clients")
      .select("morning_client_id,name")
      .eq("id", params.id)
      .maybeSingle();
    const morningId = mc?.morning_client_id as string | null;
    const nameChanged = "name" in patch && patch.name !== mc?.name;

    // What actually goes on the wire. Built with the measurements of 2026-09-09
    // in front of it (all recorded on updateClient in morning/client.ts):
    //
    //  · NO DIRTY-CHECKING. Every field the block holds is sent every time. A
    //    field resent at its current value does not register as a change, and
    //    three fields in one body move exactly those three — both measured. So
    //    "send what you have" is safe, and it is safer than diffing: a diff
    //    that is wrong writes the wrong thing.
    //  · emails is REPLACE-WHOLE. The caller sends the complete desired list,
    //    never a delta — there is no array merge to add or remove one address.
    //  · phone/contactPerson are cleared by an EXPLICIT "", never by omitting
    //    the key. toMorningText does that; createMorningClient's
    //    `if (fields.phone)` idiom is the opposite and must not be copied here.
    //  · `send` is NEVER SENT. It is read-only in the card. Morning recomputes
    //    it from emails and overwrites what you pass, so writing it would be a
    //    lie in both directions — and it is a toggle we have no contract for.
    const { toMorningText, normalizeMorningEmails } = await import("@/lib/morning/client");
    const morningFields: Record<string, unknown> = {};
    if (nameChanged) morningFields.name = patch.name;
    if ("emails" in morningOnly) morningFields.emails = normalizeMorningEmails(morningOnly.emails);
    if ("phone" in morningOnly) morningFields.phone = toMorningText(morningOnly.phone as string | null);
    if ("contactPerson" in morningOnly)
      morningFields.contactPerson = toMorningText(morningOnly.contactPerson as string | null);
    // toMorningText and NOT `if (value)`: an emptied ח.פ must go on the wire as
    // an explicit "", because omitting the key means "leave as is" and would
    // make clearing it silently do nothing (morning/client.ts:412, measured).
    // validateTaxId above has already normalised it to 9 digits or "".
    if ("taxId" in morningOnly) morningFields.taxId = toMorningText(morningOnly.taxId as string | null);

    if (morningId && Object.keys(morningFields).length) {
      if (!body.confirm_morning) {
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        if (nameChanged) changes.name = { from: mc?.name ?? null, to: patch.name };
        // The contact fields have no local "from" to show — Morning is the only
        // holder — so the confirmation lists what they are about to BECOME.
        for (const k of Object.keys(morningOnly)) changes[k] = { from: null, to: morningFields[k] };
        return NextResponse.json({ needs_morning_confirmation: true, changes }, { status: 409 });
      }
      // 🔴 The OLD ח.פ, read from Morning, for the audit record — and read only
      // on the write path (a confirmed taxId change), never on an ordinary
      // name or contacts save. One extra GET on a rare, double-confirmed,
      // invoice-bearing field is proportionate; adding it to every client edit
      // would double the window in which Morning being slow costs the save.
      //
      // Not taken from the request. The screen HAS the old value on hand, and
      // accepting it would make the audit trail client-asserted — the one
      // record of what a tax number used to be must come from the system that
      // holds it. `getClientContacts` degrades (`ok:false`) rather than
      // throwing, and an unreadable old value is recorded AS unknown rather
      // than blocking the fix: refusing to let someone correct a ח.פ because
      // Morning would not say what it was is the wrong failure.
      let taxIdFrom: string | null = null;
      let taxIdFromKnown = false;
      if ("taxId" in morningOnly) {
        const { getClientContacts } = await import("@/lib/morning/client");
        const snapshot = await getClientContacts(morningId);
        taxIdFrom = snapshot.ok ? snapshot.contacts.taxId : null;
        taxIdFromKnown = snapshot.ok;
      }
      try {
        const { updateClient } = await import("@/lib/morning/client");
        await updateClient(morningId, morningFields);
        // Its own event, beside the generic `entity_updated` below — the owner
        // asked for this field by name (7.10). A ח.פ change is the one client
        // edit someone will come back and ask about months later ("which
        // number was on the invoice in March"), and finding it means grepping
        // one event_type rather than filtering every entity_updated payload.
        if ("taxId" in morningOnly) {
          await admin.from("events").insert({
            entity_type: "client",
            entity_id: params.id,
            event_type: "client_tax_id_changed",
            actor_id: user.id,
            payload: {
              from: taxIdFrom,
              to: morningOnly.taxId,
              // so a null `from` is never misread as "it was empty" when the
              // truth is "Morning would not tell us"
              from_known: taxIdFromKnown,
              morning_client_id: morningId,
              cleared: morningOnly.taxId === "",
            },
          });
        }
      } catch (e) {
        const { MorningError } = await import("@/lib/morning/client");
        const err = e instanceof MorningError ? e : null;
        const message = e instanceof Error ? e.message : "עדכון מורנינג נכשל";

        // "Nothing to push" and "the push failed" are separated ABOVE this
        // catch, not inside it: a client with no morning_client_id never enters
        // the block at all (`if (morningId && …)`), so it returns a quiet 200
        // and no event. That is the only benign case.
        //
        // Everything that reaches here is Morning answering with an error, and
        // all of it counts — 404 included. A 404 means the id we hold does not
        // exist there, so the name we just saved will never match the one on
        // the client's invoice; that is a divergence to surface, not to hide.
        // The status rides along in the event so a dead mapping can be told
        // apart from an outage without changing what the caller is told.
        await admin.from("events").insert({
          entity_type: "client",
          entity_id: params.id,
          event_type: "client_morning_update_failed",
          actor_id: user.id,
          payload: {
            // everything we tried to push, not just the name — a failed contact
            // sync is the same divergence and has to be as recoverable
            attempted: morningFields,
            error: message,
            morning_status: err?.status ?? null,
            morning_client_id: morningId,
          },
        });

        morningPartial = { error: message, morning_client_id: morningId };
      }
    }
  }

  // A contacts-only save has NOTHING to write locally — those fields have no
  // column. Running `.update({})` would be a no-op that PostgREST answers with
  // zero rows, which the line below reads as "no permission" and turns into a
  // spurious 403. So the local write is skipped, and `before` (already fetched,
  // already permission-checked) stands in as the row we hand back.
  const localKeys = Object.keys(patch);
  let updated: Record<string, unknown>[] | null = null;
  if (localKeys.length) {
    const res = await supabase
      .from(config.table)
      .update(patch)
      .eq("id", params.id)
      .select(selectColumns(type, profile));
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 400 });
    if (!res.data?.length) return NextResponse.json({ error: "אין הרשאה לעדכן" }, { status: 403 });
    updated = res.data as unknown as Record<string, unknown>[];
  } else {
    updated = [before as unknown as Record<string, unknown>];
  }

  const beforeRec = before as unknown as Record<string, unknown>;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of localKeys) {
    changes[k] = { from: beforeRec[k] ?? null, to: patch[k] ?? null };
  }
  // The Morning-only fields are evented too, but as "to" alone: there is no
  // local `from` to compare against, because we never held these values.
  for (const k of Object.keys(morningOnly)) {
    changes[k] = { from: null, to: morningOnly[k] ?? null };
  }
  await admin.from("events").insert({
    entity_type: type,
    entity_id: params.id,
    event_type: body.undoOf ? "entity_update_reverted" : "entity_updated",
    actor_id: user.id,
    payload: {
      changes,
      source: "entity_drawer",
      ...(body.confirm_morning ? { propagated_to_morning: true } : {}),
      ...(body.undoOf ? { undo_of: body.undoOf } : {}),
    },
  });

  // The local write above already happened and is kept. A Morning failure is
  // reported on top of it, never instead of it (owner 2026-08-23): 502 says
  // "not fully done", partial:true says "the half that matters locally IS
  // done", and entity carries the saved row so the screen can render the new
  // value while still showing the warning.
  if (morningPartial) {
    // 🔴 TWO DIFFERENT FAILURES, AND THEY MUST NOT READ THE SAME.
    //
    // "partial" means a local write happened and Morning did not follow. That
    // is the `name` case, and the sentence below is true for it.
    //
    // A MORNING-ONLY edit has no local write at all (`localKeys` is empty —
    // emails/phone/contactPerson/taxId have no columns), so when Morning fails
    // NOTHING changed anywhere. The old sentence said "השינוי נשמר אצלנו" to
    // that operator, which was false: it invited them to stop, believing half
    // the job was done, when in fact the retry is the whole job. Caught while
    // wiring the ח.פ field, whose approved wording (owner 7.10) states the
    // opposite in so many words — and it was already wrong for a contacts-only
    // save before taxId existed.
    // `localKeys` is the SAME list that decided whether to run the UPDATE
    // above, so the sentence and the write cannot disagree.
    const localWriteHappened = localKeys.length > 0;
    return NextResponse.json(
      {
        ok: false,
        partial: localWriteHappened,
        entity: updated[0],
        error: morningFailureMessage(morningPartial.error, localWriteHappened),
        morning_client_id: morningPartial.morning_client_id,
      },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, entity: updated[0] });
}
