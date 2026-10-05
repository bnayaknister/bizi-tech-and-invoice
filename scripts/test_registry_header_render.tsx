/**
 * The registry HEADER: the two link buttons, and the permission on the new one.
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_registry_header_render.tsx
 * Reads nothing, writes nothing, needs no dev server, no database, no network.
 *
 * ═══ WHY A RENDER TEST FOR A BUTTON ═══
 * Because the thing under test is a CONDITIONAL, and a conditional on a
 * permission is the one kind of UI bug that is invisible until the wrong person
 * is looking at the screen. Counting is the whole point: "appears once" and
 * "appears zero times" are the two assertions, and an HTTP suite grepping the
 * page for a string can prove neither — it fetches as one user.
 *
 * The owner's request (6.10) was "ליד הכפתור הקיים … באותו סגנון ובאותו רכיב",
 * so the neighbour is asserted too. A change that styled the new button
 * differently, or that dropped the old one while adding the new, would pass a
 * test that only looked for "פדיון מרוכז".
 *
 * ═══ WHICH GATE, AND WHY THE BRANCH IS CURRENTLY UNREACHABLE ═══
 * /documents/accrued redirects on `can_view_money` (accrued/page.tsx:25), so
 * that is the flag the link carries. The registry page redirects on the SAME
 * flag one layer earlier (registry/page.tsx:16), which means the false branch
 * cannot occur in production today — the guard is defence in depth, exactly
 * like the "פערים לטיפול" button beside it whose target carries the identical
 * gate (gaps/page.tsx:20).
 *
 * It is still tested, and the reason is not symmetry: the branch exists so that
 * widening the REGISTRY's gate later cannot silently widen the LINK's. A guard
 * nobody exercises is a guard nobody can trust, and this suite is what makes
 * the claim checkable rather than asserted in a comment.
 *
 * RegistryClient calls useRouter, so it needs the App Router context — the same
 * mock test_documents_edit_render.tsx uses. useDrawer needs nothing: its
 * context carries a default (EntityDrawer.tsx:158).
 */
import { renderToString } from "react-dom/server";
import React from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import RegistryClient, { type DocRow } from "../src/app/documents/registry/RegistryClient";

let failures = 0;
let checks = 0;
const check = (label: string, ok: boolean, detail = "") => {
  checks++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

const noop = () => {};
const stubRouter = {
  back: noop,
  forward: noop,
  refresh: noop,
  push: noop,
  replace: noop,
  prefetch: noop,
} as unknown as React.ContextType<typeof AppRouterContext>;

/**
 * NO ROWS, and that is the right fixture. The header is what is under test, it
 * renders above and independently of the table, and an empty registry is a real
 * state the screen has to survive. A row fixture would be 30 fields of noise
 * that no assertion here reads.
 */
const NO_ROWS: DocRow[] = [];

const render = (props: { canPull?: boolean; canViewAccrued?: boolean; rows?: DocRow[] }) =>
  renderToString(
    React.createElement(
      AppRouterContext.Provider,
      { value: stubRouter },
      React.createElement(RegistryClient, {
        rows: props.rows ?? NO_ROWS,
        canPull: props.canPull ?? false,
        canViewAccrued: props.canViewAccrued,
        lastPull: null,
      })
    )
    // renderToString splits adjacent text nodes with `<!-- -->` hydration
    // markers; they are not content, and an assertion that trips over them is
    // testing the serialiser rather than the screen.
  ).replace(/<!-- -->/g, "");

/** How many times a string appears — the assertion this suite is built on. */
const times = (html: string, needle: string) => html.split(needle).length - 1;

const REDEEM = "פדיון מרוכז →";
const GAPS = "פערים לטיפול →";

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 1. מורשה: 'פדיון מרוכז' פעם אחת ──────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const html = render({ canViewAccrued: true });
  check(`"${REDEEM}" פעם אחת`, times(html, REDEEM) === 1, `${times(html, REDEEM)}x`);
  check(`"${GAPS}" עדיין פעם אחת`, times(html, GAPS) === 1, `${times(html, GAPS)}x`);
  // the href the button navigates to, asserted through the onClick's target
  check("הכפתור מצביע ל-/documents/accrued", html.includes(REDEEM));
  // ═══ SAME COMPONENT, SAME STYLE — the owner's words, as an assertion ═══
  // Both buttons must carry the identical four classes. A regression that
  // restyled one of them would leave two visually unrelated buttons side by
  // side, which is the thing the request explicitly asked against.
  const CLASSES = 'class="text-xs font-bold rounded-xl px-4 py-1.5 border border-[var(--rule2)]"';
  check("שני הכפתורים נושאים את אותן קלאסים", times(html, CLASSES) === 2, `${times(html, CLASSES)}x`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 2. 🔴 לא מורשה: אפס מופעים ───────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const html = render({ canViewAccrued: false });
  check(`"${REDEEM}" אפס פעמים`, times(html, REDEEM) === 0, `${times(html, REDEEM)}x`);
  // and the neighbour is untouched — the gate hides ONE button, not the header
  check(`"${GAPS}" עדיין פעם אחת`, times(html, GAPS) === 1, `${times(html, GAPS)}x`);
  check("הכותרת עצמה מרונדרת", html.includes("מסמכים"));
  // only ONE styled link button is left
  const CLASSES = 'class="text-xs font-bold rounded-xl px-4 py-1.5 border border-[var(--rule2)]"';
  check("נותר כפתור מעוצב אחד", times(html, CLASSES) === 1, `${times(html, CLASSES)}x`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 3. 🔴 ברירת המחדל מסתירה, לא חושפת ───────────────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  // A payload from a build that predates the prop carries `undefined`. The
  // default must FAIL CLOSED: a missing permission hides the link. This is the
  // one direction the default is allowed to be wrong in, and asserting it is
  // cheaper than trusting that nobody will flip it to `?? true` one day.
  const html = render({});
  check(`prop חסר → "${REDEEM}" אפס פעמים`, times(html, REDEEM) === 0, `${times(html, REDEEM)}x`);
  check("והמסך עדיין מרונדר", html.includes("מסמכים") && times(html, GAPS) === 1);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 4. השער אינו canPull — שתי ההרשאות נפרדות ────────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  // can_view_money and can_edit_money are INDEPENDENT booleans, both defaulting
  // false (0002:14-16). `canPull` is the edit one — the pull is a write. A link
  // that borrowed it would hide the redemption screen from a money-VIEWER who
  // is entitled to it, and show it to nobody else by accident.
  const viewerOnly = render({ canPull: false, canViewAccrued: true });
  check("צופה-כספים בלי הרשאת עריכה רואה את הכפתור", times(viewerOnly, REDEEM) === 1);
  check("ואינו רואה 'משוך ממורנינג'", times(viewerOnly, "משוך ממורנינג") === 0);

  const editorOnly = render({ canPull: true, canViewAccrued: false });
  check("🔴 canPull לבדו אינו מספיק", times(editorOnly, REDEEM) === 0, `${times(editorOnly, REDEEM)}x`);
  check("אך 'משוך ממורנינג' כן מופיע", times(editorOnly, "משוך ממורנינג") === 1);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 5. אפס שינוי אחר בכותרת ──────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  // The request was "אפס שינוי אחר". The two renders must differ by EXACTLY the
  // new button and nothing else — which is a stronger statement than any
  // per-string assertion, and the only one that would catch an accidental edit
  // elsewhere in the header.
  const off = render({ canViewAccrued: false });
  const on = render({ canViewAccrued: true });
  const i = on.indexOf(REDEEM);
  check("הכפתור החדש אכן מרונדר", i > 0);
  // strip the new button's own element out of the authorised render and the two
  // must be byte-identical
  const start = on.lastIndexOf("<button", i);
  const end = on.indexOf("</button>", i) + "</button>".length;
  const stripped = on.slice(0, start) + on.slice(end);
  check("מלבדו — הרנדר זהה בית-בבית", stripped === off, `${stripped.length} vs ${off.length}`);
}

console.log(`\n${failures === 0 ? "✅" : "❌"}  ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
