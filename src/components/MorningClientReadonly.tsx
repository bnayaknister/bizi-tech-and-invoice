"use client";

// Read-only Morning-mapping indicator for the SHOW screen (owner 2026-07-29).
//
// The Morning mapping is a CLIENT property (clients.morning_client_id) — there
// is no such column on shows. The show screen must therefore only DISPLAY it,
// never pretend to edit it: an inline editor here writes to the client (all its
// shows) and, worse, the old field showed a saved-looking result the show could
// never persist. Actual mapping happens on the dedicated screen, linked below.
export default function MorningClientReadonly({
  mapped,
  canEdit,
}: {
  mapped: boolean;
  canEdit: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={mapped ? "text-[var(--green)]" : "text-[var(--faint)]"}>
        {mapped ? "משויך למורנינג" : "לא משויך"}
      </span>
      {canEdit && (
        <a
          href="/settings/morning-clients"
          className="text-[10px] text-[var(--signal)] hover:underline"
        >
          {mapped ? "ערוך במסך המיפוי" : "מפה במסך המיפוי"}
        </a>
      )}
    </div>
  );
}
