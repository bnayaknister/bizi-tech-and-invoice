/**
 * The screen a dead booking link gets. Its OWN module, not a function inside
 * page.tsx, for one reason: the render suite has to be able to import and
 * render it, and a Next page file is an async server component that resolves a
 * token against the database before it renders anything.
 *
 * ⚠️ ONE SCREEN FOR EVERY FAILURE — unknown token, revoked token, malformed
 * token. A visitor probing URLs must not be able to tell them apart, because
 * the difference would confirm that a given token was once real. That is the
 * same single-value rule `resolveBookingLink` enforces on the server side;
 * this is its face.
 *
 * It names no show, carries no link to anywhere in the app, and says what to
 * do next.
 */
export const DEAD_LINK = "הקישור הזה לא פעיל. פנו לאולפן לקישור חדש.";

export default function DeadLink() {
  return (
    <div dir="rtl" className="mx-auto w-full max-w-[420px] px-4 py-16 text-center space-y-3">
      <div className="text-4xl">🎙️</div>
      <p className="text-sm text-[var(--dim)]">{DEAD_LINK}</p>
    </div>
  );
}
