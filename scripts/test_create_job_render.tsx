/**
 * CreateJobButton and CreateJobModalBody — rendered, and COUNTED.
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_create_job_render.tsx
 * Pure. Reads nothing, writes nothing, needs no database and no dev server.
 *
 * ═══ WHY COUNTED AND NOT GREPPED ═══
 * The three facts the owner asked to be guaranteed are all about HOW MANY
 * buttons appear, and "the HTML contains the label" cannot tell one from two.
 * A duplicated button is exactly the shape the registry paid for on 2026-09-17
 * (a bundled action and a row action offering the same verb at opposite scope),
 * so the assertions below count occurrences and insist on 1 and on 0.
 *
 * The rest is the RecordPastBody argument: every prop arrives from a server
 * fetch, so every one of them can be undefined under a version skew — the
 * class of break that took the projects screen down while tsc was satisfied.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import { CreateJobButton, CreateJobModalBody } from "../src/components/CreateJobBody";
import { CREATE_JOB_COPY } from "../src/lib/productions/createJob";

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

// React separates adjacent text nodes with an empty comment, so strip those
// before asserting on sentences a human reads (the RecordPastBody convention).
const render = (el: React.ReactElement) => renderToString(el).replace(/<!-- -->/g, "");
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const noop = () => {};

console.log("\n── the button, counted ──");

check("exactly ONE button when the production has no job and the viewer may edit money", () => {
  const html = render(<CreateJobButton hasJob={false} canEditMoney onOpen={noop} />);
  const n = count(html, CREATE_JOB_COPY.button);
  if (n !== 1) throw new Error(`expected 1 button, got ${n}`);
  if (!html.includes('data-action="create-job"')) throw new Error("the hook the screen is found by is missing");
});

check("ZERO buttons when the production already has a job", () => {
  const html = render(<CreateJobButton hasJob canEditMoney onOpen={noop} />);
  const n = count(html, CREATE_JOB_COPY.button);
  if (n !== 0) throw new Error(`expected 0 buttons, got ${n}`);
});

check("ZERO buttons without can_edit_money", () => {
  const html = render(<CreateJobButton hasJob={false} canEditMoney={false} onOpen={noop} />);
  const n = count(html, CREATE_JOB_COPY.button);
  if (n !== 0) throw new Error(`expected 0 buttons, got ${n}`);
});

check("ZERO buttons when it has a job AND the viewer cannot edit money", () => {
  const html = render(<CreateJobButton hasJob canEditMoney={false} onOpen={noop} />);
  if (count(html, CREATE_JOB_COPY.button) !== 0) throw new Error("a button appeared");
});

console.log("\n── the window ──");

type BodyProps = React.ComponentProps<typeof CreateJobModalBody>;
const base: BodyProps = {
  showName: "SFI",
  recordDate: "2026-08-17",
  guest: null,
  suggested: 1000,
  value: "1000",
  busy: false,
  error: null,
  done: false,
  onChange: noop,
  onSubmit: noop,
  onCancel: noop,
};
const body = (over: Partial<BodyProps> = {}) =>
  render(<CreateJobModalBody {...base} {...over} />);

check("the approved copy is all there", () => {
  const html = body();
  for (const s of [
    CREATE_JOB_COPY.title,
    CREATE_JOB_COPY.why,
    CREATE_JOB_COPY.amountLabel,
    CREATE_JOB_COPY.suggested,
    CREATE_JOB_COPY.note,
    CREATE_JOB_COPY.submit,
    CREATE_JOB_COPY.cancel,
  ]) {
    if (!html.includes(s)) throw new Error(`missing: ${s}`);
  }
});

check("the head is {show} · d.m.yyyy, with no leading zeros and no slashes", () => {
  const html = body();
  if (!html.includes("SFI · 17.8.2026")) throw new Error("date shape wrong");
  if (html.includes("17/08/2026")) throw new Error("displayDate's shape leaked in");
});

check("the guest joins the head only when there is one", () => {
  if (!body({ guest: "דנה" }).includes("SFI · 17.8.2026 · דנה")) throw new Error("guest missing");
  if (body({ guest: "   " }).includes("· ·")) throw new Error("blank guest left a lonely separator");
});

check("the Davidson window: no suggestion → the field is empty and says why", () => {
  const html = body({ showName: "מכון דודיסון", recordDate: "2026-07-12", suggested: null, value: "" });
  if (!html.includes(CREATE_JOB_COPY.noSuggestion)) throw new Error("the no-price sentence is missing");
  if (html.includes(CREATE_JOB_COPY.suggested)) throw new Error("it claimed a computed price it does not have");
  if (!html.includes("12.7.2026")) throw new Error("date missing");
});

check("the suggestion is shown with its number", () => {
  const html = body({ suggested: 1000 });
  if (!html.includes("1,000 ₪")) throw new Error("the suggested amount is not on screen");
});

// `disabled=""` is the ATTRIBUTE React emits for a true boolean prop. The bare
// word "disabled" also appears in every Tailwind `disabled:opacity-40` class on
// these elements, so a substring check for it passes on a live button — which
// is exactly how an assertion ends up proving nothing.
const disabledCount = (html: string) => count(html, 'disabled=""');

check("an invalid amount disables יצירה", () => {
  if (disabledCount(body({ value: "0" })) < 1) throw new Error("a zero amount left the button live");
});

check("an empty amount disables יצירה", () => {
  if (disabledCount(body({ value: "" })) < 1) throw new Error("an empty field left the button live");
});

check("a valid amount leaves every control live", () => {
  const n = disabledCount(body({ value: "1000" }));
  if (n !== 0) throw new Error(`a valid amount disabled ${n} control(s)`);
});

check("busy disables the field and both buttons, and shows no NaN", () => {
  const html = body({ busy: true });
  const n = disabledCount(html);
  if (n !== 3) throw new Error(`expected field + 2 buttons disabled, got ${n}`);
  if (html.includes("NaN")) throw new Error("NaN reached the screen");
});

check("an error is shown inside the window", () => {
  const html = body({ error: "להפקה כבר יש עבודה." });
  if (!html.includes("להפקה כבר יש עבודה.")) throw new Error("error line missing");
});

check("after success: the message, and NO live יצירה button", () => {
  const html = body({ done: true });
  if (!html.includes(CREATE_JOB_COPY.done)) throw new Error("success line missing");
  if (count(html, CREATE_JOB_COPY.submit) !== 0) throw new Error("the create button survived the success");
  if (!html.includes(CREATE_JOB_COPY.close)) throw new Error("no way to dismiss the window");
});

console.log("\n── broken payloads (version skew) ──");

check("showName undefined", () => body({ showName: undefined }));
check("showName null", () => {
  const html = body({ showName: null });
  if (html.includes("null")) throw new Error("the word null reached the screen");
});
check("recordDate null", () => {
  const html = body({ recordDate: null });
  if (html.includes("NaN")) throw new Error("NaN reached the screen");
});
check("recordDate is not a date", () => body({ recordDate: "17/08/2026" }));
check("guest undefined", () => body({ guest: undefined }));
check("suggested undefined", () => {
  const html = body({ suggested: undefined });
  if (!html.includes(CREATE_JOB_COPY.noSuggestion)) throw new Error("undefined was not treated as absent");
});
check("suggested NaN is treated as absent, never printed", () => {
  const html = body({ suggested: NaN });
  if (html.includes("NaN")) throw new Error("NaN reached the screen");
  if (!html.includes(CREATE_JOB_COPY.noSuggestion)) throw new Error("NaN was not treated as absent");
});
check("every field empty at once", () =>
  body({ showName: null, recordDate: null, guest: null, suggested: null, value: "" }));

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
