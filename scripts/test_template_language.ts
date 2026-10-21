/**
 * B25 — the language each template is sent in comes from ONE map,
 * TEMPLATE_REGISTERED_LANGUAGE, that must match WhatsApp Manager.
 * `bizi_unknown_contact` is registered as English (Hebrew text) and failed
 * 132001 on every send while it went out as "he".
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_template_language.ts
 *
 * ═══ F19 ═══
 * No database, no network. The database is scripts/_fake_db.ts. `fetch` is a
 * local stub that RECORDS the Graph body and answers itself — nothing leaves
 * the process; the token below is a dummy.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fakeDb } from "./_fake_db";
import * as notify from "../src/lib/whatsapp/notify";
import {
  TEMPLATE_REGISTERED_LANGUAGE,
  recordBookingNotification,
  templateSendLanguage,
} from "../src/lib/whatsapp/notify";

process.env.WHATSAPP_NOTIFY_NUMBERS = "972500000001,972500000002";
process.env.WHATSAPP_TOKEN = "dummy-token-not-real";
process.env.WHATSAPP_PHONE_NUMBER_ID = "000000000000";

const graphBodies: { template?: { name: string; language: { code: string } } }[] = [];
global.fetch = (async (url: string, init?: { body?: string }) => {
  if (!String(url).startsWith("https://graph.facebook.com/")) throw new Error("F19: unexpected fetch " + url);
  graphBodies.push(JSON.parse(init?.body ?? "{}"));
  return new Response(JSON.stringify({ messages: [{ id: `wamid.stub${graphBodies.length}` }] }), { status: 200 });
}) as unknown as typeof fetch;

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}\n     got:  ${g}\n     want: ${w}`);
  }
}

function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? srcFiles(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

function world() {
  return fakeDb({ events: [], wa_messages: [] }, { unique: [], now: () => new Date("2026-10-11T19:00:00Z") });
}

async function main() {
  console.log("\n=== 1. the map ===");
  check("the map, exactly as registered in WhatsApp Manager (11.10)", TEMPLATE_REGISTERED_LANGUAGE, {
    bizi_booking_approved: "he",
    bizi_booking_pending: "he",
    bizi_booking_change: "he",
    bizi_client_registration: "he",
    bizi_unknown_contact: "en",
    bizi_client_approved: "client",
    // B38 (21.10): the operational alert — to be registered in WhatsApp Manager as Hebrew
    bizi_ops_alert: "he",
  });
  check("bizi_unknown_contact -> en", templateSendLanguage("bizi_unknown_contact"), "en");
  check("bizi_booking_approved -> he", templateSendLanguage("bizi_booking_approved"), "he");
  check("bizi_client_approved -> the client's language (en)", templateSendLanguage("bizi_client_approved", "en"), "en");
  check("bizi_client_approved -> the client's language (he)", templateSendLanguage("bizi_client_approved", "he"), "he");
  check("bizi_client_approved without a client language -> null, not a guess", templateSendLanguage("bizi_client_approved"), null);
  check("a template not in the map -> null, not 'he'", templateSendLanguage("bizi_anything_new"), null);

  console.log("\n=== 2. every template the code sends is in the map ===");
  // (a) every exported TEMPLATE_* name constant
  const exported = Object.entries(notify)
    .filter(([k, v]) => /^TEMPLATE_[A-Z_]+$/.test(k) && typeof v === "string" && /^bizi_/.test(v))
    .map(([, v]) => v as string);
  // (b) every "bizi_*" string literal anywhere under src/
  const literals = new Set<string>();
  for (const f of srcFiles(join(__dirname, "..", "src"))) {
    Array.from(readFileSync(f, "utf8").matchAll(/"(bizi_[a-z_]+)"/g)).forEach((m) => literals.add(m[1]));
  }
  const sent = Array.from(new Set(exported.concat(Array.from(literals)))).sort();
  check("found the seven templates (B38: + bizi_ops_alert)", sent.length, 7);
  check("every one of them has a language in the map", sent.filter((t) => !(t in TEMPLATE_REGISTERED_LANGUAGE)), []);
  check("…and the map has nothing the code does not send", Object.keys(TEMPLATE_REGISTERED_LANGUAGE).filter((t) => !sent.includes(t)), []);

  console.log("\n=== 3. what actually goes to Graph (stubbed fetch) ===");
  process.env.WHATSAPP_DRY_RUN = "false";
  {
    const { client, store } = world();
    const r = await recordBookingNotification(client, {
      kind: "unknown-contact", subjectId: "unknown:972500000009:2026-10-11", waId: "972500000009", excerpt: "שלום", onlyOwner: true,
    });
    check("unknown-contact: sent once", [r.sent, r.failed], [1, 0]);
    check("🔴 …in English, the language it is registered under", graphBodies.at(-1)?.template?.language.code, "en");
    check("…and the row's payload says so", (store.wa_messages[0]?.payload as { language?: string })?.language, "en");
  }
  {
    const { client } = world();
    await recordBookingNotification(client, {
      kind: "client-registration", subjectId: "reg:x", event: "new", name: "א", podcast: "ב", waId: "972500000009", details: "ד",
    });
    check("client-registration: in Hebrew", graphBodies.at(-1)?.template?.language.code, "he");
  }

  console.log("\n=== 4. a template missing from the map is not sent ===");
  {
    const saved = TEMPLATE_REGISTERED_LANGUAGE.bizi_unknown_contact;
    delete TEMPLATE_REGISTERED_LANGUAGE.bizi_unknown_contact;
    const before = graphBodies.length;
    const { client, store } = world();
    const r = await recordBookingNotification(client, {
      kind: "unknown-contact", subjectId: "unknown:972500000008:2026-10-11", waId: "972500000008", excerpt: "x", onlyOwner: true,
    });
    check("reported as unmapped", r.unmappedLanguage, true);
    check("nothing sent to Graph", graphBodies.length, before);
    check("no wa_messages row", store.wa_messages.length, 0);
    check("…an event says why", store.events.map((e) => [e.event_type, (e.payload as { template?: string })?.template]), [
      ["notification_skipped_template_language_unmapped", "bizi_unknown_contact"],
    ]);
    TEMPLATE_REGISTERED_LANGUAGE.bizi_unknown_contact = saved;
  }
  process.env.WHATSAPP_DRY_RUN = "true";

  console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
