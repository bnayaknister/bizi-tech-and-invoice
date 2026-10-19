"use client";

import { useRef, useState } from "react";
import { classifyDriveLink } from "@/lib/review/drive";
import { displayDate, displayStampDate } from "@/lib/dates";
import ReviewPlayer, { formatPinTime, type ClientCommentView, type ClientVersionView, type PlayerApi } from "./ReviewPlayer";

// The client-facing review UI. Mobile-first — it opens from WhatsApp. Two
// blocks (episode / reels), each independently approved or sent back with a
// note. An already-approved track shows locked ✓ and can't be reopened.

type Choice = "approved" | "revisions" | null;

export type ReviewAddon = { id: string; title: string; quantity: number; unit_price: number; total: number };

// mirrors ReviewItem from lib/review/links (redeclared locally like
// ReviewAddon — this is a client component)
export type ReviewItemView = {
  id: string;
  kind: "episode" | "reel";
  reel_index: number | null;
  media_link: string | null;
  approved: boolean;
};

const NIS = new Intl.NumberFormat("he-IL");

const card: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 18,
  padding: 18,
  background: "rgba(255,255,255,0.035)",
  marginBottom: 14,
};

// stage-0 media rendering, shared by the track blocks and the per-item boxes:
// a Drive FILE link gets the embedded player (/preview), anything else keeps
// the plain button
function MediaView({ link }: { link: string }) {
  const media = classifyDriveLink(link);
  if (media.type !== "file") {
    return (
      <a
        href={media.url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "block",
          textAlign: "center",
          border: "1px solid rgba(255,255,255,0.14)",
          borderRadius: 12,
          padding: "10px",
          fontSize: 14,
          color: "#c9c3e8",
          marginBottom: 12,
          textDecoration: "none",
        }}
      >
        ▶ צפייה והורדה בגוגל דרייב
      </a>
    );
  }
  return (
    <div style={{ marginBottom: 12 }}>
      {/* 4:3 FOR A 16:9 VIDEO, ON PURPOSE. The bars are the point — do not
          "fix" them away by matching the ratio to the footage.

          `/preview` letterboxes (contain), confirmed by behaviour rather than
          by reading anything: raising the frame from 16:9 to 4:3 made the
          vertical reel BIGGER. Under cover it would have cropped more and
          looked worse. So nothing here is ever cut by the frame.

          WHAT WAS ACTUALLY WRONG. The episode measures 1920x1080 — exactly
          16:9 — so in a 16:9 frame it filled the frame edge to edge, with no
          slack anywhere. Google's control bar then sits ON the bottom of the
          picture, and that is where the burned-in caption lives. At phone
          width the frame is about 322px (390 screen − 32 page padding − 36 card
          padding), so the video is ~181px tall and a ~40px control bar covers
          roughly a fifth of it. Full screen looks fine for the same reason in
          reverse: the same 40px over ~800px is 5%, and it auto-hides.

          WHY 4:3 FIXES IT. 16:9 is wider than 4:3, so the video is
          width-limited: it renders at the same ~322x181 either way, and the
          extra height becomes empty space above and below. The control bar now
          sits in that empty space instead of over the picture. THE BARS ARE THE
          PRICE OF A READABLE CAPTION — going back to 16:9 to close them brings
          the occlusion straight back.

          AND THE RATIO IS THE WRONG LEVER FOR SIZE. A width-limited video does
          not grow by one pixel when the frame gets taller. The only thing that
          would actually enlarge it is WIDTH, and width is pinned by the card's
          maxWidth: 420 in three places. That is a layout change, not a frame
          change — it is in the backlog, deliberately not done here.

          The reel gets the same frame and is better for it: it is
          height-limited, so a taller frame makes it larger. One ratio for both,
          which is also all MediaView can do — it is never told which it is
          rendering, and no measurement to tell them apart exists. There is no
          Google API in this project, the page is public and account-less, and a
          cross-origin iframe reports no height and posts no message; we hold a
          URL string and drive.ts derives a file id from it. Letting the frame
          size itself is not available either — with no ratio and no height an
          iframe collapses to the browser default of 150px. */}
      <iframe
        src={media.embedUrl}
        allow="autoplay; fullscreen"
        allowFullScreen
        style={{
          width: "100%",
          aspectRatio: "4 / 3",
          border: "1px solid rgba(255,255,255,0.14)",
          borderRadius: 12,
          background: "rgba(0,0,0,0.25)",
        }}
      />
      {/* The way OUT of the embed, and the only one there is.
          `/preview` is a sealed player: no full screen worth the name on a
          phone, and no download. Drive's own download button lives on the file
          page, so the client has to get there — and this is the link that takes
          them, to media.url, the URL exactly as it was pasted.

          It used to read "אם הסרטון לא מוצג — פתחו בטאב חדש" in 11px grey
          beside a 12px link: framed as troubleshooting, which is not what a
          client looking to download is scanning for. Same href, said as the
          thing you may do rather than the thing to try when something breaks.

          NO second anchor was added: the folder branch above already links to
          media.url, and a file already had this one. Two links to one address
          six pixels apart is the confusion, not the fix.

          IT PROMISES OPENING, NEVER DOWNLOADING. Whether a download button
          appears at all is Drive's sharing permission on that file, which is
          the owner's setting and not ours — so the wording commits only to
          what we control. And deliberately NOT ?export=download: that breaks
          outright on a folder, and on a large file Google answers with its
          virus-scan interstitial instead of the bytes. */}
      <div style={{ textAlign: "center", marginTop: 8 }}>
        <a
          href={media.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 13, color: "#c9c3e8", textDecoration: "underline" }}
        >
          פתחו בגוגל דרייב — לצפייה במסך מלא או להורדה ↗
        </a>
      </div>
    </div>
  );
}

// ═══ "חומרים נוספים" — transcript + separate audio (0076) ═══
//
// MODULE LEVEL for the same reason Block is (see below): a component declared
// inside ReviewClient is a new type on every render, and the transcript's
// open/closed state would reset on every keystroke in a note above it.
//
// THE TRANSCRIPT IS COLLAPSED BY DEFAULT, and that is the decision here.
// This page opens from WhatsApp on a phone, the card is 420px at most, and a
// pasted transcript is tens of thousands of characters. Rendered open it would
// push the approve buttons — the only thing the client came for — far below the
// fold, and pull the whole body over mobile data before anyone asked for it.
// So: the label states the size, opening is the client's choice, and the opened
// body is BOUNDED at 45vh with its own scroll. A nested scroll area inside a
// scrolling page is a real trap, which is why it exists only after an explicit
// tap and sits in a visibly bordered box rather than bleeding into the page.
//
// AUDIO IS A LINK, NOT AN EMBED. A Drive share URL is not a direct media URL,
// so <audio> cannot play it at all; and MediaView's iframe is pinned to
// aspectRatio 4/3, which is a video-shaped box for a sound file. The plain
// anchor is the same branch MediaView already uses for folders and unknown
// links — known to work. An embed can come later, once someone has actually
// looked at Drive's audio /preview on a phone.
function ExtraMaterials({
  transcript,
  audioLink,
}: {
  transcript: { content: string; source: "pasted" | "link" | "auto"; char_count: number | null } | null;
  audioLink: string | null;
}) {
  const [open, setOpen] = useState(false);
  // 'link' means content holds a URL to a document rather than the text (0076),
  // so there is nothing to unfold and char_count is NULL there by design
  const isDoc = transcript?.source === "link";

  const linkStyle: React.CSSProperties = {
    display: "block",
    textAlign: "center",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 12,
    padding: "10px",
    fontSize: 14,
    color: "#c9c3e8",
    textDecoration: "none",
  };

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 22 }}>📎</span>
        <span style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>חומרים נוספים</span>
      </div>
      <p style={{ fontSize: 12, color: "#9a94b8", marginBottom: 12 }}>
        אלה נשלחים אליך יחד עם הפרק — אין צורך לאשר אותם.
      </p>

      {transcript && (
        <div style={{ marginBottom: audioLink ? 12 : 0 }}>
          {isDoc ? (
            <a href={transcript.content} target="_blank" rel="noopener noreferrer" style={linkStyle}>
              📄 תמלול הפרק — פתח מסמך ↗
            </a>
          ) : (
            <>
              <button
                onClick={() => setOpen((v) => !v)}
                style={{
                  ...linkStyle,
                  width: "100%",
                  background: "transparent",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ flex: 1, textAlign: "right" }}>
                  📄 תמלול הפרק
                  {transcript.char_count != null && (
                    <span style={{ color: "#9a94b8" }}>
                      {" · "}
                      {NIS.format(transcript.char_count)} תווים
                    </span>
                  )}
                </span>
                <span style={{ color: "#9a94b8", fontSize: 13 }}>{open ? "הסתר" : "הצג"}</span>
              </button>
              {open && (
                <div
                  style={{
                    marginTop: 8,
                    maxHeight: "45vh",
                    overflowY: "auto",
                    WebkitOverflowScrolling: "touch",
                    border: "1px solid rgba(255,255,255,0.14)",
                    borderRadius: 12,
                    padding: 12,
                    background: "rgba(0,0,0,0.25)",
                    fontSize: 13,
                    lineHeight: 1.7,
                    color: "#c9c3e8",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {transcript.content}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {audioLink && (
        <a href={audioLink} target="_blank" rel="noopener noreferrer" style={linkStyle}>
          🎧 קובץ אודיו נפרד — האזנה והורדה בגוגל דרייב
        </a>
      )}
    </div>
  );
}

// One deliverable: its player, its approve/revisions pair, and the correction
// note that appears when the client picks revisions.
//
// MODULE LEVEL, and it has to stay here. It lived inside ReviewClient until
// 2026-09-05, which made it a NEW component type on every render — so React
// tore down the whole subtree and rebuilt it after each keystroke: the
// textarea lost focus mid-word, and the Drive iframe below it reloaded from
// the start. It closes over nothing from ReviewClient (every value it reads is
// a prop; `card` and `MediaView` are module-level), which is exactly why the
// fix is a move and not a rewrite.
const Block = ({
  emoji,
  title,
  approved,
  pending,
  link,
  choice,
  setChoice,
  note,
  setNote,
  notePlaceholder,
  media,
  respondHint,
  extra,
  onApprove,
  onRevisions,
  hideNote,
}: {
  emoji: string;
  title: string;
  approved: boolean;
  pending: boolean;
  link: string | null;
  choice: Choice;
  setChoice: (c: Choice) => void;
  note: string;
  setNote: (s: string) => void;
  notePlaceholder: string;
  /** E13-6: the player + picker for an item that reached Bunny — replaces today's Drive view */
  media?: React.ReactNode;
  /** E13-6: an older version is selected — no response controls, this line instead (owner 16.10, §4b (2)) */
  respondHint?: string | null;
  /** E13-8b: the comment box / re-approve, under everything else */
  extra?: React.ReactNode;
  /** E13-8c: replaces setChoice("approved") — the "יש לך הערות" confirm */
  onApprove?: () => void;
  /** E13-8c: replaces setChoice("revisions") — on a Bunny version it opens the pins */
  onRevisions?: () => void;
  /** E13-8c: no free-text note under "תיקונים" (a Bunny version: the pins are the note) */
  hideNote?: boolean;
}) => (
  <div style={card}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
      <span style={{ fontSize: 22 }}>{emoji}</span>
      <span style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>{title}</span>
      {approved && <span style={{ color: "#4ade80", fontSize: 13, fontWeight: 700 }}>✓ אושר</span>}
    </div>
    {media ?? (link && <MediaView link={link} />)}
    {pending && respondHint && (
      <div style={{ fontSize: 13, color: "#9a94b8", textAlign: "center", padding: "6px 0" }}>{respondHint}</div>
    )}
    {pending && !respondHint && (
      <>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => (onApprove ? onApprove() : setChoice("approved"))}
            style={{
              flex: 1,
              padding: "10px",
              borderRadius: 12,
              fontSize: 14,
              fontWeight: 700,
              border: choice === "approved" ? "1px solid #4ade80" : "1px solid rgba(255,255,255,0.14)",
              background: choice === "approved" ? "rgba(74,222,128,0.15)" : "transparent",
              color: choice === "approved" ? "#4ade80" : "#ece9f5",
            }}
          >
            ✓ מאשר
          </button>
          <button
            onClick={() => (onRevisions ? onRevisions() : setChoice("revisions"))}
            style={{
              flex: 1,
              padding: "10px",
              borderRadius: 12,
              fontSize: 14,
              fontWeight: 700,
              border: choice === "revisions" ? "1px solid #fbbf24" : "1px solid rgba(255,255,255,0.14)",
              background: choice === "revisions" ? "rgba(251,191,36,0.15)" : "transparent",
              color: choice === "revisions" ? "#fbbf24" : "#ece9f5",
            }}
          >
            ✎ תיקונים
          </button>
        </div>
        {choice === "revisions" && !hideNote && (
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={notePlaceholder}
            rows={3}
            style={{
              width: "100%",
              marginTop: 10,
              background: "rgba(0,0,0,0.25)",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: 12,
              padding: 10,
              color: "#ece9f5",
              fontSize: 14,
              fontFamily: "inherit",
              resize: "vertical",
            }}
          />
        )}
      </>
    )}
    {extra}
  </div>
);

// E13-8b — the comment box under an item (plan §9.2 E13-8 (e); owner 17.10).
// MODULE LEVEL like Block: declared inside ReviewClient it would be a new
// component type on every render, and the textarea would lose focus per key.
//   · post_response: opened by "יש לי עוד הערה" — a pin at the player's time
//     when the current version is a Bunny one, else a general comment.
//   · live link (decision 1): a pin only, opened by "📍 הערה בנקודת זמן".
function CommentBox({
  pinMs,
  pinOn,
  setPinOn,
  pinOnly,
  noPinReason,
  text,
  setText,
  busy,
  error,
  onSend,
  onCancel,
}: {
  pinMs: number | null;
  pinOn: boolean;
  setPinOn: (v: boolean) => void;
  pinOnly: boolean;
  noPinReason: string | null;
  text: string;
  setText: (s: string) => void;
  busy: boolean;
  error: string | null;
  onSend: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ marginTop: 10, padding: 10, borderRadius: 12, border: "1px solid rgba(167,139,250,0.35)", background: "rgba(167,139,250,0.06)" }}>
      {pinMs !== null && !pinOnly && (
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={pinOn} onChange={(e) => setPinOn(e.target.checked)} />
          <span>
            📍 הערה בנקודה <span dir="ltr">{formatPinTime(pinMs)}</span>
          </span>
        </label>
      )}
      {pinMs !== null && pinOnly && (
        <div style={{ fontSize: 13, marginBottom: 8 }}>
          📍 הערה בנקודה <span dir="ltr">{formatPinTime(pinMs)}</span>
        </div>
      )}
      {pinMs === null && noPinReason && <div style={{ fontSize: 12, color: "#9a94b8", marginBottom: 8 }}>{noPinReason}</div>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="מה תרצו להעיר?"
        rows={3}
        maxLength={2000}
        style={{
          width: "100%",
          background: "rgba(0,0,0,0.25)",
          border: "1px solid rgba(255,255,255,0.14)",
          borderRadius: 12,
          padding: 10,
          color: "#ece9f5",
          fontSize: 14,
          fontFamily: "inherit",
          resize: "vertical",
          boxSizing: "border-box",
        }}
      />
      {error && <div style={{ color: "#fb7185", fontSize: 12, marginTop: 6 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button
          type="button"
          onClick={onSend}
          disabled={busy || !text.trim()}
          style={{
            flex: 1,
            padding: "10px",
            borderRadius: 12,
            fontSize: 14,
            fontWeight: 700,
            border: "none",
            background: "linear-gradient(135deg, #8b5cf6, #6d28d9)",
            color: "white",
            opacity: busy || !text.trim() ? 0.5 : 1,
          }}
        >
          {busy ? "שולח…" : "שליחה"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          style={{ padding: "10px 16px", borderRadius: 12, fontSize: 14, border: "1px solid rgba(255,255,255,0.14)", background: "transparent", color: "#ece9f5" }}
        >
          ביטול
        </button>
      </div>
    </div>
  );
}

const linkButton: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: "4px 0",
  color: "#c4b5fd",
  fontSize: 13,
  textDecoration: "underline",
  cursor: "pointer",
};

export default function ReviewClient({
  token,
  showName,
  episodeLabel,
  recordDate,
  episodeIncluded,
  reelsIncluded,
  episodeApproved,
  reelsApproved,
  episodeLink,
  reelsLink,
  addons,
  items = [],
  transcript = null,
  audioLink = null,
  versionsByItem = {},
  respondedAt = null,
  comments = {},
  reapprovable = {},
  currentVersion: currentVersionProp,
}: {
  token: string;
  showName: string;
  episodeLabel: string;
  recordDate: string | null;
  episodeIncluded: boolean;
  reelsIncluded: boolean;
  episodeApproved: boolean;
  reelsApproved: boolean;
  episodeLink: string | null;
  reelsLink: string | null;
  addons: ReviewAddon[];
  // per-deliverable items (0057). Empty → the production predates the items
  // model and the page renders the original track-level layout unchanged.
  items?: ReviewItemView[];
  // "חומרים נוספים" (0076) — received, not judged. Both optional and both
  // usually absent; the section does not exist when they are.
  transcript?: { content: string; source: "pasted" | "link" | "auto"; char_count: number | null } | null;
  audioLink?: string | null;
  // E13-6: per item, the versions the client may see (lib/review/clientVersions).
  // An item absent here never reached Bunny and renders exactly as before.
  versionsByItem?: Record<string, ClientVersionView[]>;
  // E13-7: set when the link was already answered (post_response). The page
  // is then view + download only: a line saying when the answer arrived, no
  // approve / revisions buttons, no add-on choices, no submit — responding on
  // the latest version opens in E13-8, in a route of its own.
  respondedAt?: string | null;
  // E13-8b: the client's own comments per item, which items may be approved
  // again from this link, and each item's current version id (what a comment
  // is about — a Drive row when nothing reached Bunny). All optional: absent =
  // the page as E13-7 left it.
  comments?: Record<string, ClientCommentView[]>;
  reapprovable?: Record<string, boolean>;
  currentVersion?: Record<string, string | null>;
}) {
  const viewOnly = !!respondedAt;
  // ── E13-8b: comment box state, per item ──
  // no currentVersion from the server (its read failed, rule 38) → no box at
  // all: a comment would have no version to name, and the route would refuse it
  const commentsEnabled = currentVersionProp !== undefined;
  const currentVersion = currentVersionProp ?? {};
  const playerApis = useRef<Record<string, PlayerApi | null>>({});
  const [addedComments, setAddedComments] = useState<Record<string, ClientCommentView[]>>({});
  const [approvedNow, setApprovedNow] = useState<Record<string, boolean>>({});
  const [reapproveNow, setReapproveNow] = useState<Record<string, boolean>>({});
  const [boxOpen, setBoxOpen] = useState<Record<string, boolean>>({});
  const [boxText, setBoxText] = useState<Record<string, string>>({});
  const [boxPinMs, setBoxPinMs] = useState<Record<string, number | null>>({});
  const [boxPinOn, setBoxPinOn] = useState<Record<string, boolean>>({});
  const [boxBusy, setBoxBusy] = useState<string | null>(null);
  const [boxError, setBoxError] = useState<Record<string, string | null>>({});
  const [boxSent, setBoxSent] = useState<Record<string, string | null>>({});

  const openBox = (itemId: string, canPin: boolean) => {
    const api = canPin ? playerApis.current[itemId] : null;
    if (api) api.pause(); // the time must not run on while the client types
    setBoxPinMs((p) => ({ ...p, [itemId]: api ? api.currentMs() : null }));
    setBoxPinOn((p) => ({ ...p, [itemId]: !!api }));
    setBoxError((p) => ({ ...p, [itemId]: null }));
    setBoxSent((p) => ({ ...p, [itemId]: null }));
    setBoxOpen((p) => ({ ...p, [itemId]: true }));
  };

  async function postItem(itemId: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBoxBusy(itemId);
    setBoxError((p) => ({ ...p, [itemId]: null }));
    try {
      const res = await fetch(`/api/r/${encodeURIComponent(token)}/items/${encodeURIComponent(itemId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setBoxError((p) => ({ ...p, [itemId]: typeof body.error === "string" ? body.error : "השמירה נכשלה" }));
        return null;
      }
      return body;
    } catch {
      setBoxError((p) => ({ ...p, [itemId]: "שגיאת רשת" }));
      return null;
    } finally {
      setBoxBusy(null);
    }
  }

  async function sendComment(itemId: string) {
    const text = (boxText[itemId] ?? "").trim();
    if (!text) return;
    const pinMs = boxPinMs[itemId];
    const asPin = boxPinOn[itemId] && pinMs !== null && pinMs !== undefined;
    const body = await postItem(
      itemId,
      asPin
        ? { action: "pin", version_id: currentVersion[itemId], time_ms: pinMs, body: text }
        : { action: "comment", version_id: currentVersion[itemId] ?? null, body: text }
    );
    if (!body) return;
    const c = body.comment as ClientCommentView | undefined;
    if (c) setAddedComments((p) => ({ ...p, [itemId]: [...(p[itemId] ?? []), c] }));
    if (body.revoked) {
      setApprovedNow((p) => ({ ...p, [itemId]: false }));
      setReapproveNow((p) => ({ ...p, [itemId]: true }));
    }
    setBoxText((p) => ({ ...p, [itemId]: "" }));
    setBoxOpen((p) => ({ ...p, [itemId]: false }));
    if (viewOnly) {
      setBoxSent((p) => ({ ...p, [itemId]: "ההערה הועברה לצוות" }));
    } else {
      // E13-8c (owner 17.10): the first pin on an item marks it "תיקונים"
      setItemChoice((prev) => ({ ...prev, [itemId]: "revisions" }));
      setError(null);
      setBoxSent((p) => ({ ...p, [itemId]: "ההערה נשמרה. תישלח לצוות עם התשובה" }));
    }
  }

  async function reapprove(itemId: string) {
    const body = await postItem(itemId, { action: "approve", version_id: currentVersion[itemId] });
    if (!body) return;
    setApprovedNow((p) => ({ ...p, [itemId]: true }));
    setReapproveNow((p) => ({ ...p, [itemId]: false }));
    setBoxSent((p) => ({ ...p, [itemId]: "אושר שוב, תודה" }));
  }
  const [epChoice, setEpChoice] = useState<Choice>(null);
  // E13-6: which version each item shows; absent = the current (latest) one
  const [selectedVersion, setSelectedVersion] = useState<Record<string, string>>({});
  const [epNote, setEpNote] = useState("");
  const [reChoice, setReChoice] = useState<Choice>(null);
  const [reNote, setReNote] = useState("");
  // stage 1b: one decision + note per item, keyed by item id
  const [itemChoice, setItemChoice] = useState<Record<string, Choice>>({});
  const [itemNote, setItemNote] = useState<Record<string, string>>({});
  // each quoted upsell starts checked — a quote the client accepts by default
  // and unchecks to decline (owner spec 2026-07-21)
  const [addonOk, setAddonOk] = useState<Record<string, boolean>>(
    () => Object.fromEntries(addons.map((a) => [a.id, true]))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | "approved" | "revisions">(null);

  const hasItems = items.length > 0;
  // pending, in-scope items — each demands its own decision before submit
  const pendingItems = items.filter(
    (i) => !i.approved && (i.kind === "episode" ? episodeIncluded : reelsIncluded)
  );

  const episodePending = episodeIncluded && !episodeApproved;
  const reelsPending = reelsIncluded && !reelsApproved;
  // the submit becomes the big "approve everything" action once every
  // pending deliverable is set to approved and none to revisions
  const willApproveAll = hasItems
    ? pendingItems.every((i) => itemChoice[i.id] === "approved")
    : (!episodePending || epChoice === "approved") &&
      (!reelsPending || reChoice === "approved") &&
      epChoice !== "revisions" &&
      reChoice !== "revisions";

  const itemLabel = (i: ReviewItemView) => (i.kind === "episode" ? "פרק מלא" : `ריל ${i.reel_index}`);

  // E13-8c: on a live link, is this item's CURRENT version a Bunny one, on
  // screen? Then "✎ תיקונים" means pins (owner 17.10, option א).
  const liveBunny = (it: ReviewItemView) => {
    const versions = versionsByItem[it.id];
    if (viewOnly || !commentsEnabled || !versions?.length) return false;
    const latest = versions[versions.length - 1];
    const selectedId = selectedVersion[it.id] ?? latest.id;
    return latest.kind === "bunny" && selectedId === latest.id;
  };
  // the client's comments on this item from THIS link (the round on screen)
  const myCommentCount = (it: ReviewItemView) =>
    [...(comments[it.id] ?? []), ...(addedComments[it.id] ?? [])].filter((c) => c.mine).length;

  async function submit() {
    setError(null);
    let payload: Record<string, unknown>;
    if (hasItems) {
      // per-item validation: every pending box needs a decision, and a
      // revisions decision needs its note
      for (const it of pendingItems) {
        const c = itemChoice[it.id];
        if (!c) {
          setError(`בחר אישור או תיקונים — ${itemLabel(it)}`);
          return;
        }
        if (c === "revisions" && !(itemNote[it.id] ?? "").trim()) {
          // E13-8c: on a Bunny version the pins ARE the note (the server
          // checks the same and records "N הערות בנגן" on the round)
          if (liveBunny(it) && myCommentCount(it) > 0) continue;
          setError(liveBunny(it) ? `הוסיפו לפחות הערה אחת בנגן — ${itemLabel(it)}` : `נא לפרט מה לתקן — ${itemLabel(it)}`);
          return;
        }
      }
      payload = {
        items: Object.fromEntries(
          pendingItems.map((it) => [it.id, { response: itemChoice[it.id], note: itemNote[it.id] ?? "" }])
        ),
        addons: Object.fromEntries(addons.map((a) => [a.id, addonOk[a.id] ? "approved" : "rejected"])),
      };
    } else {
      if (episodePending && !epChoice && !(reelsPending && reChoice)) {
        setError("בחר אישור או תיקונים");
        return;
      }
      if (episodePending && epChoice === "revisions" && !epNote.trim()) {
        setError("נא לפרט מה לתקן בפרק");
        return;
      }
      if (reelsPending && reChoice === "revisions" && !reNote.trim()) {
        setError("נא לפרט מה לתקן ברילז");
        return;
      }
      payload = {
        episode: episodePending ? epChoice ?? undefined : undefined,
        episode_note: epNote,
        reels: reelsPending ? reChoice ?? undefined : undefined,
        reels_note: reNote,
        addons: Object.fromEntries(addons.map((a) => [a.id, addonOk[a.id] ? "approved" : "rejected"])),
      };
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/r/${token}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "שליחה נכשלה");
        return;
      }
      setDone(body.approved_all ? "approved" : "revisions");
    } catch {
      setError("שגיאת רשת");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div style={{ ...card, textAlign: "center", padding: 32 }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>{done === "approved" ? "✅" : "📝"}</div>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
          {done === "approved" ? "אושר — תודה!" : "התקבל, תודה!"}
        </h2>
        <p style={{ fontSize: 14, color: "#9a94b8" }}>
          {done === "approved" ? "העברנו את האישור לצוות." : "העברנו את ההערות לצוות והם יחזרו אליך."}
        </p>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", maxWidth: 420 }}>
      <div style={{ textAlign: "center", marginBottom: 18 }}>
        <h1 style={{ fontSize: 20, fontWeight: 800 }}>{showName}</h1>
        <p style={{ fontSize: 13, color: "#9a94b8", marginTop: 4 }}>
          {episodeLabel}
          {displayDate(recordDate) ? ` · ${displayDate(recordDate)}` : ""}
        </p>
      </div>

      {viewOnly && (
        <div
          style={{
            ...card,
            textAlign: "center",
            padding: "12px 14px",
            fontSize: 14,
            fontWeight: 700,
            color: "#c4b5fd",
            border: "1px solid rgba(167,139,250,0.35)",
            background: "rgba(167,139,250,0.08)",
          }}
        >
          {displayStampDate(respondedAt) ? `התשובה שלכם התקבלה ב-${displayStampDate(respondedAt)}` : "התשובה שלכם התקבלה"}
        </div>
      )}

      {(() => {
        // item-based layout (stage 1b): a box per deliverable, each with its
        // OWN approve/revisions buttons and note — the client can approve reel
        // 1 and ask for fixes on reel 2 in the same submit. An item approved
        // in an earlier round renders locked (✓) and can't be reopened. A
        // production without items renders the original track-level layout.
        const episodeItem = items.find((i) => i.kind === "episode") ?? null;
        const reelItems = items.filter((i) => i.kind === "reel");

        if (!hasItems) {
          return (
            <>
              {episodeIncluded && (
                <Block
                  emoji="🎬"
                  title="הפרק המלא"
                  approved={episodeApproved}
                  pending={episodePending && !viewOnly}
                  link={episodeLink}
                  choice={epChoice}
                  setChoice={(c) => {
                    setError(null);
                    setEpChoice(c);
                  }}
                  note={epNote}
                  setNote={(t) => {
                    setError(null);
                    setEpNote(t);
                  }}
                  notePlaceholder="מה לתקן בפרק?"
                />
              )}
              {reelsIncluded && (
                <Block
                  emoji="📱"
                  title="רילז"
                  approved={reelsApproved}
                  pending={reelsPending && !viewOnly}
                  link={reelsLink}
                  choice={reChoice}
                  setChoice={(c) => {
                    setError(null);
                    setReChoice(c);
                  }}
                  note={reNote}
                  setNote={(t) => {
                    setError(null);
                    setReNote(t);
                  }}
                  notePlaceholder="מה לתקן ברילז?"
                />
              )}
            </>
          );
        }

        const itemBlock = (it: ReviewItemView, emoji: string, title: string, fallbackLink: string | null, notePlaceholder: string) => {
          const versions = versionsByItem[it.id];
          const latestId = versions?.length ? versions[versions.length - 1].id : null;
          const selectedId = selectedVersion[it.id] ?? latestId;
          // ── E13-8b ──
          const approved = approvedNow[it.id] ?? it.approved;
          const onLatest = !latestId || selectedId === latestId;
          const latest = versions?.length ? versions[versions.length - 1] : null;
          const canPin = !!latest && latest.kind === "bunny" && onLatest;
          // E13-10 (owner 18.10): the media left Bunny → an archive: the old
          // comments and the Drive download only — no box, no re-approval
          const archived = latest?.kind === "archived";
          const itemComments = [...(comments[it.id] ?? []), ...(addedComments[it.id] ?? [])];
          const mayReapprove = !archived && commentsEnabled && viewOnly && !approved && (reapproveNow[it.id] ?? !!reapprovable[it.id]) && onLatest && !!currentVersion[it.id];
          const revokedHere = approvedNow[it.id] === false && it.approved;
          const box = boxOpen[it.id] && !archived ? (
            <CommentBox
              pinMs={boxPinMs[it.id] ?? null}
              pinOn={!!boxPinOn[it.id]}
              setPinOn={(v) => setBoxPinOn((p) => ({ ...p, [it.id]: v }))}
              pinOnly={false}
              noPinReason={viewOnly && !canPin ? "בגרסה הזו אין הערה בנקודת זמן" : null}
              text={boxText[it.id] ?? ""}
              setText={(t) => setBoxText((p) => ({ ...p, [it.id]: t }))}
              busy={boxBusy === it.id}
              error={boxError[it.id] ?? null}
              onSend={() => void sendComment(it.id)}
              onCancel={() => setBoxOpen((p) => ({ ...p, [it.id]: false }))}
            />
          ) : null;
          const extra = (
            <>
              {revokedHere && <div style={{ fontSize: 13, color: "#fbbf24", textAlign: "center", marginTop: 8 }}>ממתין · ההערה הועברה לצוות</div>}
              {!revokedHere && boxSent[it.id] && <div style={{ fontSize: 13, color: "#4ade80", textAlign: "center", marginTop: 8 }}>{boxSent[it.id]}</div>}
              {viewOnly && !onLatest && <div style={{ fontSize: 13, color: "#9a94b8", textAlign: "center", padding: "6px 0" }}>אפשר להגיב רק על הגרסה הנוכחית</div>}
              {box}
              {commentsEnabled && !archived && !boxOpen[it.id] && viewOnly && onLatest && (
                <div style={{ textAlign: "center", marginTop: 6 }}>
                  <button type="button" style={linkButton} onClick={() => openBox(it.id, canPin)}>
                    יש לי עוד הערה
                  </button>
                </div>
              )}
              {/* E13-8c: on a live link "✎ תיקונים" opens the pins; after one is
                  sent, this adds the next. Pins before "תיקונים" are possible
                  too (decision 1) — the first one marks the item "תיקונים" */}
              {commentsEnabled && !archived && !boxOpen[it.id] && !viewOnly && !approved && canPin && (
                <div style={{ textAlign: "center", marginTop: 8 }}>
                  <button type="button" style={linkButton} onClick={() => openBox(it.id, true)}>
                    {myCommentCount(it) > 0 ? "📍 הוסף עוד הערה" : "📍 הערה בנקודת זמן"}
                  </button>
                </div>
              )}
              {mayReapprove && !boxOpen[it.id] && (
                <button
                  type="button"
                  onClick={() => void reapprove(it.id)}
                  disabled={boxBusy === it.id}
                  style={{
                    width: "100%",
                    marginTop: 8,
                    padding: "10px",
                    borderRadius: 12,
                    fontSize: 14,
                    fontWeight: 700,
                    border: "1px solid #4ade80",
                    background: "rgba(74,222,128,0.12)",
                    color: "#4ade80",
                    opacity: boxBusy === it.id ? 0.5 : 1,
                  }}
                >
                  {boxBusy === it.id ? "שולח…" : "✓ מאשר שוב"}
                </button>
              )}
              {!boxOpen[it.id] && boxError[it.id] && <div style={{ color: "#fb7185", fontSize: 12, textAlign: "center", marginTop: 6 }}>{boxError[it.id]}</div>}
            </>
          );
          return (
          <Block
            key={it.id}
            emoji={emoji}
            title={title}
            approved={approved}
            pending={!it.approved && !viewOnly}
            link={it.media_link || fallbackLink}
            choice={itemChoice[it.id] ?? null}
            setChoice={(c) => {
              setError(null);
              setItemChoice((prev) => ({ ...prev, [it.id]: c }));
            }}
            note={itemNote[it.id] ?? ""}
            setNote={(s) => {
              setError(null);
              setItemNote((prev) => ({ ...prev, [it.id]: s }));
            }}
            hideNote={liveBunny(it)}
            onRevisions={
              liveBunny(it)
                ? () => {
                    setError(null);
                    setItemChoice((prev) => ({ ...prev, [it.id]: "revisions" }));
                    openBox(it.id, true);
                  }
                : undefined
            }
            onApprove={() => {
              // E13-8c: approving an item the client commented on — ask once;
              // yes = approved, and the comments reach the team as minor notes
              if (myCommentCount(it) > 0 && !window.confirm("יש לך הערות. לאשר בכל זאת?")) return;
              setError(null);
              setBoxOpen((p) => ({ ...p, [it.id]: false }));
              setItemChoice((prev) => ({ ...prev, [it.id]: "approved" }));
            }}
            notePlaceholder={notePlaceholder}
            media={
              versions?.length ? (
                <ReviewPlayer
                  token={token}
                  versions={versions}
                  selectedId={selectedId}
                  onSelect={(id) => setSelectedVersion((prev) => ({ ...prev, [it.id]: id }))}
                  renderDrive={(l) => <MediaView link={l} />}
                  comments={itemComments}
                  onApi={(api) => {
                    playerApis.current[it.id] = api;
                  }}
                />
              ) : undefined
            }
            respondHint={versions?.length && selectedId !== latestId ? "אפשר להגיב רק על הגרסה הנוכחית" : null}
            extra={extra}
          />
          );
        };

        return (
          <>
            {episodeIncluded && episodeItem &&
              itemBlock(episodeItem, "🎬", "פרק מלא", episodeLink, "מה לתקן בפרק?")}
            {reelsIncluded &&
              reelItems.map((it) =>
                // an item with no link of its own falls back to the round's
                // shared reels link (legacy mints fill only that)
                itemBlock(it, "📱", `ריל ${it.reel_index}`, reelsLink, `מה לתקן בריל ${it.reel_index}?`)
              )}
          </>
        );
      })()}

      {/* ═══ חומרים נוספים (0076) — RECEIVED, NOT JUDGED ═══
          Below the approval blocks and above the add-on quote, because it is
          neither: nothing here has an approve/reject control, and the subtitle
          says so out loud rather than leaving a client to wonder whether they
          missed a button.

          NO SECTION AT ALL when both are absent — not an empty heading and not
          an "אין חומרים" line. Most rounds carry neither, and a permanent empty
          card on a page whose whole job is one decision is noise. */}
      {(transcript || audioLink) && <ExtraMaterials transcript={transcript} audioLink={audioLink} />}

      {addons.length > 0 && !viewOnly && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 22 }}>➕</span>
            <span style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>תוספות</span>
          </div>
          <p style={{ fontSize: 12, color: "#9a94b8", marginBottom: 12 }}>
            סמן את התוספות שברצונך לאשר. הסרת סימון = לא מאשר.
          </p>
          {addons.map((a) => {
            const on = addonOk[a.id];
            return (
              <button
                key={a.id}
                onClick={() => setAddonOk((prev) => ({ ...prev, [a.id]: !prev[a.id] }))}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  textAlign: "right",
                  padding: "10px 12px",
                  marginBottom: 8,
                  borderRadius: 12,
                  border: on ? "1px solid #4ade80" : "1px solid rgba(255,255,255,0.14)",
                  background: on ? "rgba(74,222,128,0.12)" : "transparent",
                  color: "#ece9f5",
                  cursor: "pointer",
                }}
              >
                <span style={{ fontSize: 16, color: on ? "#4ade80" : "#6b6685" }}>{on ? "☑" : "☐"}</span>
                <span style={{ flex: 1 }}>
                  <span style={{ display: "block", fontSize: 14, fontWeight: 600 }}>{a.title}</span>
                  <span style={{ display: "block", fontSize: 12, color: "#9a94b8", marginTop: 2 }}>
                    {a.quantity} × ₪{NIS.format(a.unit_price)}
                  </span>
                </span>
                <span style={{ fontSize: 14, fontWeight: 700 }}>₪{NIS.format(a.total)}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* the price summary card (base episode amount + total) is deliberately
          gone — the client sees no episode price here (Q1, owner 2026-08-16).
          Add-on prices above stay: the client is approving those quotes. */}

      {!viewOnly && error && (
        <div style={{ color: "#fb7185", fontSize: 13, textAlign: "center", marginBottom: 10 }}>{error}</div>
      )}

      {!viewOnly && (
      <button
        onClick={submit}
        disabled={busy}
        style={{
          width: "100%",
          maxWidth: 420,
          padding: "14px",
          borderRadius: 14,
          fontSize: 16,
          fontWeight: 800,
          border: "none",
          background: "linear-gradient(135deg, #8b5cf6, #6d28d9)",
          color: "white",
          opacity: busy ? 0.5 : 1,
          boxShadow: "0 6px 20px rgba(139,92,246,0.35)",
        }}
      >
        {busy ? "שולח…" : willApproveAll ? "✓ מאשר את כל התוצרים" : "שלח תשובה"}
      </button>
      )}
    </div>
  );
}
