// ═══════════════════════════════════════════════════════════════════════════
// The WhatsApp Cloud API side of the bot. E9-1 CONTAINS THE SWITCH AND
// NOTHING ELSE — no send function exists yet, on purpose.
// ═══════════════════════════════════════════════════════════════════════════
//
// E9-1's deliverable is "every message that reaches the bot number is
// recorded, and nothing is sent". A send function written now would be a
// function nobody calls, nobody tests against a real template, and whoever
// adds the first caller in E9-2 would be trusting code that has never run.
// So the module starts with the one thing E9-1 genuinely needs: the safety
// switch, in place BEFORE the first line of code that could send anything.
//
// ═══ DRY_RUN, THE SAME SHAPE AS THE OTHER TWO (rule 40) ═══
// `isWhatsappDryRun()` mirrors `isCalendarDryRun()` (lib/calendar/write.ts:43)
// and `isDryRun()` (lib/morning/client.ts:35) exactly — including the
// `!== "false"` comparison, which is the whole point and not a stylistic
// choice:
//
//   🔴 **DEFAULTS ON.** An unset variable, a typo'd variable, a new Vercel
//      environment that nobody configured, a preview deployment, a local
//      `.env.local` copied from a teammate — every one of those is a dry run.
//      The ONLY way to send a real message is the exact string "false", typed
//      deliberately into the one environment that should send.
//
//   ⛔ Do NOT "simplify" this to `=== "true"`. It reads the same on the happy
//      path and inverts the failure: a mistyped `WHATSAPP_DRY_RUN=fasle` would
//      then start messaging real clients from a preview deployment.
//
// What a dry run will mean once E9-2 adds sending: no network call to Graph,
// and the payload recorded in `wa_messages` with `status = 'dry_run'` (0101
// carries that value in its CHECK for exactly this reason). The whole chain —
// webhook in, decision, message out — is then testable with no Meta account
// at all, which is what makes E9-1 and E9-2 verifiable on Meta's free test
// number.

/**
 * `true` unless `WHATSAPP_DRY_RUN` is exactly the string `"false"`.
 *
 * Read at CALL time and never cached in a module constant: Vercel runs these
 * as serverless functions and a cached boolean would outlive an environment
 * change for the lifetime of a warm instance. Same reason the other two read
 * it per call.
 */
export function isWhatsappDryRun(): boolean {
  return process.env.WHATSAPP_DRY_RUN !== "false";
}
