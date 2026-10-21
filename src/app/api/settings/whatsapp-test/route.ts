import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isStrictOwner } from "@/lib/roles";
import { isWhatsappDryRun, sendWhatsapp, templatePayload } from "@/lib/whatsapp/client";
import {
  TEMPLATE_OPS_ALERT,
  TEMPLATE_OPS_ALERT_TEXT,
  TEMPLATE_OPS_ALERT_VARS,
  buildNotificationRows,
  templateSendLanguage,
} from "@/lib/whatsapp/notify";
import {
  OPS_TEST_EVENT,
  OPS_TEST_PARAMS,
  maskWaId,
  opsTestRecipient,
  opsTestWaitSeconds,
} from "@/lib/whatsapp/opsTest";

// B38-7 — "שליחת התראת בדיקה" (owner, 22.10). ONE bizi_ops_alert to the
// owner's own number (opsTest.ts), never to the bookkeeper or anyone else.
//
// Not through recordBookingNotification, on purpose: that path answers with
// counts, and the point of this button is the EXACT answer — Meta's message id
// or Meta's own error text. It still leaves the same trail: a wa_messages row
// (so the delivery webhook can move it to delivered / read) and an event.
//
// It is sent even when WHATSAPP_TEMPLATES_APPROVED does not list the template:
// whether Meta approved it is precisely what this button finds out. A dry run
// (WHATSAPP_DRY_RUN not "false") sends nothing and says so.

const fill = (text: string, params: readonly string[]) =>
  params.reduce((t, p, i) => t.split(`{{${i + 1}}}`).join(p), text);

export async function POST() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!isStrictOwner(profile)) return NextResponse.json({ error: "בעלים בלבד" }, { status: 403 });

  const to = opsTestRecipient(profile?.role, process.env.WHATSAPP_NOTIFY_NUMBERS);
  if (!to) return NextResponse.json({ error: "בעלים בלבד" }, { status: 403 });

  const admin = createAdminClient();
  const now = new Date();

  // once a minute, over every test by anyone (the events table is the clock)
  const { data: last } = await admin
    .from("events")
    .select("created_at")
    .eq("event_type", OPS_TEST_EVENT)
    .order("created_at", { ascending: false })
    .limit(1);
  const wait = opsTestWaitSeconds(last?.[0]?.created_at ?? null, now);
  if (wait > 0) {
    return NextResponse.json({ error: `אפשר לשלוח בדיקה פעם בדקה — נסו שוב בעוד ${wait} שניות` }, { status: 429 });
  }

  const language = templateSendLanguage(TEMPLATE_OPS_ALERT) ?? "he";
  const params = [...OPS_TEST_PARAMS];
  const dryRun = isWhatsappDryRun();
  const [row] = buildNotificationRows({
    kind: "ops-alert",
    subjectId: `test:${now.toISOString()}`,
    recipients: [to],
    templateName: TEMPLATE_OPS_ALERT,
    params,
    variables: Object.fromEntries(TEMPLATE_OPS_ALERT_VARS.map((k, i) => [k, params[i]])),
    body: fill(TEMPLATE_OPS_ALERT_TEXT, params),
    status: dryRun ? "dry_run" : "queued",
    language,
  });
  await admin.from("wa_messages").insert(row);

  const result = await sendWhatsapp(templatePayload({ to, name: TEMPLATE_OPS_ALERT, language, params }));
  const at = new Date().toISOString();
  if (result.ok && !result.dryRun) {
    await admin.from("wa_messages").update({ status: "sent", provider_wamid: result.providerWamid, status_at: at }).eq("wamid", row.wamid);
  } else if (!result.ok) {
    await admin.from("wa_messages").update({ status: "failed", error: result.error, status_at: at }).eq("wamid", row.wamid);
  }

  const outcome = !result.ok ? "failed" : result.dryRun ? "dry_run" : "sent";
  await admin.from("events").insert({
    entity_type: "wa_template",
    entity_id: crypto.randomUUID(),
    event_type: OPS_TEST_EVENT,
    actor_id: user.id,
    payload: {
      template: TEMPLATE_OPS_ALERT,
      language,
      to_last4: to.slice(-4),
      outcome,
      provider_wamid: result.ok && !result.dryRun ? result.providerWamid : null,
      error: result.ok ? null : result.error,
    },
  });

  const toMasked = maskWaId(to);
  if (!result.ok) return NextResponse.json({ ok: false, to: toMasked, error: result.error }, { status: 502 });
  if (result.dryRun) return NextResponse.json({ ok: true, dryRun: true, to: toMasked });
  return NextResponse.json({ ok: true, dryRun: false, to: toMasked, providerWamid: result.providerWamid });
}
