/**
 * B38-7 — "שליחת התראת בדיקה" and the alert recipients on the settings screen.
 * Pure + render + source reads. No Supabase, no Meta, no network.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_b38_whatsapp_test_alert.tsx
 */
import React from "react";
import { readFileSync } from "fs";
import { join } from "path";
import { renderToString } from "react-dom/server";
import {
  OPS_TEST_FALLBACK_WA_ID,
  OPS_TEST_PARAMS,
  alertRecipientsView,
  maskWaId,
  opsTestRecipient,
  opsTestWaitSeconds,
} from "../src/lib/whatsapp/opsTest";
import { RecipientsList, TestResultLine } from "../src/app/settings/WhatsAppAlertsCard";
import { TEMPLATE_OPS_ALERT_TEXT, TEMPLATE_OPS_ALERT_VARS } from "../src/lib/whatsapp/notify";

let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("network is forbidden in this test");
}) as unknown as typeof fetch;

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ""}`);
  }
}
const eq = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
const render = (el: React.ReactElement) => renderToString(el).replace(/<!-- -->/g, "");

console.log("\n=== 1. who gets the test ===");
eq("owner -> the first notify number", opsTestRecipient("owner", "972528933975,972541112222"), "972528933975");
eq("owner, another first number -> that one", opsTestRecipient("owner", "972541112222,972528933975"), "972541112222");
eq("owner, nothing set -> Bnaya's number", opsTestRecipient("owner", undefined), OPS_TEST_FALLBACK_WA_ID);
eq("owner, only a malformed entry -> Bnaya's number", opsTestRecipient("owner", "050-123"), OPS_TEST_FALLBACK_WA_ID);
eq("admin -> nobody (owner only)", opsTestRecipient("admin", "972528933975"), null);
eq("bookkeeper -> nobody", opsTestRecipient("bookkeeper", "972528933975"), null);
eq("no role -> nobody", opsTestRecipient(null, "972528933975"), null);

console.log("\n=== 2. once a minute ===");
const now = new Date("2026-10-22T10:00:00Z");
eq("never sent -> 0", opsTestWaitSeconds(null, now), 0);
eq("20s ago -> wait 40", opsTestWaitSeconds("2026-10-22T09:59:40Z", now), 40);
eq("59.5s ago -> wait 1", opsTestWaitSeconds("2026-10-22T09:59:00.500Z", now), 1);
eq("exactly 60s ago -> 0", opsTestWaitSeconds("2026-10-22T09:59:00Z", now), 0);
eq("an hour ago -> 0", opsTestWaitSeconds("2026-10-22T09:00:00Z", now), 0);
eq("garbage -> 0", opsTestWaitSeconds("not a date", now), 0);

console.log("\n=== 3. the words of the test ===");
eq("{{1}} {{2}} {{3}} — owner wording", [...OPS_TEST_PARAMS], ["בדיקה – התראות מהמערכת", "אין צורך לפעול", "להתעלם מההודעה"]);
ok("three params for three placeholders", OPS_TEST_PARAMS.length === TEMPLATE_OPS_ALERT_VARS.length && TEMPLATE_OPS_ALERT_TEXT.includes("{{3}}") && !TEMPLATE_OPS_ALERT_TEXT.includes("{{4}}"));
ok("no newline in a parameter (Meta)", OPS_TEST_PARAMS.every((p) => !/\n/.test(p) && p.trim() === p));

console.log("\n=== 4. masked, normalised recipients ===");
eq("mask: last four only", maskWaId("972528933975"), "••••••••3975");
eq("mask: short stays", maskWaId("1234"), "1234");
{
  const v = alertRecipientsView("972528933975,972541112222,abc", "050-765-4321, +972 50 765 4321, 12");
  eq("notify: normalised + masked, order kept", v.notify, ["••••••••3975", "••••••••2222"]);
  eq("…one refused entry counted", v.notifyRejected, 1);
  eq("billing: 050… and +972… are one number, masked", v.billing, ["••••••••4321"]);
  eq("…the malformed one counted (a duplicate is not)", v.billingRejected, 1);
  ok("no full number anywhere in the view", !JSON.stringify(v).includes("972528933975") && !JSON.stringify(v).includes("7654321"));
}
{
  const v = alertRecipientsView(undefined, undefined);
  eq("nothing set -> empty lists", [v.notify, v.billing, v.notifyRejected, v.billingRejected], [[], [], 0, 0]);
}

console.log("\n=== 5. render ===");
{
  const html = render(<RecipientsList recipients={alertRecipientsView("972528933975", "0507654321")} />);
  ok("the owner number, masked, marked as the alerts receiver", html.includes("••••••••3975") && html.includes("מקבל את התראות המערכת"));
  ok("the bookkeeper's number, masked", html.includes("••••••••4321"));
  ok("no full number in the HTML", !html.includes("972528933975") && !html.includes("0507654321"));
}
ok("no recipients at all -> renders, says nothing is set", render(<RecipientsList recipients={null} />).includes("לא מוגדר מספר"));
ok("success line: the id", render(<TestResultLine result={{ ok: true, dryRun: false, to: "••••••••3975", providerWamid: "wamid.ABC" }} />).includes("נשלח בהצלחה") );
ok("…and the message id", render(<TestResultLine result={{ ok: true, dryRun: false, to: "••••••••3975", providerWamid: "wamid.ABC" }} />).includes("wamid.ABC"));
ok("failure line: Meta's exact error", render(<TestResultLine result={{ ok: false, error: "Template name does not exist in the translation (code 132001)" }} />).includes("Template name does not exist in the translation (code 132001)"));
ok("dry run line", render(<TestResultLine result={{ ok: true, dryRun: true, to: "x" }} />).includes("מצב יבש"));
eq("no result -> nothing", render(<TestResultLine result={null} />), "");

console.log("\n=== 6. the wiring (source) ===");
{
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf-8");
  const route = read("src/app/api/settings/whatsapp-test/route.ts");
  const code = route.replace(/\/\/.*$/gm, "");
  ok("route: owner only (strict, not admin)", code.includes("isStrictOwner(profile)") && !code.includes("hasOwnerAccess"));
  ok("…the one recipient comes from opsTestRecipient", code.includes("opsTestRecipient(profile?.role, process.env.WHATSAPP_NOTIFY_NUMBERS)") && code.includes("recipients: [to]"));
  ok("…the bookkeeper's numbers are never read", !code.includes("WHATSAPP_BILLING_NOTIFY_NUMBERS") && !code.includes("recordBookingNotification"));
  ok("…once a minute, 429", code.includes("opsTestWaitSeconds(") && code.includes("status: 429"));
  ok("…an event and a wa_messages row", code.includes("event_type: OPS_TEST_EVENT") && code.includes('from("wa_messages").insert(row)'));
  ok("…Meta's error returned as is", code.includes("error: result.error"));
  const page = read("src/app/settings/page.tsx");
  ok("settings page: the card only for the owner, numbers masked on the server", page.includes("isStrictOwner(profile) ? (") && page.includes("alertRecipientsView(process.env.WHATSAPP_NOTIFY_NUMBERS, process.env.WHATSAPP_BILLING_NOTIFY_NUMBERS)"));
  const card = read("src/app/settings/WhatsAppAlertsCard.tsx");
  ok("…the card reads no environment", !card.includes("process.env"));
}

eq("no network call", fetchCalls, 0);
console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
