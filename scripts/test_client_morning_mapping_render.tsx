/**
 * The Morning mapping, reachable from a client's card (owner 7.10) — and the
 * extraction that made it possible without a second copy of anything.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_client_morning_mapping_render.tsx
 *
 * ═══ F19 AND THE MORNING RULE ═══
 * Creates nothing, writes nothing, reads no database, opens no socket — and
 * makes NO CALL TO MORNING. `global.fetch` is replaced with a function that
 * THROWS, so a component that reached for the network would fail this suite
 * rather than quietly hit the live API. Everything under test is either a pure
 * component or a pure string.
 *
 * ═══ WHY THESE ASSERTIONS COUNT (rule 56) ═══
 * Changing which Morning card a client is mapped to decides whose name is
 * printed on every FUTURE invoice. "The old name is shown" passes when the old
 * name is shown twice and the new one not at all; "the action is hidden"
 * passes when it is merely styled grey. So: exact counts, and zero means zero.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import MorningMappingCard, { MappingStatus } from "../src/components/MorningMappingCard";
import {
  MappingChangeConfirm,
  SharedMappingModal,
  type SharedPending,
} from "../src/components/MorningMapping";
import {
  MAPPING_ASSIGN,
  MAPPING_CANCEL,
  MAPPING_CONFIRM,
  MAPPING_CREATE,
  MAPPING_LABEL,
  MAPPING_REPLACE,
  MAPPING_TITLE,
  MAPPING_UNCHANGED,
  mappingBody,
  mappingFailure,
} from "../src/lib/clients/morningMapping";
import { NOT_MAPPED } from "../src/lib/clients/overview";

global.fetch = (() => {
  throw new Error("F19: this suite must not perform any fetch");
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
    console.log(`  ❌ ${name}\n       got:  ${g}\n       want: ${w}`);
  }
}

const seen = (html: string) =>
  html.replace(/<!--.*?-->/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const countOf = (html: string, needle: string) => seen(html).split(needle).length - 1;
const noop = () => {};

const OLD = "ידיעות אחרונות בע\"מ";
const NEW = "ידיעות תקשורת בע\"מ";

console.log("\n=== mapped / unmapped: each state rendered exactly once ===");
{
  // ── mapped, and editable ──
  const mapped = renderToString(
    <MappingStatus currentName={OLD} canEdit onToggle={noop} />
  );
  check("mapped: the Morning card's name once", countOf(mapped, OLD), 1);
  check("mapped: the replace action once", countOf(mapped, `>${MAPPING_REPLACE}<`), 1);
  check("mapped: the assign action zero times", countOf(mapped, `>${MAPPING_ASSIGN}<`), 0);
  check("mapped: it does NOT say unmapped", countOf(mapped, NOT_MAPPED), 0);
  check("mapped: exactly one control", countOf(mapped, "<button"), 1);

  // ── unmapped, and editable ──
  const unmapped = renderToString(
    <MappingStatus currentName={null} canEdit onToggle={noop} />
  );
  check("unmapped: the approved label once", countOf(unmapped, NOT_MAPPED), 1);
  check("unmapped: the assign action once", countOf(unmapped, `>${MAPPING_ASSIGN}<`), 1);
  check("unmapped: the replace action zero times", countOf(unmapped, `>${MAPPING_REPLACE}<`), 0);
  check("unmapped: exactly one control", countOf(unmapped, "<button"), 1);

  // the label is the SAME constant the list rows use, not a second wording
  const overview = readFileSync(join(__dirname, "..", "src", "lib", "clients", "overview.ts"), "utf8");
  check("the unmapped label lives in one place", overview.includes('NOT_MAPPED = "לא ממופה למורנינג"'), true);
  const cardSrc = readFileSync(join(__dirname, "..", "src", "components", "MorningMappingCard.tsx"), "utf8");
  const cardCode = cardSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the card imports it rather than spelling it", cardCode.includes("NOT_MAPPED"), true);
  check("...and never writes the string itself", countOf(cardCode, '"לא ממופה למורנינג"'), 0);
}

console.log("\n=== 🔴 without can_edit_money: zero actions, anywhere ===");
{
  // the STATUS line
  for (const [label, current] of [["mapped", OLD], ["unmapped", null]] as const) {
    const html = renderToString(<MappingStatus currentName={current} canEdit={false} />);
    check(`${label}, read-only: zero buttons`, countOf(html, "<button"), 0);
    check(`${label}, read-only: zero replace actions`, countOf(html, MAPPING_REPLACE), 0);
    check(`${label}, read-only: zero assign actions`, countOf(html, MAPPING_ASSIGN), 0);
  }
  check(
    "read-only still states the fact",
    countOf(renderToString(<MappingStatus currentName={OLD} canEdit={false} />), OLD),
    1
  );

  // and the WHOLE CARD, which is what the screen actually renders. It must not
  // even reach for Morning: `global.fetch` throws, so a render that tried would
  // fail here rather than in production.
  for (const mapped of [true, false]) {
    const html = renderToString(
      <MorningMappingCard
        clientId="c1"
        clientName="ידיעות אחרונות"
        mapped={mapped}
        canEdit={false}
        onChanged={noop}
      />
    );
    check(`card, read-only (mapped=${mapped}): zero controls`, countOf(html, "<button"), 0);
    check(`card, read-only (mapped=${mapped}): zero inputs`, countOf(html, "<input"), 0);
    check(`card, read-only (mapped=${mapped}): no replace`, countOf(html, MAPPING_REPLACE), 0);
    check(`card, read-only (mapped=${mapped}): no assign`, countOf(html, MAPPING_ASSIGN), 0);
    check(`card, read-only (mapped=${mapped}): no create`, countOf(html, MAPPING_CREATE), 0);
    check(`card, read-only (mapped=${mapped}): the label once`, countOf(html, MAPPING_LABEL), 1);
  }
  check(
    "card, read-only, unmapped: says so once",
    countOf(
      renderToString(
        <MorningMappingCard clientId="c1" clientName="x" mapped={false} canEdit={false} onChanged={noop} />
      ),
      NOT_MAPPED
    ),
    1
  );
}

console.log("\n=== 🔴 the change window: the previous card and the new one, once each ===");
{
  const html = renderToString(
    <MappingChangeConfirm toName={NEW} fromName={OLD} onConfirm={noop} onCancel={noop} />
  );
  check("the approved title, verbatim", countOf(html, MAPPING_TITLE), 1);
  check("the title is the owner's string", MAPPING_TITLE, "שינוי כרטיס הלקוח במורנינג");
  // 🔴 ONCE EACH. Two copies of the new name — or the old one in both slots —
  // is the mistake that makes an operator confirm a change they misread.
  check("the PREVIOUS card's name appears exactly once", countOf(html, OLD), 1);
  check("the NEW card's name appears exactly once", countOf(html, NEW), 1);
  check(
    "the body is the approved sentence, verbatim",
    countOf(html, `מסמכים שיונפקו מכאן והלאה ייצאו על ${NEW} במקום ${OLD}.`),
    1
  );
  check("...and what does not change", countOf(html, MAPPING_UNCHANGED), 1);
  check("the confirm button, verbatim", countOf(html, `>${MAPPING_CONFIRM}<`), 1);
  check("the confirm button is the owner's string", MAPPING_CONFIRM, "שינוי הכרטיס");
  check("the cancel button, verbatim", countOf(html, `>${MAPPING_CANCEL}<`), 1);

  // ── a FIRST mapping: the same window, without "instead of" (owner §4) ──
  const first = renderToString(
    <MappingChangeConfirm toName={NEW} fromName={null} onConfirm={noop} onCancel={noop} />
  );
  check("first mapping: the same title", countOf(first, MAPPING_TITLE), 1);
  check("first mapping: the new name once", countOf(first, NEW), 1);
  check("first mapping: the approved shorter sentence", countOf(first, `מסמכים שיונפקו מכאן והלאה ייצאו על ${NEW}.`), 1);
  check("first mapping: NO 'instead of'", countOf(first, "במקום"), 0);
  // there is no previous card, so nothing may stand in for one
  check("first mapping: no dash standing in for a previous name", countOf(first, "על —"), 0);
  check("first mapping: both buttons are still there", countOf(first, "<button"), 2);

  // the body generator itself, which is what both branches read
  check("mappingBody, replacing", mappingBody(NEW, OLD), `מסמכים שיונפקו מכאן והלאה ייצאו על ${NEW} במקום ${OLD}. ${MAPPING_UNCHANGED}`);
  check("mappingBody, first time", mappingBody(NEW, null), `מסמכים שיונפקו מכאן והלאה ייצאו על ${NEW}.`);
  check("mappingBody never emits an empty 'instead of'", mappingBody(NEW, null).includes("במקום"), false);
}

console.log("\n=== 🔴 a failure says what did NOT happen, once ===");
{
  const msg = mappingFailure("409 כבר משויך");
  check("the approved wording, verbatim", msg, "השינוי נכשל — 409 כבר משויך. לא בוצע שום שינוי.");
  check("it appears once, not twice", countOf(msg, "לא בוצע שום שינוי."), 1);
  check("the error is quoted once", countOf(msg, "409 כבר משויך"), 1);
  // "nothing changed" is a CLAIM, and the code has to back it. The card paints
  // nothing optimistically and re-reads from the server on success only.
  const cardSrc = readFileSync(join(__dirname, "..", "src", "components", "MorningMappingCard.tsx"), "utf8");
  const cardCode = cardSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the card wraps failures in the approved sentence", cardCode.includes("mappingFailure(out.error)"), true);
  check("the card writes no local state before the response", cardCode.includes("setData({"), false);
  check("the card re-reads only after success", /if \(!out\.ok\)[\s\S]*?return;[\s\S]*?await load\(\);/.test(cardCode), true);
  // and a 409 shared is NOT reported as a failure — the dialog retries it
  check("a shared 409 is not turned into the failure sentence", cardCode.includes("if (!out.needsShared) setError"), true);
}

console.log("\n=== the extraction: one implementation, two callers ===");
{
  const settings = readFileSync(
    join(__dirname, "..", "src", "app", "settings", "morning-clients", "MorningClientsClient.tsx"),
    "utf8"
  );
  const settingsCode = settings.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const cardCode = readFileSync(join(__dirname, "..", "src", "components", "MorningMappingCard.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // neither screen holds the POST any more — the hook does. The settings
  // screen still GETs that URL for its own list, which is its job and stays.
  check("the settings screen issues no POST at all", countOf(settingsCode, 'method: "POST"'), 0);
  check("...and its one reference to the URL is the GET", countOf(settingsCode, 'fetch("/api/morning/clients")'), 1);
  check("the card does not post either", countOf(cardCode, 'method: "POST"'), 0);
  const hook = readFileSync(join(__dirname, "..", "src", "components", "MorningMapping.tsx"), "utf8");
  check("the hook posts, exactly once", countOf(hook, '"/api/morning/clients"'), 1);
  check("both screens call the shared hook", [
    settingsCode.includes("useMorningMapping()"),
    cardCode.includes("useMorningMapping()"),
  ], [true, true]);
  // the 409 handshake exists in ONE place
  check("needs_confirmation is handled once", countOf(hook, "needs_confirmation"), 1);
  check("the settings screen no longer handles it", countOf(settingsCode, "needs_confirmation"), 0);
  check("the card does not handle it", countOf(cardCode, "needs_confirmation"), 0);
  // the shared dialog is rendered by both, defined once
  check("both render the shared dialog", [
    settingsCode.includes("<SharedMappingModal"),
    cardCode.includes("<SharedMappingModal"),
  ], [true, true]);
  // NO NEW ROUTE, which the owner asked for by name
  check("the card uses the existing per-client read", cardCode.includes("/morning`"), true);
  check("no new API route was added under clients", cardCode.includes("/api/clients/${clientId}/morning"), true);
  // the create modal is reused UNCHANGED, in its existing map-existing mode
  const create = readFileSync(join(__dirname, "..", "src", "components", "CreateMorningClientModal.tsx"), "utf8");
  check("the create modal still takes a clientId (map-existing mode)", /clientId\?: string \| null/.test(create), true);
  check("the card passes one, so no second create flow was built", cardCode.includes("clientId={clientId}"), true);
}

console.log("\n=== regression: /settings/morning-clients renders as before ===");
{
  /**
   * The only MARKUP that moved out of that screen is the shared-mapping
   * dialog. This is the frozen pre-extraction copy of it, rendered beside the
   * extracted component and compared byte for byte. Anything reworded, a class
   * dropped, the overlay's z-index changed — all fail here.
   */
  const pending: SharedPending = {
    clientId: "c1",
    morningId: "m1",
    morningName: OLD,
    sharedWith: ["גל אורן", "אפרת"],
  };
  const before = renderToString(
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
      <div
        style={{
          background: "rgba(15,13,28,0.94)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
        }}
        className="border border-[var(--rule)] rounded-2xl p-5 max-w-md w-full"
      >
        <h3 className="font-bold text-sm mb-2">לקוח מורנינג משותף</h3>
        <p className="text-sm mb-3">
          לקוח זה כבר משויך ל<span className="font-bold">{pending.sharedWith.join(", ")}</span>. שתי
          הישויות יחויבו לאותו לקוח במורנינג.
        </p>
        <p className="text-[11px] text-[var(--faint)] mb-4">אם זו אותה ישות משלמת עם כמה מותגים — זה תקין.</p>
        <div className="flex gap-2">
          <button
            disabled={false}
            onClick={noop}
            className="flex-1 bg-[var(--signal)] text-white text-xs font-bold rounded-xl px-4 py-2 disabled:opacity-40"
          >
            כן, זו אותה ישות משלמת
          </button>
          <button
            onClick={noop}
            className="flex-1 text-xs rounded-xl px-4 py-2 border border-[var(--rule)]"
          >
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
  const after = renderToString(
    <SharedMappingModal pending={pending} busy={false} onConfirm={noop} onCancel={noop} />
  );
  check("the shared dialog is byte-identical to the inline original", after, before);
  check("it names everyone it is shared with, once", countOf(after, "גל אורן, אפרת"), 1);

  // everything else the screen owns is still its own
  const settings = readFileSync(
    join(__dirname, "..", "src", "app", "settings", "morning-clients", "MorningClientsClient.tsx"),
    "utf8"
  );
  for (const kept of [
    "מיפוי לקוחות למורנינג", // the heading
    "רק לא ממופים", // its filter
    "בטל מיפוי", // the unmap action, which the CARD deliberately does not offer
    "כל הלקוחות המוצגים ממופים 🎉",
    "מופו ${out.backfilled} מסמכים ישנים שהיו ללא לקוח",
    "הצעה אוטומטית",
    "ממופה למזהה שנמחק במורנינג",
  ]) {
    check(`the settings screen still has "${kept.slice(0, 24)}"`, countOf(settings, kept), 1);
  }
  check("it still loads the whole list itself", countOf(settings, 'fetch("/api/morning/clients")'), 1);
  // 🔴 and the card must NOT have grown an unmap action
  // comments stripped: the card DOCUMENTS that it deliberately has no unmap,
  // and a grep over that sentence would fail on the explanation itself
  const cardOnlyCode = readFileSync(join(__dirname, "..", "src", "components", "MorningMappingCard.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  check("the card offers no unmap", countOf(cardOnlyCode, "בטל מיפוי"), 0);
  check("the card never assigns null", /assign\([^)]*,\s*null/.test(cardOnlyCode), false);
}

console.log("\n=== the shared pieces render the same fields on both screens ===");
{
  // The dialog is ONE component, so "the same fields in both places" is true by
  // construction — asserted by rendering it once and counting the parts that
  // matter, which is what a second copy would get wrong.
  const pending: SharedPending = { clientId: "c1", morningId: "m1", sharedWith: ["אפרת"] };
  const html = renderToString(
    <SharedMappingModal pending={pending} busy={false} onConfirm={noop} onCancel={noop} />
  );
  check("one heading", countOf(html, "לקוח מורנינג משותף"), 1);
  check("one confirm, one cancel", countOf(html, "<button"), 2);
  check("the confirming button says what it agrees to", countOf(html, "כן, זו אותה ישות משלמת"), 1);
  check("the shared names appear once", countOf(html, "אפרת"), 1);
  // busy disables only the confirming button, never the way out
  const busy = renderToString(
    <SharedMappingModal pending={pending} busy onConfirm={noop} onCancel={noop} />
  );
  check("while busy, exactly one button is disabled", countOf(busy, "disabled="), 1);
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
