import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { COPY, DEFAULT_LANG, LANG_WORDS, isLang, type Lang } from "./flow/copy";

// ═══════════════════════════════════════════════════════════════════════════
// The bot's language — E19. Which language a number reads, how it chooses, and
// how it switches.
// ═══════════════════════════════════════════════════════════════════════════
//
// ═══ THE RULES (owner decisions 11.10) ═══
//   · a number with no saved language is asked "עברית / English" FIRST, before
//     anything else — and whatever it wrote before choosing is not lost: the
//     inbound message's id rides on the picker's buttons, and after the choice
//     that message is answered as if it had just arrived;
//   · it can switch at any moment — a button in the menu, or typing "English" /
//     "עברית";
//   · the preference lives per NUMBER in `wa_contact_prefs` (0106), so it works
//     for a number that is linked to no podcast at all.
//
// ═══ 🔴 THE ACTIVATION SWITCH (rule 40: OFF unless exactly "true") ═══
// `WHATSAPP_BILINGUAL`. Off, the bot is exactly what it was: Hebrew, and no
// question. The English was approved by the owner on 11.10; turning the switch
// on is the remaining step.
//
// ═══ 🔴 THE STORE NEVER SILENCES THE BOT ═══
// A failed read is "Hebrew, do not ask"; a failed write still answers in the
// language just chosen (the next message simply asks again). A broken table is
// a degraded bot, never a mute one.

export function isBilingualOn(): boolean {
  return process.env.WHATSAPP_BILINGUAL === "true";
}

// ─── button ids ─────────────────────────────────────────────────────────────

const P = "lang:";

/**
 * The id on a language button. `pending` is the wamid of the message the client
 * wrote BEFORE choosing, carried so it can be answered after the choice.
 */
export function langButtonId(lang: Lang, pending?: string | null): string {
  return pending ? `${P}${lang}:${pending}` : `${P}${lang}`;
}

/** Meta's wamids are base64-ish ("wamid.HBgM…="); anything else is not ours. */
const WAMID_RE = /^[A-Za-z0-9._=+/-]{1,200}$/;

/**
 * A tapped id -> the language and the pending message, or null.
 *
 * 🔴 STRICT, because Meta echoes this string back verbatim and it is
 * attacker-controllable in principle. The pending wamid is only a POINTER: the
 * caller re-reads that message and honours it only if it came from THIS number.
 */
export function parseLangId(raw: unknown): { lang: Lang; pending: string | null } | null {
  if (typeof raw !== "string" || !raw.startsWith(P)) return null;
  const rest = raw.slice(P.length);
  const i = rest.indexOf(":");
  const lang = i < 0 ? rest : rest.slice(0, i);
  if (!isLang(lang)) return null;
  if (i < 0) return { lang, pending: null };
  const pending = rest.slice(i + 1);
  return WAMID_RE.test(pending) ? { lang, pending } : null;
}

/** Typed text -> a language, when it is EXACTLY one of the switch words. */
export function langFromText(text: string | null | undefined): Lang | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (t === "") return null;
  for (const lang of Object.keys(LANG_WORDS) as Lang[]) {
    if (LANG_WORDS[lang].includes(t)) return lang;
  }
  return null;
}

/** The language to read from a stored value — anything unexpected is Hebrew. */
export function langOrDefault(v: unknown): Lang {
  return isLang(v) ? v : DEFAULT_LANG;
}

// ─── the decision (PURE) ────────────────────────────────────────────────────

/**
 * What the MESSAGE itself says about the language, before any read:
 *   · a tap on a language button -> save it, and answer the held message if
 *     the button carried one (`resume`), else re-send the step (`switch`);
 *   · "English" / "עברית" typed  -> save it and re-send the step (`switch`);
 *   · anything else              -> null: look at the saved preference.
 */
export function languageFromMessage(input: {
  interactiveId: string | null;
  type: string;
  body: string | null;
}): { kind: "resume"; lang: Lang; pending: string } | { kind: "switch"; lang: Lang } | null {
  const tapped = parseLangId(input.interactiveId);
  if (tapped) return tapped.pending ? { kind: "resume", lang: tapped.lang, pending: tapped.pending } : { kind: "switch", lang: tapped.lang };
  const typed = input.type === "text" ? langFromText(input.body) : null;
  return typed ? { kind: "switch", lang: typed } : null;
}

/**
 * The saved preference -> use it, or ask. A failed read is Hebrew WITHOUT a
 * question: the store never silences the bot, and a question on every message
 * of a broken table would be worse than Hebrew.
 */
export function languageFromSaved(
  saved: { ok: true; lang: Lang | null } | { ok: false }
): { kind: "use"; lang: Lang } | { kind: "ask" } {
  if (!saved.ok) return { kind: "use", lang: DEFAULT_LANG };
  return saved.lang ? { kind: "use", lang: saved.lang } : { kind: "ask" };
}

/**
 * The question itself: bilingual by construction (the same text in both
 * dictionaries), two buttons, each carrying the held message's id.
 */
export function languageQuestion(heldWamid: string): {
  type: "buttons";
  body: string;
  buttons: { id: string; title: string }[];
} {
  const L = COPY.he.LANG;
  return {
    type: "buttons",
    body: L.pickerBody,
    buttons: [
      { id: langButtonId("he", heldWamid), title: L.pickHe },
      { id: langButtonId("en", heldWamid), title: L.pickEn },
    ],
  };
}

// ─── template language (client templates only) ──────────────────────────────

/**
 * Which language to send a CLIENT template in.
 *
 * ⚠️ ONLY `bizi_client_approved` GOES TO A CLIENT. The owner/Eli templates are
 * sent in the language they are REGISTERED under in Meta — per template, in
 * notify.ts `TEMPLATE_REGISTERED_LANGUAGE` (B25: `bizi_unknown_contact` is
 * registered English), never through this function.
 *
 * 🔴 AN ENGLISH VERSION IS USED ONLY ONCE IT IS MARKED APPROVED HERE. Sending a
 * template in a language Meta has not approved fails the whole send (132001),
 * so the default — anything not listed — is Hebrew.
 */
export const TEMPLATE_EN_APPROVED: Record<string, boolean> = {};

export function templateLanguageFor(templateName: string, lang: Lang): Lang {
  return lang === "en" && TEMPLATE_EN_APPROVED[templateName] === true ? "en" : "he";
}

// ─── the store (0106) ───────────────────────────────────────────────────────

/** null = no language chosen yet. `ok: false` = could not read. */
export async function loadLang(
  admin: SupabaseClient<Database>,
  waId: string
): Promise<{ ok: true; lang: Lang | null } | { ok: false }> {
  try {
    const { data, error } = await admin.from("wa_contact_prefs").select("lang").eq("wa_id", waId).maybeSingle();
    if (error) {
      console.error("wa/lang: קריאת השפה נכשלה", error.message);
      return { ok: false };
    }
    return { ok: true, lang: isLang(data?.lang) ? data.lang : null };
  } catch (e) {
    console.error("wa/lang: קריאת השפה זרקה", e);
    return { ok: false };
  }
}

/** Upsert — one row per number; `created_at` stays (proved in 0106's dryrun). */
export async function saveLang(admin: SupabaseClient<Database>, waId: string, lang: Lang, now: Date): Promise<boolean> {
  const at = now.toISOString();
  try {
    const { error } = await admin
      .from("wa_contact_prefs")
      .upsert([{ wa_id: waId, lang, lang_set_at: at, updated_at: at }], { onConflict: "wa_id" });
    if (error) {
      // e.g. a number outside 0106's 7–15 digits: answer anyway, ask again later
      console.error("wa/lang: שמירת השפה נכשלה", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error("wa/lang: שמירת השפה זרקה", e);
    return false;
  }
}
