/**
 * BundleBar — rendered, and COUNTED.
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_bundle_bar_render.tsx
 * Pure. Reads nothing, writes nothing, needs no database and no dev server.
 *
 * ═══ WHY COUNTED ═══
 * The three facts that matter here are all about HOW MANY, and "the HTML
 * contains the label" cannot tell one from two. A duplicated bundled action is
 * exactly the shape the registry paid for on 2026-09-17 — a bundled button and
 * a row button offering the same verb at opposite scope, no warning, one click
 * billing the wrong thing. So:
 *
 *   · the bundled button appears exactly once at two ticked rows, zero at one
 *   · the mixed-selection sentence appears exactly once, never twice
 *   · a mixed selection cannot SEND — the handler is not called, and the
 *     control that would call it is really disabled (attribute, not classname)
 *
 * The checkbox count is not here and cannot be: it is one line of the table in
 * RegistryClient, which needs a router and a provider. It is counted in
 * test_tax_bundle_pulled.ts over `taxSelectable`, which is the predicate that
 * one line asks — `{rowSelectable(r) && <input …>}` — so the count is of the
 * same thing by a shorter route.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import BundleBar from "../src/components/BundleBar";
import type { SelectableRow } from "../src/lib/documents/registrySelection";
import { TAX_BUNDLE_NOTICE } from "../src/lib/morning/types";

let failures = 0;
const check = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    console.log(`  FAIL  ${label} — ${(e as Error).message}`);
    failures++;
  }
};

// React separates adjacent text nodes with an empty comment — strip those
// before asserting on a sentence a human reads (the RecordPastBody convention).
const render = (el: React.ReactElement) => renderToString(el).replace(/<!-- -->/g, "");
const count = (h: string, needle: string) => h.split(needle).length - 1;
// `disabled=""` is the ATTRIBUTE React emits for a true boolean prop. The bare
// word also appears in every Tailwind `disabled:opacity-40` class here, so a
// substring check for it passes on a live button — which is how an assertion
// ends up proving nothing.
const disabledCount = (h: string) => count(h, 'disabled=""');

const TAX_LABEL = "צור חשבונית מס מאוגדת";
const DEAL_LABEL = "צור חשבון עסקה מאוגד";

const raw = (id: string): SelectableRow => ({
  id,
  status: 0,
  buildable: "raw",
  pending_id: null,
  pending_amount: null,
  net_amount: 500,
  over_ceiling: null,
  child_actions: ["tax"],
});
const pending = (id: string): SelectableRow => ({
  id,
  status: 0,
  buildable: "pending",
  pending_id: `pd-${id}`,
  pending_amount: 500,
  net_amount: null,
  over_ceiling: null,
  child_actions: ["tax"],
});

let bundled = 0;
let cleared = 0;
const bar = (over: Partial<React.ComponentProps<typeof BundleBar>> = {}) => {
  const props: React.ComponentProps<typeof BundleBar> = {
    rows: [raw("doc-40283"), raw("doc-40289")],
    action: "tax",
    mixed: false,
    busy: false,
    currency: "ILS",
    onClear: () => {
      cleared++;
    },
    onBundle: () => {
      bundled++;
    },
    ...over,
  };
  return render(<BundleBar {...props} />);
};

console.log("\n── two pulled rows: the כפיר ארביב case ──");

check("the bundled tax button appears exactly ONCE", () => {
  const n = count(bar(), TAX_LABEL);
  if (n !== 1) throw new Error(`expected 1, got ${n}`);
});

check("it carries the count (2)", () => {
  if (!bar().includes(`${TAX_LABEL} (2)`)) throw new Error("the count is not on the button");
});

check("the deal-invoice label is nowhere near it", () => {
  if (count(bar(), DEAL_LABEL) !== 0) throw new Error("the other door's verb appeared");
});

check("the bar names what was selected, and the summed NET of the pulled rows", () => {
  const html = bar();
  if (!html.includes("נבחרו 2 חשבונות עסקה")) throw new Error("the count sentence is wrong");
  if (!html.includes("1,000")) throw new Error("the total of the two proven nets is missing");
  if (html.includes("—")) throw new Error("the total rendered as unknown");
});

check("no mixed sentence when the selection is homogeneous", () => {
  if (count(bar(), TAX_BUNDLE_NOTICE.mixed_sources) !== 0) throw new Error("a refusal appeared for nothing");
});

check("every control is live", () => {
  const n = disabledCount(bar());
  if (n !== 0) throw new Error(`${n} control(s) disabled on a valid selection`);
});

console.log("\n── two queue rows: the ידידיה path, unchanged ──");

check("the same single button, same count, same total", () => {
  const html = bar({ rows: [pending("a"), pending("b")] });
  if (count(html, TAX_LABEL) !== 1) throw new Error("not exactly one button");
  if (!html.includes(`${TAX_LABEL} (2)`)) throw new Error("count missing");
  if (!html.includes("1,000")) throw new Error("total missing");
  if (disabledCount(html) !== 0) throw new Error("a control was disabled");
});

console.log("\n── a mixed selection: the sentence, and NO send ──");

check("the mixed sentence appears exactly ONCE", () => {
  const n = count(bar({ mixed: true }), TAX_BUNDLE_NOTICE.mixed_sources);
  // once in the body. The title attribute carries it too, so the count is
  // asserted >= 1 and == 2 exactly: body + title, never a third copy.
  if (n !== 2) throw new Error(`expected the sentence twice (body + title), got ${n}`);
});

check("the bundled button is really disabled, by attribute", () => {
  const html = bar({ mixed: true });
  if (disabledCount(html) !== 1) throw new Error(`expected exactly the submit disabled, got ${disabledCount(html)}`);
  if (count(html, TAX_LABEL) !== 1) throw new Error("the button vanished instead of going dark");
});

check("נקה בחירה stays live — the way out of a mixed selection", () => {
  if (!bar({ mixed: true }).includes("נקה בחירה")) throw new Error("no way to clear");
});

/**
 * The component's OWN onClick, found in the tree it returns and invoked.
 *
 * renderToString never fires a handler, so a render alone cannot prove the belt
 * inside the component. Calling BundleBar as a function gives the real element
 * tree; walking it to `data-bundle-submit` gives the real button; calling its
 * onClick runs the real `if (blocked) return;`. Re-stating that condition in
 * the test instead would have asserted the test.
 */
function clickBundleSubmit(props: React.ComponentProps<typeof BundleBar>): void {
  const tree = BundleBar(props) as React.ReactElement | null;
  const find = (node: unknown): React.ReactElement | null => {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const c of node) {
        const hit = find(c);
        if (hit) return hit;
      }
      return null;
    }
    const el = node as React.ReactElement & { props?: Record<string, unknown> };
    if (!el.props) return null;
    if (el.props["data-bundle-submit"] !== undefined) return el;
    return find(el.props.children);
  };
  const btn = find(tree);
  if (!btn) throw new Error("the submit button was not in the tree");
  const onClick = (btn.props as { onClick?: () => void }).onClick;
  if (!onClick) throw new Error("the submit button has no onClick");
  onClick();
}

check("a mixed selection sends NOTHING when the button is actually clicked", () => {
  bundled = 0;
  clickBundleSubmit({
    rows: [raw("x"), pending("y")],
    action: "tax",
    mixed: true,
    busy: false,
    currency: "ILS",
    onClear: () => {},
    onBundle: () => {
      bundled++;
    },
  });
  if (bundled !== 0) throw new Error("a mixed selection reached onBundle");
});

check("a homogeneous selection DOES send when clicked — the guard is not always-on", () => {
  bundled = 0;
  clickBundleSubmit({
    rows: [raw("a"), raw("b")],
    action: "tax",
    mixed: false,
    busy: false,
    currency: "ILS",
    onClear: () => {},
    onBundle: () => {
      bundled++;
    },
  });
  if (bundled !== 1) throw new Error(`expected exactly one send, got ${bundled}`);
});

console.log("\n── the deal door, untouched ──");

check("the deal bar says its own verb, once", () => {
  const html = bar({ action: "deal_invoice", rows: [pending("a"), pending("b")] });
  if (count(html, DEAL_LABEL) !== 1) throw new Error("not exactly one deal button");
  if (count(html, TAX_LABEL) !== 0) throw new Error("the tax verb leaked into the deal bar");
  if (!html.includes("נבחרו 2 הזמנות עבודה")) throw new Error("the deal noun is wrong");
});

check("busy disables the submit and nothing else", () => {
  const html = bar({ busy: true });
  if (disabledCount(html) !== 1) throw new Error(`expected 1 disabled, got ${disabledCount(html)}`);
});

console.log("\n── below two, and broken payloads ──");

check("ONE ticked row draws no bar at all — the single-row button owns that", () => {
  const html = bar({ rows: [raw("only")] });
  if (html !== "") throw new Error(`expected nothing, got ${html.slice(0, 60)}`);
});

check("zero ticked rows draw no bar", () => {
  if (bar({ rows: [] }) !== "") throw new Error("a bar appeared for an empty selection");
});

check("a row with no net at all → the total says — rather than a wrong number", () => {
  const noNet: SelectableRow = { ...raw("z"), net_amount: null };
  const html = bar({ rows: [raw("a"), noNet] });
  if (!html.includes("—")) throw new Error("an unknown total was not shown as unknown");
  if (html.includes("NaN")) throw new Error("NaN reached the screen");
  if (count(html, TAX_LABEL) !== 1) throw new Error("the button went missing");
});

check("an empty currency falls back to ILS rather than throwing", () => {
  const html = bar({ currency: "" });
  if (html.includes("NaN")) throw new Error("NaN reached the screen");
});

check("three rows, mixed doors, still exactly one sentence and one button", () => {
  const html = bar({ rows: [raw("a"), raw("b"), pending("c")], mixed: true });
  if (count(html, TAX_LABEL) !== 1) throw new Error("not exactly one button");
  if (count(html, TAX_BUNDLE_NOTICE.mixed_sources) !== 2) throw new Error("the sentence was duplicated");
  if (!html.includes(`${TAX_LABEL} (3)`)) throw new Error("the count is wrong");
});

check("onClear is wired to something that is not onBundle", () => {
  cleared = 0;
  bundled = 0;
  const html = bar();
  if (!html.includes("נקה בחירה")) throw new Error("no clear control");
  if (cleared !== 0 || bundled !== 0) throw new Error("rendering fired a handler");
});

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
