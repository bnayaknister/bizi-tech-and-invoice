"use client";

// EntityDrawer — the one edit surface for every entity in the system.
// Clicking an entity anywhere (table row, kanban card, search result,
// radar alert, calendar event) opens it here instead of navigating away.
//
// Security model: this component renders ONLY what /api/entity returns.
// Fields the viewer may not see are never in the response; fields they may
// not edit arrive with editable=false; and even a forged request dies at
// RLS / the 0010 column-guard triggers. The drawer holds no permission
// logic of its own beyond what the server hands it.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  STATUS_ORDER as PROD_STATUS_ORDER,
  STATUS_LABEL as PROD_STATUS_LABEL,
  nextStatus as prodNextStatus,
} from "@/lib/productions/status";
import ClientCombobox from "@/components/ClientCombobox";
import ClientNotesModal from "./ClientNotesModal";
import IconTile, { type IconAccent } from "@/components/IconTile";
import { MILESTONE_META, type MilestoneState } from "@/lib/finance/milestone";
import { displayDate, displayDateTime, displayLogTime } from "@/lib/dates";
import { HOURS_STEP, MAX_HOURS, hoursError as validateHours, hoursMissing } from "@/lib/productions/hours";

// entity type -> line icon + tile accent (no emoji, DESIGN.md §12)
const ENTITY_ICON: Record<string, string> = {
  production: "productions",
  job: "finance",
  show: "shows",
  client: "users",
  contract: "contracts",
};
const ENTITY_ACCENT: Record<string, IconAccent> = {
  production: "violet",
  job: "rose",
  show: "cyan",
  client: "violet",
  contract: "violet-light",
};

type EntityRef = { type: string; id: string };

type FieldMeta = {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "date" | "select" | "readonly";
  editable: boolean;
  options: { value: string; label: string }[] | "clients" | "shows" | null;
};

type Stage = {
  id: string;
  track: "episode" | "reels";
  step: "record" | "edit" | "deliver";
  status: "pending" | "in_progress" | "done";
  assignee_id: string | null;
  done_at: string | null;
};

type HistoryEntry = {
  id: string;
  event_type: string;
  actor: string;
  payload: Record<string, unknown> | null;
  created_at: string;
};

// one production-journal entry (§3). kind is open-ended text on purpose — an
// unknown future kind falls back to a default icon, never crashes.
type LogEntry = {
  id: string;
  kind: string; // 'stage' | 'disk' | 'note' | 'client' | future…
  track: "episode" | "reels" | null;
  step: "record" | "edit" | "deliver" | null;
  stage_status: "pending" | "in_progress" | "done" | null;
  note: string | null;
  author: string | null; // null = client / system
  author_id: string | null;
  mine: boolean;
  created_at: string;
  edited_at: string | null;
};

type DrawerData = {
  type: string;
  icon: string;
  label: string;
  title: string;
  entity: Record<string, unknown>;
  fields: FieldMeta[];
  optionsData: { clients: { id: string; name: string }[]; shows: { id: string; name: string }[] };
  stages: Stage[] | null;
  linked: Record<string, unknown>[] | null;
  milestones: Record<string, unknown>[] | null;
  history: HistoryEntry[] | null;
  canEditStages: boolean; // gates the production status controls (touch path)
  review: {
    episode_approved: boolean; reels_approved: boolean; reels_required: boolean;
    episode_note: string | null; reels_note: string | null;
  } | null;
  // per-deliverable media links + review state (0057 / stage 1b) — null/empty
  // until the items model reaches this production (seeded at link mint or
  // first drawer save)
  reviewItems: { id: string; kind: string; reel_index: number | null; media_link: string | null; approved: boolean; last_note: string | null }[] | null;
  // links still live for this production (Q7) — not superseded, unanswered,
  // unexpired. Scope-aware supersession means there can be two (episode +
  // reels), so pressing send may burn one, both, or none.
  // audio_link + transcript METADATA ride along (0076); the transcript's text
  // never does — it is fetched by "הצג" from the route that owns it
  reviewLinks:
    | {
        id: string;
        url: string;
        scope: string;
        created_at: string;
        audio_link?: string | null;
        transcript?: { source: string; char_count: number | null } | null;
      }[]
    | null;
  reelsSummary: { count: number } | null;
  // 0067 / F6 — how this show is priced and how long the session ran. Two
  // stage-tier facts, never a rate and never an amount: the technician is asked
  // for hours, the server does the arithmetic.
  hourly: { pricing_model: string; studio_hours: number | null } | null;
  log: LogEntry[] | null;
  diskOptions: string[] | null;
};

const DrawerContext = createContext<{ openEntity: (ref: EntityRef) => void }>({
  openEntity: () => {},
});

export function useDrawer() {
  return useContext(DrawerContext);
}

const NIS = new Intl.NumberFormat("he-IL");
const STEP_LABEL: Record<string, string> = { record: "הקלטה", edit: "עריכה", deliver: "מסירה" };
const STATUS_NEXT: Record<string, string> = { pending: "in_progress", in_progress: "done", done: "pending" };

const STEP_ORDER: Record<string, number> = { record: 0, edit: 1, deliver: 2 };


// ═══ "חומרים נוספים" — transcript + separate audio file (0076) ═══
//
// Lives in the EPISODE block only, and that is a decision rather than an
// omission: client_review_transcripts is keyed by link_id with ONE row per
// link (0076), so a scope='all' round has exactly one transcript. Offering the
// action in both blocks would mean the reels editor silently overwrote the
// episode's. Both actions are about the episode anyway — "הוסף תמלול לפרק",
// and a separate audio file is the episode's audio-only cut.
//
// THE TEXT IS NOT RENDERED until asked for. An hour of speech in a drawer is
// exactly what the separate table exists to avoid, so the row shows source and
// length; "הצג" fetches the body.
export type MaterialsState = {
  transcript: { source: string; char_count: number | null } | null;
  audioLink: string | null;
  // no live round exists to attach materials to — the actions do not open
  noRound: boolean;
  canEdit: boolean;
  busy: boolean;
  onSaveTranscript: (v: { content: string; source: "pasted" | "link" } | null) => void;
  onSaveAudio: (v: string | null) => void;
  onLoadBody: () => Promise<string | null>;
};

function ReviewMaterials({ state }: { state: MaterialsState }) {
  const { transcript, audioLink, noRound, canEdit, busy } = state;
  // the editingBase pattern (AddonsSection:2029): a dormant control, one piece
  // of state, and the input appears with autoFocus in the same row
  const [editing, setEditing] = useState<"transcript" | "audio" | null>(null);
  const [draft, setDraft] = useState("");
  const [source, setSource] = useState<"pasted" | "link">("pasted");
  const [body, setBody] = useState<string | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const ROW = "flex items-center gap-1.5 text-[11px]";
  const GHOST =
    "text-[11px] text-[var(--faint)] hover:text-[var(--violet-light)] transition-colors";
  const INPUT =
    "w-full text-[11px] bg-[var(--panel)] border border-[var(--rule)] rounded-lg px-2.5 py-1.5 outline-none focus:border-[var(--violet-light)]";

  if (!canEdit && !transcript && !audioLink) return null;

  // No round, no actions — and it says why rather than showing a control that
  // fails on click. There is no draft to fall back on ON PURPOSE: see the
  // parent. noRound also implies both values are null, since both are read off
  // the live round.
  if (noRound) {
    return canEdit ? (
      <div className="pt-1.5 mt-1.5 border-t border-[var(--rule)] text-[10px] text-[var(--faint)]">
        כדי להוסיף תמלול או אודיו, שלח קודם לינק אישור ללקוח.
      </div>
    ) : null;
  }

  return (
    <div className="space-y-1 pt-1.5 mt-1.5 border-t border-[var(--rule)]">
      {/* ---- transcript ---- */}
      {editing === "transcript" ? (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            {(["pasted", "link"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSource(s)}
                className={`text-[10px] rounded-full px-2 py-0.5 border transition-colors ${
                  source === s
                    ? "border-[var(--violet-light)] text-[var(--violet-light)]"
                    : "border-[var(--rule)] text-[var(--faint)]"
                }`}
              >
                {s === "pasted" ? "הדבק טקסט" : "קישור למסמך"}
              </button>
            ))}
            <div className="flex-1" />
            <button onClick={() => setEditing(null)} className="text-[var(--faint)] px-1">
              ✕
            </button>
          </div>
          {source === "pasted" ? (
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="הדבק כאן את התמלול"
              rows={5}
              className={`${INPUT} resize-y`}
            />
          ) : (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="https://…"
              dir="ltr"
              className={`${INPUT} text-right`}
            />
          )}
          <div className="flex items-center gap-1.5">
            {source === "pasted" && draft.trim() && (
              <span className="text-[9px] text-[var(--faint)]">
                {draft.trim().length.toLocaleString("he-IL")} תווים
              </span>
            )}
            <div className="flex-1" />
            <button
              disabled={busy || !draft.trim()}
              onClick={() => {
                state.onSaveTranscript({ content: draft.trim(), source });
                setEditing(null);
                setBody(null);
              }}
              className="border border-[var(--rule)] rounded px-2 py-1 text-[11px] text-[var(--dim)] hover:bg-[var(--panel3)] disabled:opacity-40"
            >
              שמור
            </button>
          </div>
        </div>
      ) : transcript ? (
        <div className="space-y-1">
          <div className={ROW}>
            <span className="text-[var(--dim)] flex-1 truncate">
              📄 תמלול
              {transcript.source === "link" ? (
                <span className="text-[var(--faint)]"> · קישור למסמך</span>
              ) : (
                <span className="text-[var(--faint)]">
                  {" · "}
                  {(transcript.char_count ?? 0).toLocaleString("he-IL")} תווים · הודבק
                </span>
              )}
            </span>
              {/* no "הצג" on a link row: there is no body to unfold, the content
                IS the URL and char_count is NULL there by design (0076) */}
            {transcript.source !== "link" && (
              <button
                className={GHOST}
                disabled={loadingBody}
                onClick={async () => {
                  if (body !== null) return setBody(null);
                  setLoadingBody(true);
                  setBody((await state.onLoadBody()) ?? "");
                  setLoadingBody(false);
                }}
              >
                {loadingBody ? "טוען…" : body !== null ? "הסתר" : "הצג"}
              </button>
            )}
            {canEdit && (
              <button
                className={GHOST}
                onClick={async () => {
                  setSource(transcript.source === "link" ? "link" : "pasted");
                  setDraft(transcript.source === "link" ? "" : ((await state.onLoadBody()) ?? ""));
                  setEditing("transcript");
                }}
              >
                ערוך
              </button>
            )}
            {canEdit && (
              <button className={GHOST} onClick={() => setConfirmDelete(true)}>
                ✕
              </button>
            )}
          </div>
          {/* deleting an hour of work is not symmetric with clearing a URL */}
          {confirmDelete && (
            <div className="rounded-lg px-2 py-1.5 text-[10px] flex items-center gap-1.5" style={{ background: "rgba(244,63,94,0.08)", border: "1px solid rgba(244,63,94,0.35)" }}>
              <span className="flex-1 text-rose-300">למחוק את התמלול?</span>
              <button
                className="text-rose-300 hover:underline"
                onClick={() => {
                  state.onSaveTranscript(null);
                  setConfirmDelete(false);
                  setBody(null);
                }}
              >
                מחק
              </button>
              <button className="text-[var(--faint)]" onClick={() => setConfirmDelete(false)}>
                ביטול
              </button>
            </div>
          )}
          {body !== null && (
            <div
              className="text-[10px] text-[var(--dim)] whitespace-pre-wrap rounded-lg px-2 py-1.5 overflow-y-auto"
              style={{ maxHeight: 160, background: "var(--panel)", border: "1px solid var(--rule)" }}
            >
              {body || "—"}
            </div>
          )}
        </div>
      ) : canEdit ? (
        <button
          className={GHOST}
          onClick={() => {
            setDraft("");
            setSource("pasted");
            setEditing("transcript");
          }}
        >
          ＋ הוסף תמלול לפרק
        </button>
      ) : null}

      {/* ---- separate audio file ---- */}
      {editing === "audio" ? (
        <div className={ROW}>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="https://… קישור לקובץ האודיו"
            dir="ltr"
            className={`${INPUT} text-right`}
          />
          <button
            disabled={busy}
            onClick={() => {
              state.onSaveAudio(draft.trim() || null);
              setEditing(null);
            }}
            className="border border-[var(--rule)] rounded px-2 py-1 text-[var(--dim)] hover:bg-[var(--panel3)] disabled:opacity-40 shrink-0"
          >
            שמור
          </button>
          <button onClick={() => setEditing(null)} className="text-[var(--faint)] px-1">
            ✕
          </button>
        </div>
      ) : audioLink ? (
        <div className={ROW}>
          <span className="text-[var(--dim)] flex-1 truncate" dir="ltr">
            🎧 {audioLink.replace(/^https?:\/\//, "")}
          </span>
          {canEdit && (
            <button
              className={GHOST}
              onClick={() => {
                setDraft(audioLink);
                setEditing("audio");
              }}
            >
              ערוך
            </button>
          )}
          {canEdit && (
            <button className={GHOST} onClick={() => state.onSaveAudio(null)}>
              ✕
            </button>
          )}
        </div>
      ) : canEdit ? (
        <button
          className={GHOST}
          onClick={() => {
            setDraft("");
            setEditing("audio");
          }}
        >
          ＋ הוסף קובץ אודיו נפרד
        </button>
      ) : null}
    </div>
  );
}

// One workflow line (episode or reels) — its own stage steps, its own client
// review state. The client's correction text renders INSIDE the block (owner
// 2026-07-22) so a tech opening the reels line sees "the client asked: …"
// without hunting. Stage steps advance on tap (record→edit→deliver→back).
function ProductionTrackBlock({
  icon, title, stages, note, approved, canEdit, onAdvance, tally, onSend, saving, sending, sent,
  mediaUrl, onMediaChange, onMediaBlur, mediaFields, liveLinks = [], materials,
}: {
  icon: string;
  title: string;
  stages: Stage[];
  note: string | null;
  approved: boolean;
  canEdit: boolean;
  onAdvance: (s: Stage) => void;
  tally?: string | null;
  onSend?: (mediaUrl: string | null) => void;
  saving?: boolean;
  sending?: boolean;
  sent?: { url: string; whatsapp: string } | null;
  // the media URL is lifted to the parent so a unified send can read both
  // blocks' links at once without the tech re-entering them (owner 2026-07-24)
  mediaUrl: string;
  onMediaChange: (v: string) => void;
  // persist-on-blur for the single input (0057 — saved to the review item)
  onMediaBlur?: () => void;
  // one labelled input per deliverable (reel 1..n, 0057); replaces the single
  // input when provided — the reels block passes these. `status` (stage 1b)
  // shows what the client said about THIS deliverable: approved / pending /
  // its last correction note.
  mediaFields?: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    onBlur: () => void;
    status?: { approved: boolean; note: string | null } | null;
  }[];
  // live links THIS button would supersede (Q7) — drives the warning line
  // only; the links themselves are listed once, above the whole send area
  liveLinks?: { id: string; url: string; scope: string; created_at: string }[];
  // 0076 — owned by the parent for the same reason mediaUrl is: the unified
  // send has to see them without the tech re-entering anything. Episode block
  // only; see ReviewMaterials.
  materials?: MaterialsState;
}) {
  const ordered = [...stages].sort((a, b) => (STEP_ORDER[a.step] ?? 9) - (STEP_ORDER[b.step] ?? 9));
  // TWO different measurements live in this block, and until 2026-08-03 both
  // said "ממתין" — so they read as one contradicting itself (owner). They are
  // both right and they measure different axes:
  //   • the badge = the CLIENT's approval of this deliverable
  //   • the tally = how far the WORK has gone, straight off the stage rows
  // Everything below keeps them apart: the badge is prefixed "לקוח:", wears a
  // dashed square instead of a pill, and sits on its own row under the steps —
  // shape and position, not just colour, so they can't be confused at a glance.
  const badge = approved
    ? { text: "לקוח: אושר ✓", cls: "border-emerald-500/50 text-emerald-400" }
    : note
      ? { text: "לקוח: ביקש תיקונים", cls: "border-rose-500/50 text-rose-400" }
      : { text: "לקוח: ממתין לאישור", cls: "border-[var(--rule)] text-[var(--faint)]" };
  // Read off the rows already loaded — no extra request. A track with no stage
  // rows at all renders NO tally: "0/0" on the 708 legacy productions that
  // never had stages would be noise on every one of them (owner 2026-08-03).
  const doneCount = stages.filter((s) => s.status === "done").length;
  const stageTally = stages.length > 0 ? `שלבים ${doneCount}/${stages.length}` : null;
  return (
    <div className="rounded-xl border border-[var(--rule)] p-3" style={{ background: "rgba(255,255,255,0.02)" }}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-sm font-bold flex items-center gap-1.5">
          <span>{icon}</span>
          {title}
        </span>
        {stageTally && (
          <span
            className={`text-[11px] font-mono shrink-0 ${
              doneCount === stages.length ? "text-emerald-400" : "text-[var(--dim)]"
            }`}
          >
            {stageTally}
          </span>
        )}
      </div>
      {tally && <div className="text-[11px] text-[var(--dim)] mb-2">{tally}</div>}
      <div className="flex items-center gap-1.5 mb-2">
        {ordered.map((s) => (
          <button
            key={s.id}
            onClick={() => { if (canEdit && !saving) onAdvance(s); }}
            disabled={!canEdit || saving}
            title="לחיצה מקדמת שלב"
            className={`flex-1 text-[11px] rounded-lg px-2 py-1.5 border text-center transition-colors disabled:cursor-default ${
              s.status === "done"
                ? "border-emerald-500/50 text-emerald-400"
                : s.status === "in_progress"
                  ? "border-amber-500/50 text-amber-400"
                  : "border-[var(--rule)] text-[var(--dim)] enabled:hover:border-[var(--violet-light)]"
            }`}
          >
            {STEP_LABEL[s.step]}
          </button>
        ))}
      </div>
      {/* the client-approval axis, on its own row and in its own shape */}
      <div className="flex justify-end mb-2">
        <span className={`text-[10px] px-2 py-0.5 rounded-md border border-dashed ${badge.cls}`}>{badge.text}</span>
      </div>
      {note && (
        <div className="rounded-lg border border-rose-500/40 px-2.5 py-2 mb-2" style={{ background: "rgba(251,113,133,0.10)" }}>
          <div className="text-[10px] font-bold text-rose-400 mb-0.5">💬 הלקוח ביקש</div>
          <div className="text-xs">{note}</div>
        </div>
      )}
      {onSend && canEdit && !approved && (
        <div className="space-y-1.5">
          {!sent && mediaFields && (
            <div className="space-y-1">
              {mediaFields.map((f) => (
                <div key={f.label}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-[var(--dim)] shrink-0 w-9 text-right">{f.label}</span>
                    <input
                      value={f.value}
                      onChange={(e) => f.onChange(e.target.value)}
                      onBlur={f.onBlur}
                      placeholder="קישור דרייב לצפייה — אופציונלי"
                      dir="ltr"
                      className="w-full text-[11px] bg-[var(--panel)] border border-[var(--rule)] rounded-lg px-2.5 py-1.5 text-right outline-none focus:border-[var(--violet-light)]"
                    />
                    {f.status && (
                      <span
                        className={`text-[10px] shrink-0 ${f.status.approved ? "text-emerald-400" : f.status.note ? "text-rose-400" : "text-[var(--faint)]"}`}
                      >
                        {f.status.approved ? "✓ אושר" : f.status.note ? "✎ תיקונים" : "ממתין"}
                      </span>
                    )}
                  </div>
                  {f.status && !f.status.approved && f.status.note && (
                    <div className="mr-10 mt-0.5 text-[10px] text-rose-400">💬 {f.status.note}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          {!sent && !mediaFields && (
            <input
              value={mediaUrl}
              onChange={(e) => onMediaChange(e.target.value)}
              onBlur={onMediaBlur}
              placeholder="קישור לצפייה (פרק/רילז) — אופציונלי"
              dir="ltr"
              className="w-full text-[11px] bg-[var(--panel)] border border-[var(--rule)] rounded-lg px-2.5 py-1.5 text-right outline-none focus:border-[var(--violet-light)]"
            />
          )}
          {materials && <ReviewMaterials state={materials} />}
          <button
            onClick={() => onSend(mediaUrl.trim() || null)}
            disabled={!!sending}
            className="w-full text-[11px] rounded-lg py-1.5 border border-[var(--rule)] text-[var(--dim)] enabled:hover:border-[var(--violet-light)] enabled:hover:text-[var(--violet-light)] disabled:opacity-50 transition-colors"
          >
            <span className="block">
              {sending ? "יוצר קישור…" : liveLinks.length ? "צור לינק חדש →" : "שלח לאישור לקוח →"}
            </span>
            {!sending && liveLinks.length > 0 && (
              <span className="block text-[9px] text-rose-400/70">ידרוס את הלינק החי</span>
            )}
          </button>
          {sent && (
            <div className="rounded-lg px-2.5 py-2 text-[11px]" style={{ background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.35)" }}>
              <div className="text-[var(--dim)] mb-1 break-all">{sent.url}</div>
              <div className="flex items-center gap-3">
                <button onClick={() => navigator.clipboard?.writeText(sent.url)} className="text-[var(--violet-light)] hover:underline">העתק קישור</button>
                {sent.whatsapp && (
                  <a href={sent.whatsapp} target="_blank" rel="noreferrer" className="text-[var(--violet-light)] hover:underline">שלח בוואטסאפ ↗</a>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const TRACK_LABEL: Record<string, string> = { episode: "פרק", reels: "רילז" };

// ── live review links (Q7) ──
const SCOPE_LABEL: Record<string, string> = { episode: "פרק", reels: "רילז", all: "פרק + רילז" };

/** does a link with this scope cover the track a send button is about? */
function scopeCovers(linkScope: string, track: "episode" | "reels" | "all"): boolean {
  if (track === "all") return true; // a unified send supersedes every live link
  return linkScope === "all" || linkScope === track;
}

/** "לפני 3 שעות" — the tech needs recency at a glance, not a timestamp */
function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "עכשיו";
  if (mins < 60) return `לפני ${mins} דק׳`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `לפני ${hours} שע׳`;
  const days = Math.round(hours / 24);
  return days === 1 ? "אתמול" : `לפני ${days} ימים`;
}

/** the exact moment behind relativeTime's "לפני 3 שעות" — shown as a tooltip */
function fullTime(iso: string): string {
  return displayDateTime(iso) ?? "—";
}

/** the existing live links, with copy — so nobody re-sends just to get the URL */
function LiveLinksBox({ links }: { links: { id: string; url: string; scope: string; created_at: string }[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (!links.length) return null;
  return (
    <div className="rounded-lg px-2.5 py-2 space-y-2" style={{ background: "rgba(74,222,128,0.07)", border: "1px solid rgba(74,222,128,0.3)" }}>
      <div className="text-[10px] font-bold text-emerald-400">🔗 לינק חי אצל הלקוח</div>
      {links.map((l) => (
        <div key={l.id} className="space-y-0.5">
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-[var(--dim)]">{SCOPE_LABEL[l.scope] ?? l.scope}</span>
            <span className="text-[var(--faint)]" title={fullTime(l.created_at)}>· נוצר {relativeTime(l.created_at)}</span>
          </div>
          <div className="text-[10px] text-[var(--dim)] break-all" dir="ltr">{l.url}</div>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(l.url);
              setCopied(l.id);
              setTimeout(() => setCopied(null), 1500);
            }}
            className="text-[10px] text-emerald-400 hover:underline"
          >
            {copied === l.id ? "הועתק ✓" : "העתק קישור קיים"}
          </button>
        </div>
      ))}
    </div>
  );
}

// icon per log kind. Unknown kind → a neutral default, never a crash (owner
// 2026-07-24: kinds will grow — price decision, approved add-on, issued doc).
function logIcon(e: LogEntry): string {
  if (e.kind === "disk") return "💾";
  if (e.kind === "note") return "📝";
  if (e.kind === "client") return "💬";
  if (e.kind === "ack") return "🤝";
  if (e.kind === "stage") {
    if (e.stage_status === "done") return "✓";
    if (e.stage_status === "in_progress") return "▶";
    return "↩"; // reverted to pending
  }
  return "•"; // unknown/future kind
}

// the human line for an entry (what happened), independent of its note body
function logHead(e: LogEntry): string {
  const where = e.track ? `${TRACK_LABEL[e.track] ?? e.track}${e.step ? "·" + STEP_LABEL[e.step] : ""}` : "";
  if (e.kind === "disk") return `דיסק: ${e.note ?? "—"}`;
  if (e.kind === "client") return `${where ? where + " · " : ""}הערת לקוח`;
  // written with note: null (review-ack route), so the head IS the entry
  if (e.kind === "ack") return "הטכנאי קיבל את ההערות ומטפל";
  if (e.kind === "stage") {
    const verb = e.stage_status === "done" ? "הושלם" : e.stage_status === "in_progress" ? "התחיל" : "הוחזר";
    return `${where} ${verb}`;
  }
  return where; // note: header is the track/step it was attached to (may be empty)
}



const FIVE_MIN = 5 * 60 * 1000;

// "יומן ההפקה" — the full chronological story (§3): stage changes, disk
// changes, tech notes, client notes. Newest first. Author may edit their OWN
// note within 5 minutes (marked "נערך"); nothing is ever deleted.
function JournalSection({
  log, canEdit, onAddNote, onEditNote,
}: {
  log: LogEntry[];
  canEdit: boolean;
  onAddNote: (note: string) => Promise<void>;
  onEditNote: (id: string, note: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  async function submitNew() {
    const n = draft.trim();
    if (!n || busy) return;
    setBusy(true);
    await onAddNote(n);
    setBusy(false);
    setDraft("");
    setAdding(false);
  }
  async function submitEdit() {
    const n = editDraft.trim();
    if (!n || busy || !editId) return;
    setBusy(true);
    await onEditNote(editId, n);
    setBusy(false);
    setEditId(null);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-xs font-bold text-[var(--dim)]">יומן ההפקה</div>
        {canEdit && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="text-[11px] text-[var(--dim)] border border-[var(--rule)] rounded-lg px-2 py-0.5 hover:border-[var(--violet-light)] hover:text-[var(--violet-light)] transition-colors"
          >
            + הערה
          </button>
        )}
      </div>

      {adding && (
        <div className="mb-2 space-y-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            rows={2}
            placeholder="הערה חופשית…"
            className="w-full text-xs bg-[var(--panel)] border border-[var(--rule)] rounded-lg px-2.5 py-1.5 text-right outline-none focus:border-[var(--violet-light)] resize-none"
          />
          <div className="flex gap-2">
            <button onClick={() => void submitNew()} disabled={busy || !draft.trim()} className="text-[11px] rounded-lg px-3 py-1 border border-[var(--violet-light)] text-[var(--violet-light)] disabled:opacity-40">שמור</button>
            <button onClick={() => { setAdding(false); setDraft(""); }} className="text-[11px] rounded-lg px-3 py-1 border border-[var(--rule)] text-[var(--dim)]">בטל</button>
          </div>
        </div>
      )}

      {log.length === 0 ? (
        <div className="text-[11px] text-[var(--faint)]">אין עדיין רישומים.</div>
      ) : (
        <div className="space-y-1.5">
          {log.map((e) => {
            const editable = canEdit && e.mine && e.kind === "note"
              && Date.now() - new Date(e.created_at).getTime() < FIVE_MIN;
            return (
              <div key={e.id} className="flex gap-2 text-xs">
                <span className="shrink-0 w-4 text-center text-[var(--dim)]">{logIcon(e)}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] text-[var(--faint)]">
                    {displayLogTime(e.created_at) ?? "—"}
                    {e.author ? ` · ${e.author}` : e.kind === "client" ? " · לקוח" : ""}
                    {logHead(e) ? ` · ${logHead(e)}` : ""}
                    {e.edited_at && <span className="italic"> · נערך</span>}
                  </div>
                  {editId === e.id ? (
                    <div className="mt-1 space-y-1.5">
                      <textarea
                        value={editDraft}
                        onChange={(ev) => setEditDraft(ev.target.value)}
                        autoFocus
                        rows={2}
                        className="w-full text-xs bg-[var(--panel)] border border-[var(--rule)] rounded-lg px-2.5 py-1.5 text-right outline-none focus:border-[var(--violet-light)] resize-none"
                      />
                      <div className="flex gap-2">
                        <button onClick={() => void submitEdit()} disabled={busy} className="text-[11px] rounded-lg px-3 py-1 border border-[var(--violet-light)] text-[var(--violet-light)] disabled:opacity-40">שמור</button>
                        <button onClick={() => setEditId(null)} className="text-[11px] rounded-lg px-3 py-1 border border-[var(--rule)] text-[var(--dim)]">בטל</button>
                      </div>
                    </div>
                  ) : (
                    e.note && e.kind !== "disk" && (
                      <div className={`mt-0.5 ${e.kind === "client" ? "rounded-lg border border-rose-500/30 px-2 py-1" : ""}`} style={e.kind === "client" ? { background: "rgba(251,113,133,0.08)" } : undefined}>
                        {e.note}
                        {editable && (
                          <button onClick={() => { setEditId(e.id); setEditDraft(e.note ?? ""); }} className="ms-2 text-[10px] text-[var(--faint)] hover:text-[var(--violet-light)]">ערוך</button>
                        )}
                      </div>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function DrawerProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ref, setRef] = useState<EntityRef | null>(null);
  const [data, setData] = useState<DrawerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // freezing a production from the drawer — capture a reason like the board
  const [freezeAsk, setFreezeAsk] = useState(false);
  const [freezeReason, setFreezeReason] = useState("");
  const [savingStatus, setSavingStatus] = useState(false);
  const [excOpen, setExcOpen] = useState(false); // "exceptional actions" disclosure on the status cursor
  const [reviewSending, setReviewSending] = useState<string | null>(null); // scope currently being sent
  // the client's notes from the last answered round, + the "קיבלתי" step (0071)
  const [showClientNotes, setShowClientNotes] = useState(false);
  // scope — where the sent-box renders (per-track block, or "all" = under the
  // unified button); sentScope — what the unified send ACTUALLY minted, for the
  // success label (the unified button downgrades to a single track when only
  // one media link is filled)
  const [reviewSent, setReviewSent] = useState<{ scope: string; sentScope?: "episode" | "reels" | "all"; url: string; whatsapp: string } | null>(null);
  // media URLs lifted out of the two track blocks so the unified send can take
  // both at once (owner 2026-07-24)
  const [episodeMedia, setEpisodeMedia] = useState("");
  // one Drive link per reel, keyed by reel_index (0057). Initialised from the
  // saved items once per opened production; typed edits persist on blur.
  const [reelMedia, setReelMedia] = useState<Record<number, string>>({});
  const mediaInitFor = useRef<string | null>(null);
  // 0076 materials. There is NO draft model, deliberately (owner 2026-09-10):
  // materials belong to a round, and a round that does not exist cannot carry
  // them. Holding them client-side instead would be a draft on ONE BROWSER —
  // paste a transcript in the studio, open the drawer at home, and it is gone
  // with nobody having said so. That is the same silent loss this feature is
  // meant to avoid, only postponed by a week. So: no live round, no action.
  const [matBusy, setMatBusy] = useState(false);
  const [matPicker, setMatPicker] = useState<
    { links: { id: string; scope: string }[]; retry: (linkId: string) => void } | null
  >(null);
  // a client-name edit that Morning must be told about, awaiting confirmation
  const [morningConfirm, setMorningConfirm] = useState<
    { key: string; value: unknown; prev: unknown; changes: Record<string, { from: unknown; to: unknown }> } | null
  >(null);
  // §2 disk modal (opens on record-start, or by tapping the disk tag)
  const [diskModal, setDiskModal] = useState(false);
  const [diskValue, setDiskValue] = useState("");
  const [diskSaving, setDiskSaving] = useState(false);
  // §3 note-on-stage-complete modal.
  //
  // `stage: null` is F6: the same modal opened straight from the missing-hours
  // flag, with no stage just completed. One modal rather than two because on an
  // hourly show they ARE the same moment — "you finished recording" and "how
  // long did it run" — and a second dialog for the same answer is a second
  // place for it to be skipped.
  const [noteModal, setNoteModal] = useState<{ stage: Stage | null } | null>(null);
  const [noteValue, setNoteValue] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  // F6 — the studio hours typed into that modal (string, so a half-typed "3."
  // is not silently a 3). Its own error line: this field posts to its own
  // route, and a failure here must not read as "the note failed".
  const [hoursValue, setHoursValue] = useState("");
  const [hoursError, setHoursError] = useState<string | null>(null);
  // dirty text/number edits awaiting blur/Cmd+Enter
  const dirty = useRef<Record<string, unknown>>({});

  const openEntity = useCallback((next: EntityRef) => {
    dirty.current = {};
    setError(null);
    setReviewSent(null);
    setExcOpen(false);
    setDiskModal(false);
    setNoteModal(null);
    setEpisodeMedia("");
    setReelMedia({});
    setMatPicker(null);
    mediaInitFor.current = null;
    setRef(next);
  }, []);

  const close = useCallback(() => {
    setRef(null);
    setData(null);
    setError(null);
    setDiskModal(false);
    setNoteModal(null);
    dirty.current = {};
  }, []);

  const load = useCallback(async (r: EntityRef, quiet = false) => {
    if (!quiet) setLoading(true);
    const res = await fetch(`/api/entity/${r.type}/${r.id}`);
    setLoading(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "שגיאה בטעינה");
      setData(null);
      return;
    }
    setData(await res.json());
  }, []);

  useEffect(() => {
    if (ref) void load(ref);
  }, [ref, load]);

  // fill the media fields from the saved items ONCE per opened production —
  // quiet reloads after actions must not clobber links mid-typing
  useEffect(() => {
    if (!ref || !data || data.type !== "production") return;
    if (mediaInitFor.current === ref.id) return;
    mediaInitFor.current = ref.id;
    const items = data.reviewItems ?? [];
    const ep = items.find((i) => i.kind === "episode");
    if (ep?.media_link) setEpisodeMedia(ep.media_link);
    const map: Record<number, string> = {};
    for (const it of items) {
      if (it.kind === "reel" && it.reel_index && it.media_link) map[it.reel_index] = it.media_link;
    }
    if (Object.keys(map).length) setReelMedia(map);
  }, [ref, data]);

  // 0076 — save transcript / audio onto the live round, or park them.
  //
  // `undefined` vs `null` is the same contract the route enforces: a key that
  // is absent means "leave alone", a key set to null means "clear". Never
  // collapse the two here or "I changed the audio" deletes the transcript.
  async function saveMaterials(
    patch: {
      transcript?: { content: string; source: "pasted" | "link" } | null;
      audio_link?: string | null;
    },
    linkId?: string
  ): Promise<boolean> {
    if (!ref) return false;
    setMatBusy(true);
    setError(null);
    const res = await fetch(`/api/productions/${ref.id}/review-materials`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...patch, ...(linkId ? { link_id: linkId } : {}) }),
    });
    setMatBusy(false);
    const b = await res.json().catch(() => ({}));
    if (res.status === 409 && Array.isArray(b.links) && b.links.length > 1) {
      // the route refuses to pick between two live rounds; the UI turns that
      // refusal into the choice itself rather than an error to read and retry
      setMatPicker({ links: b.links, retry: (id: string) => void saveMaterials(patch, id) });
      return false;
    }
    if (!res.ok) {
      setError(b.error ?? "שמירת החומרים נכשלה");
      return false;
    }
    setMatPicker(null);
    void load(ref, true);
    return true;
  }

  // persist one item's media link (0057) — display metadata only, so a
  // failure surfaces as the drawer's regular error line and nothing else
  async function saveItemLink(kind: "episode" | "reel", reelIndex: number | null, value: string) {
    if (!ref) return;
    const res = await fetch(`/api/productions/${ref.id}/review-items`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ kind, reel_index: reelIndex, media_link: value.trim() || null }] }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "שמירת קישור הצפייה נכשלה");
    }
  }

  // the first filled reel link, by index — feeds the unified send and the
  // per-track reels send exactly where the single reels field used to
  function firstReelLink(): string | null {
    const keys = Object.keys(reelMedia).map(Number).sort((a, b) => a - b);
    for (const k of keys) {
      const v = (reelMedia[k] ?? "").trim();
      if (v) return v;
    }
    return null;
  }

  function broadcast() {
    if (ref) window.dispatchEvent(new CustomEvent("bizi:entity-updated", { detail: ref }));
    router.refresh();
  }

  async function post(
    body: Record<string, unknown>
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    if (!ref) return { ok: false, status: 0, body: {} };
    setError(null);
    const res = await fetch(`/api/entity/${ref.type}/${ref.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const resBody = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) setError(resBody.error ?? "שגיאה בשמירה");
    return { ok: res.ok, status: res.status, body: resBody };
  }

  async function saveField(key: string, value: unknown, undoOf?: string) {
    if (!ref || !data) return;
    const prev = data.entity[key];
    if (prev === value) return;

    // Freezing a production is not a bare boolean — it captures reason/who/when
    // exactly like the board (backlog 2026-07-21). Route the on_hold toggle
    // through /api/productions/[id]: turning ON asks for a reason first;
    // turning OFF releases immediately. Never patch on_hold directly.
    if (ref.type === "production" && key === "on_hold") {
      if (value === true) {
        setFreezeAsk(true);
      } else {
        await productionHold(false);
      }
      return;
    }

    // optimistic: paint first, revert on failure
    setData((d) => (d ? { ...d, entity: { ...d.entity, [key]: value } } : d));
    const res = await post({ patch: { [key]: value }, ...(undoOf ? { undoOf } : {}) });
    // a mapped client's name change needs an explicit "also update Morning?"
    // — revert the optimistic paint and hold it for the confirmation modal
    if (res.status === 409 && res.body?.needs_morning_confirmation) {
      setData((d) => (d ? { ...d, entity: { ...d.entity, [key]: prev } } : d));
      setMorningConfirm({ key, value, prev, changes: res.body.changes as Record<string, { from: unknown; to: unknown }> });
      return;
    }
    if (!res.ok) {
      setData((d) => (d ? { ...d, entity: { ...d.entity, [key]: prev } } : d));
      return;
    }
    broadcast();
    void load(ref, true); // refresh history + derived fields
  }

  async function confirmMorning() {
    if (!ref || !morningConfirm) return;
    const { key, value, prev } = morningConfirm;
    setData((d) => (d ? { ...d, entity: { ...d.entity, [key]: value } } : d));
    const res = await post({ patch: { [key]: value }, confirm_morning: true });
    setMorningConfirm(null);
    if (!res.ok) {
      setData((d) => (d ? { ...d, entity: { ...d.entity, [key]: prev } } : d));
      return;
    }
    broadcast();
    void load(ref, true);
  }

  // the rich freeze flow, shared with the board — records reason/who/when
  async function productionHold(on: boolean, reason?: string) {
    if (!ref) return;
    setError(null);
    const res = await fetch(`/api/productions/${ref.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hold: { on, reason } }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "עדכון ההקפאה נכשל");
      return;
    }
    setFreezeAsk(false);
    broadcast();
    void load(ref, true);
  }

  async function saveStage(stage: Stage, patch: Record<string, unknown>): Promise<boolean> {
    if (!ref) return false;
    const res = await post({ stage: { id: stage.id, patch } });
    if (res.ok) {
      broadcast();
      void load(ref, true);
    }
    return res.ok;
  }

  // advancing a stage step (§2 + §3 hooks). One tap moves the stage forward;
  // then: turning פרק·הקלטה yellow pops the disk modal, and completing ANY
  // step pops the "add a note?" modal. Both only after the DB change succeeds.
  async function advanceStage(stage: Stage) {
    const next = STATUS_NEXT[stage.status];
    const ok = await saveStage(stage, { status: next });
    if (!ok) return;
    if (next === "in_progress" && stage.track === "episode" && stage.step === "record") {
      setDiskValue(String((data?.entity.storage_disk as string) ?? ""));
      setDiskModal(true);
    } else if (next === "done") {
      setNoteValue("");
      // F6: on an hourly show, finishing פרק·הקלטה is the moment the hours are
      // known and the only moment the technician is standing in front of the
      // question. Seed the field from whatever is already stored so a
      // correction opens on the current number rather than on a blank.
      setHoursValue(String(data?.hourly?.studio_hours ?? ""));
      setHoursError(null);
      setNoteModal({ stage });
    }
  }

  // F6: the same modal, opened from the missing-hours flag rather than by
  // finishing a stage. This is what makes the flag an ACTION and not a notice.
  function askHours() {
    setNoteValue("");
    setHoursValue(String(data?.hourly?.studio_hours ?? ""));
    setHoursError(null);
    // attach to the episode·record stage when there is one, so the optional
    // note lands on the step it is about; a production with no stage rows (the
    // legacy ones) still gets the field, with the note as a free entry
    const rec = (data?.stages ?? []).find((s) => s.track === "episode" && s.step === "record") ?? null;
    setNoteModal({ stage: rec });
  }

  // §2: save the recording disk (logged automatically by the DB trigger).
  // Posts directly (not via saveField) so the modal stays open on failure.
  async function saveDisk() {
    if (!ref || diskSaving) return;
    setDiskSaving(true);
    const res = await post({ patch: { storage_disk: diskValue.trim() || null } });
    setDiskSaving(false);
    if (!res.ok) return; // error already surfaced by post
    setDiskModal(false);
    broadcast();
    void load(ref, true);
  }

  // F6: the studio hours. Its own endpoint, not the entity PATCH, because the
  // number has three destinations — the column, jobs.amount and the work order
  // — and only that route writes all three (see api/productions/[id]/hours).
  // Returns true when the modal may close.
  async function saveHours(): Promise<boolean> {
    if (!ref) return false;
    const bad = validateHours(hoursValue);
    if (bad) { setHoursError(bad); return false; }
    const res = await fetch(`/api/productions/${ref.id}/hours`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hours: Number(hoursValue) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Shown INSIDE the modal, not in the drawer's error strip: the modal is
      // covering the strip, so a failure written there is a failure nobody sees
      // while the form still looks like it saved.
      setHoursError(body.error ?? "שמירת השעות נכשלה");
      return false;
    }
    setHoursError(null);
    broadcast();
    return true;
  }

  // §3: add a note (free, or attached to the just-completed stage)
  async function addLogNote(note: string, stage?: Stage | null) {
    if (!ref) return;
    const res = await fetch(`/api/productions/${ref.id}/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        note,
        stage_id: stage?.id ?? null,
        track: stage?.track ?? null,
        step: stage?.step ?? null,
      }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "שמירת ההערה נכשלה");
      return;
    }
    void load(ref, true);
  }

  async function editLogNote(logId: string, note: string) {
    if (!ref) return;
    const res = await fetch(`/api/productions/${ref.id}/log`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ log_id: logId, note }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "עריכת ההערה נכשלה");
      return;
    }
    void load(ref, true);
  }

  // advance / jump the production's pipeline status — the touch-friendly path
  // the board's drag can't offer on a phone (owner 2026-07-22). Same endpoint
  // and state machine the board uses; the DB trigger enforces can_edit_stages.
  async function changeProductionStatus(status: string) {
    if (!ref || savingStatus) return;
    setSavingStatus(true);
    setError(null);
    const res = await fetch(`/api/productions/${ref.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setSavingStatus(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "שינוי הסטטוס נכשל");
      return;
    }
    broadcast();
    void load(ref, true);
  }

  // per-track "send for client approval" — mints a scoped review link (episode
  // / reels) via the same endpoint the board modal uses and shows the URL to
  // copy or WhatsApp. Media links aren't collected here (quick send); the
  // fuller flow with per-track media URLs stays on the board.
  async function sendReviewLink(scope: "episode" | "reels", mediaUrl: string | null) {
    if (!ref || reviewSending) return;
    setReviewSending(scope);
    setError(null);
    // the media link the client watches goes on the matching track field
    const media = scope === "episode" ? { episode_link: mediaUrl } : { reels_link: mediaUrl };
    const res = await fetch(`/api/productions/${ref.id}/review-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, ...media }),
    });
    setReviewSending(null);
    const b = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(b.error ?? "יצירת הלינק נכשלה");
      return;
    }
    setReviewSent({ scope, url: b.url, whatsapp: b.share?.whatsapp ?? "" });
    broadcast();
    void load(ref, true);
  }

  // one link for BOTH tracks (owner 2026-07-24). Takes whatever media URLs are
  // already typed in the two blocks — no re-entry. scope='all' if both are
  // filled; if only one is, it scopes to that track so the client sees only it.
  async function sendUnifiedReviewLink() {
    if (!ref || reviewSending) return;
    const ep = episodeMedia.trim() || null;
    const re = firstReelLink();
    // pick scope from what's actually filled — a single filled block sends just
    // that one, exactly like its own button would
    const scope: "episode" | "reels" | "all" = ep && re ? "all" : ep ? "episode" : "reels";
    setReviewSending("all");
    setError(null);
    const res = await fetch(`/api/productions/${ref.id}/review-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, episode_link: ep, reels_link: re }),
    });
    setReviewSending(null);
    const b = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(b.error ?? "יצירת הלינק נכשלה");
      return;
    }
    setReviewSent({ scope: "all", sentScope: scope, url: b.url, whatsapp: b.share?.whatsapp ?? "" });
    broadcast();
    void load(ref, true);
  }

  function flushDirty() {
    for (const [k, v] of Object.entries(dirty.current)) void saveField(k, v);
    dirty.current = {};
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!ref) return;
      if (e.key === "Escape") {
        e.preventDefault();
        // A modal closes before the drawer under it — otherwise Escape used to
        // dismiss the drawer and leave the note/disk dialog floating over an
        // empty screen. It is also the unadvertised way out of the hours modal
        // when "דלג" is hidden (see the modal): a way out that nobody is
        // invited to take, backed by the red flag that reappears if they do.
        if (noteModal) { setNoteModal(null); return; }
        if (diskModal) { setDiskModal(false); return; }
        close();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        flushDirty();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, data, noteModal, diskModal]);

  function optionsFor(f: FieldMeta): { value: string; label: string }[] {
    if (f.options === "clients")
      return (data?.optionsData.clients ?? []).map((c) => ({ value: c.id, label: c.name }));
    if (f.options === "shows")
      return (data?.optionsData.shows ?? []).map((s) => ({ value: s.id, label: s.name }));
    return f.options ?? [];
  }

  function renderValue(f: FieldMeta) {
    const v = data?.entity[f.key];
    if (f.type === "readonly")
      return <span className="text-sm">{v == null || v === "" ? "—" : String(v)}</span>;
    if (!f.editable) {
      if (f.type === "select") {
        const opt = optionsFor(f).find((o) => o.value === v);
        return <span className="text-sm">{opt?.label ?? (v == null ? "—" : String(v))}</span>;
      }
      if (f.type === "boolean") return <span className="text-sm">{v ? "כן" : "לא"}</span>;
      return <span className="text-sm">{v == null || v === "" ? "—" : String(v)}</span>;
    }
    switch (f.type) {
      case "boolean":
        return (
          <input
            type="checkbox"
            checked={Boolean(v)}
            onChange={(e) => void saveField(f.key, e.target.checked)}
          />
        );
      case "select":
        if (f.options === "clients") {
          return (
            <ClientCombobox
              clients={data?.optionsData.clients ?? []}
              value={(v as string) ?? null}
              // reaching this editable branch means the server allowed editing
              // this (money) field — so this viewer is a can_edit_money user
              morningCreate
              canEditMoney={f.editable}
              onChange={(clientId) => void saveField(f.key, clientId)}
              onCreated={(c) =>
                setData((d) =>
                  d ? { ...d, optionsData: { ...d.optionsData, clients: [...d.optionsData.clients, c] } } : d
                )
              }
            />
          );
        }
        return (
          <select
            value={(v as string) ?? ""}
            onChange={(e) => void saveField(f.key, e.target.value || null)}
            className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1 text-sm"
          >
            <option value="">—</option>
            {optionsFor(f).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );
      case "date":
        return (
          <input
            type="date"
            value={(v as string) ?? ""}
            onChange={(e) => void saveField(f.key, e.target.value || null)}
            className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1 text-sm"
          />
        );
      default: {
        const isNumber = f.type === "number";
        const display = Array.isArray(v) ? (v as string[]).join(", ") : v == null ? "" : String(v);
        return (
          <input
            type={isNumber ? "number" : "text"}
            defaultValue={display}
            key={`${f.key}:${display}`}
            onChange={(e) => {
              const raw = e.target.value;
              dirty.current[f.key] = Array.isArray(v)
                ? raw.split(",").map((x) => x.trim()).filter(Boolean)
                : isNumber
                  ? raw === "" ? null : Number(raw)
                  : raw === "" ? null : raw;
            }}
            onBlur={() => {
              if (f.key in dirty.current) {
                const val = dirty.current[f.key];
                delete dirty.current[f.key];
                void saveField(f.key, val);
              }
            }}
            className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1 text-sm"
          />
        );
      }
    }
  }

  function renderChanges(h: HistoryEntry) {
    const changes = (h.payload?.changes ?? null) as Record<string, { from: unknown; to: unknown }> | null;
    if (!changes) return <span className="text-[11px] text-[var(--faint)]">{h.event_type}</span>;
    return (
      <div className="space-y-0.5">
        {Object.entries(changes).map(([k, c]) => {
          const field = data?.fields.find((f) => f.key === k);
          return (
            <div key={k} className="flex items-center gap-1.5 text-[11px]">
              <b>{field?.label ?? k}</b>
              <span className="text-[var(--faint)]">{String(c.from ?? "—")}</span>
              <span>←</span>
              <span>{String(c.to ?? "—")}</span>
              {field?.editable && (
                <button
                  onClick={() => void saveField(k, c.from, h.id)}
                  className="text-[10px] border border-[var(--rule)] rounded px-1 hover:bg-[var(--panel3)]"
                >
                  בטל
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <DrawerContext.Provider value={{ openEntity }}>
      {children}

      {showClientNotes && data?.entity && (
        <ClientNotesModal
          productionId={ref!.id}
          showName={(data.entity.podcast_name as string) ?? undefined}
          onClose={() => setShowClientNotes(false)}
          onAcked={() => {
            broadcast();
            void load(ref!, true);
          }}
        />
      )}

      {freezeAsk && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ background: "rgba(3,2,10,0.7)", backdropFilter: "blur(6px)" }}>
          <div
            className="w-full max-w-sm border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl"
            style={{ background: "rgba(15,13,28,0.95)", backdropFilter: "blur(24px)" }}
          >
            <h3 className="font-bold mb-3">הקפאת הפקה</h3>
            <input
              autoFocus
              value={freezeReason}
              onChange={(e) => setFreezeReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && freezeReason.trim()) {
                  void productionHold(true, freezeReason.trim());
                  setFreezeReason("");
                }
              }}
              placeholder="סיבה (למשל: ממתין לחומרים)"
              className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded-xl px-3 py-2 text-sm mb-4"
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  void productionHold(true, freezeReason.trim());
                  setFreezeReason("");
                }}
                disabled={!freezeReason.trim()}
                className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
                style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
              >
                הקפא
              </button>
              <button
                onClick={() => {
                  setFreezeAsk(false);
                  setFreezeReason("");
                }}
                className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)]"
              >
                ביטול
              </button>
            </div>
          </div>
        </div>
      )}

      {morningConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ background: "rgba(3,2,10,0.7)", backdropFilter: "blur(6px)" }}>
          <div
            className="w-full max-w-sm border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl"
            style={{ background: "rgba(15,13,28,0.95)", backdropFilter: "blur(24px)" }}
          >
            <h3 className="font-bold mb-2">השינוי יעודכן גם במורנינג</h3>
            <div className="text-sm mb-3 space-y-1">
              {Object.entries(morningConfirm.changes).map(([k, ch]) => (
                <div key={k}>
                  <span className="text-[var(--faint)]">{k}: </span>
                  <span className="line-through text-[var(--faint)]">{String(ch.from ?? "—")}</span>
                  <span className="mx-1">→</span>
                  <span className="font-bold">{String(ch.to ?? "—")}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-[var(--faint)] mb-4">
              הצלחה → מעודכן בשני המקומות. כישלון → לא מעודכן באף אחד.
            </p>
            <div className="flex gap-2">
              <button
                onClick={confirmMorning}
                className="flex-1 text-white font-bold rounded-xl px-4 py-2 text-sm"
                style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
              >
                אשר ועדכן
              </button>
              <button
                onClick={() => setMorningConfirm(null)}
                className="flex-1 border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)]"
              >
                בטל
              </button>
            </div>
          </div>
        </div>
      )}

      {/* §2 disk modal — "לאיזה דיסק הוקלט הפרק?" with autocomplete from disks
          already entered (prevents "DISK1" vs "disk 1"). */}
      {diskModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: "rgba(3,2,10,0.7)", backdropFilter: "blur(6px)" }}>
          <div className="w-full max-w-sm border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl" style={{ background: "rgba(15,13,28,0.95)", backdropFilter: "blur(24px)" }}>
            <h3 className="font-bold mb-3">💾 לאיזה דיסק הוקלט הפרק?</h3>
            <input
              value={diskValue}
              onChange={(e) => setDiskValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void saveDisk(); }}
              list="disk-options"
              autoFocus
              dir="ltr"
              placeholder="למשל SSD-04"
              className="w-full text-sm font-mono bg-[var(--panel)] border border-[var(--rule)] rounded-lg px-3 py-2 text-left outline-none focus:border-[var(--violet-light)]"
            />
            <datalist id="disk-options">
              {(data?.diskOptions ?? []).map((d) => <option key={d} value={d} />)}
            </datalist>
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => void saveDisk()}
                disabled={diskSaving}
                className="flex-1 text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
              >
                {diskSaving ? "שומר…" : "שמור"}
              </button>
              <button onClick={() => setDiskModal(false)} className="flex-1 border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)]">בטל</button>
            </div>
          </div>
        </div>
      )}

      {/* §3 note-on-complete modal — "סיימת [X]. רוצה להוסיף הערה?" [שמור][דלג].
          The completion itself is already logged by the DB trigger, so "דלג"
          simply closes — the log still records who/when/which step.

          F6 GRAFTS THE STUDIO HOURS ONTO IT. On a per_hour show, finishing
          פרק·הקלטה is the one moment the answer is known and the technician is
          looking at the screen. A separate dialog would be a second thing to
          dismiss; the same dialog, with the hours ABOVE the note and a title
          that asks for them, is one question at the right time.

          WHAT THE TECHNICIAN SEES: hours. Never a rate, never a total. The
          amount is derived on the server (api/productions/[id]/hours), and
          hourly_rate is not even readable by their role (0067's grants).

          "דלג" IS HIDDEN, NOT DISABLED, WHEN THE HOURS ARE MISSING. A greyed
          button still says "skipping is a thing you may do here"; on an hourly
          show it is not, because no work order exists until the number does.
          The sentence that replaces it says exactly what skipping would cost.
          Escape still closes the modal (see the key handler) — that is the
          escape hatch, unadvertised, and the red flag in the drawer catches
          anyone who takes it. */}
      {noteModal && (() => {
        const stage = noteModal.stage;
        // the hours are asked for exactly on episode·record of an hourly show —
        // and on the flag's own opening, which passes that same stage
        const wantsHours =
          data?.hourly?.pricing_model === "per_hour" &&
          (stage === null || (stage.track === "episode" && stage.step === "record"));
        const hoursOk = wantsHours ? validateHours(hoursValue) === null : true;
        const note = noteValue.trim();
        return (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: "rgba(3,2,10,0.7)", backdropFilter: "blur(6px)" }}>
          <div className="w-full max-w-sm border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl" style={{ background: "rgba(15,13,28,0.95)", backdropFilter: "blur(24px)" }}>
            <h3 className="font-bold mb-1">
              {wantsHours
                ? "⏱ כמה שעות אולפן הוקלטו?"
                : stage
                  ? `סיימת ${TRACK_LABEL[stage.track] ?? stage.track}·${STEP_LABEL[stage.step]}`
                  : "הערה להפקה"}
            </h3>
            <p className="text-[11px] text-[var(--faint)] mb-3">
              {wantsHours
                ? "התוכנית מתומחרת לפי שעת אולפן — השעות קובעות את הזמנת העבודה."
                : "רוצה להוסיף הערה?"}
            </p>
            {wantsHours && (
              <div className="mb-3">
                <input
                  type="number"
                  value={hoursValue}
                  onChange={(e) => { setHoursValue(e.target.value); setHoursError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && hoursOk) e.currentTarget.blur(); }}
                  autoFocus
                  step={HOURS_STEP}
                  min={HOURS_STEP}
                  max={MAX_HOURS}
                  inputMode="decimal"
                  placeholder="למשל 3.5"
                  className="w-full text-lg font-mono bg-[var(--panel)] border border-[var(--rule)] rounded-lg px-3 py-2 text-center outline-none focus:border-[var(--violet-light)]"
                />
                <div className="text-[10px] text-[var(--faint)] mt-1">
                  ברבעי שעה — 0.25 = רבע שעה · עד {MAX_HOURS} שעות
                </div>
                {hoursError && <div className="text-[11px] text-rose-400 mt-1">{hoursError}</div>}
              </div>
            )}
            <textarea
              value={noteValue}
              onChange={(e) => setNoteValue(e.target.value)}
              autoFocus={!wantsHours}
              rows={3}
              placeholder="הערה (אופציונלי)…"
              className="w-full text-sm bg-[var(--panel)] border border-[var(--rule)] rounded-lg px-3 py-2 text-right outline-none focus:border-[var(--violet-light)] resize-none"
            />
            <div className="flex gap-2 mt-4">
              <button
                onClick={async () => {
                  if (noteSaving) return;
                  setNoteSaving(true);
                  // Hours first, and the modal stays open if they fail: the note
                  // is optional and recoverable, the hours are what decides
                  // whether a work order exists at all.
                  if (wantsHours && !(await saveHours())) { setNoteSaving(false); return; }
                  if (note) await addLogNote(note, stage);
                  setNoteSaving(false);
                  setNoteModal(null);
                  if (ref) void load(ref, true);
                }}
                disabled={noteSaving || !hoursOk}
                className="flex-1 text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
              >
                {noteSaving ? "שומר…" : "שמור"}
              </button>
              {hoursOk ? (
                <button onClick={() => setNoteModal(null)} className="flex-1 border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)]">
                  {wantsHours ? "סגור" : "דלג"}
                </button>
              ) : (
                <div className="flex-1 flex items-center justify-center text-[11px] text-rose-400 text-center leading-tight px-1">
                  בלי שעות לא תיווצר הזמנת עבודה
                </div>
              )}
            </div>
          </div>
        </div>
        );
      })()}

      {ref && (
        <>
          <div className="fixed inset-0 z-40" style={{ background: "rgba(3,2,10,0.5)", backdropFilter: "blur(4px)" }} onClick={close} />
          <aside
            className="fixed inset-y-0 left-0 z-50 w-full max-w-md border-e border-[var(--rule2)] shadow-2xl overflow-y-auto"
            style={{ background: "rgba(15,13,28,0.92)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
          >
            <div
              className="sticky top-0 border-b border-[var(--rule)] px-4 py-3 flex items-center gap-2 z-10"
              style={{ background: "rgba(15,13,28,0.85)", backdropFilter: "blur(16px)" }}
            >
              <IconTile icon={ENTITY_ICON[data?.type ?? ""] ?? "search"} accent={ENTITY_ACCENT[data?.type ?? ""] ?? "violet"} size={28} iconSize={15} />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-[var(--faint)]">{data?.label ?? ""}</div>
                <div className="text-sm font-bold truncate">{loading ? "טוען…" : data?.title ?? ""}</div>
              </div>
              <span className="text-[10px] text-[var(--faint)]">Esc סגירה · ⌘⏎ שמירה</span>
              <button onClick={close} className="text-[var(--dim)] hover:text-[var(--fg)] px-1">✕</button>
            </div>

            {error && (
              <div className="m-3 text-xs text-red-400 border border-red-500/40 rounded px-3 py-2">{error}</div>
            )}

            {/* The route refuses to choose between two live rounds (409). That
                refusal becomes the choice itself — two buttons that re-send
                with an explicit link_id — rather than an error the tech has to
                read, understand and then repeat the whole edit for. */}
            {matPicker && (
              <div
                className="m-3 rounded-xl px-3 py-2.5 text-xs"
                style={{ background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.35)" }}
              >
                <div className="font-bold mb-1">לאיזה סבב לצרף את החומרים?</div>
                <div className="text-[11px] text-[var(--dim)] mb-2">
                  יש שני סבבי ביקורת חיים להפקה — אחד לפרק ואחד לרילז. החומרים נשמרים לסבב אחד בלבד.
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {matPicker.links.map((l) => (
                    <button
                      key={l.id}
                      disabled={matBusy}
                      onClick={() => matPicker.retry(l.id)}
                      className="text-[11px] border border-[var(--rule)] rounded-lg px-2.5 py-1 text-[var(--violet-light)] hover:bg-[var(--panel3)] disabled:opacity-40"
                    >
                      {l.scope === "episode" ? "לסבב הפרק" : l.scope === "reels" ? "לסבב הרילז" : `לסבב ${l.scope}`}
                    </button>
                  ))}
                  <button onClick={() => setMatPicker(null)} className="text-[11px] text-[var(--faint)] px-1">
                    ביטול
                  </button>
                </div>
              </div>
            )}

            {data && (
              <div className="p-4 space-y-4">
                {/* §2 disk tag — always visible at the very top, next to the
                    production. Never buried. Empty → dim "לא צוין", tapping it
                    (with edit rights) opens the disk modal. */}
                {data.type === "production" && (() => {
                  const disk = String((data.entity.storage_disk as string) ?? "").trim();
                  const canEdit = data.canEditStages;
                  return (
                    <button
                      onClick={() => { if (canEdit) { setDiskValue(disk); setDiskModal(true); } }}
                      disabled={!canEdit}
                      className={`inline-flex items-center gap-1.5 text-xs rounded-full px-3 py-1 border transition-colors disabled:cursor-default ${
                        disk
                          ? "border-[var(--violet-light)]/50 text-[var(--fg)]"
                          : "border-[var(--rule)] text-[var(--faint)]"
                      } ${canEdit ? "enabled:hover:border-[var(--violet-light)]" : ""}`}
                      style={disk ? { background: "rgba(139,92,246,0.10)" } : undefined}
                      title={canEdit ? "לחיצה לעריכת הדיסק" : undefined}
                    >
                      <span>💾</span>
                      <span className="font-mono">{disk || "לא צוין"}</span>
                    </button>
                  );
                })()}
                {/* production pipeline — the phone-friendly status control that
                    replaces drag (owner 2026-07-22). Big one-tap "advance to
                    next stage" on top; the full pipeline below for jump/back.
                    Read-only (all disabled) for a viewer without edit rights. */}
                {/* status cursor — where the production is, in one glance. It
                    auto-derives from the two workflow blocks below, so it's NOT
                    the daily control; manual moves (cancel / freeze /
                    exceptional jump) live behind "⋯ פעולות חריגות" so a tech
                    doesn't fight it (owner 2026-07-22). */}
                {data.type === "production" && (() => {
                  const cur = String(data.entity.status ?? "");
                  const next = prodNextStatus(cur);
                  return (
                    <div className="rounded-xl border border-[var(--rule)] p-3" style={{ background: "rgba(255,255,255,0.03)" }}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[10px] text-[var(--faint)]">סטטוס</div>
                          <div className="text-sm font-bold truncate">{PROD_STATUS_LABEL[cur] ?? cur}</div>
                        </div>
                        {data.canEditStages && (
                          <button
                            onClick={() => setExcOpen((v) => !v)}
                            className="shrink-0 text-[11px] text-[var(--dim)] border border-[var(--rule)] rounded-lg px-2 py-1 hover:border-[var(--violet-light)] hover:text-[var(--violet-light)] transition-colors"
                          >
                            ⋯ פעולות חריגות
                          </button>
                        )}
                      </div>
                      {/* the old caption promised more than the trigger does:
                          derive_production_status is forward-only and its top
                          rank IS 'נערך' (0039), so past that point no stage
                          change moves this cursor. Say so. */}
                      <div className="text-[10px] text-[var(--faint)] mt-1">
                        מתקדם אוטומטית עם השלבים — עד &quot;נערך&quot;. משם והלאה ידני, ואישור הלקוח נמדד בנפרד לכל תוצר.
                      </div>
                      {excOpen && data.canEditStages && (
                        <div className="mt-2 pt-2 border-t border-[var(--rule)] space-y-2">
                          {next && (
                            <button
                              onClick={() => void changeProductionStatus(next)}
                              disabled={savingStatus}
                              className="w-full text-[11px] rounded-lg py-1.5 border border-[var(--violet-light)] text-[var(--violet-light)] hover:bg-[rgba(139,92,246,0.14)] disabled:opacity-50 transition-colors"
                            >
                              קפיצה חריגה ל{PROD_STATUS_LABEL[next] ?? next}
                            </button>
                          )}
                          <div className="flex flex-wrap gap-1">
                            {PROD_STATUS_ORDER.map((s) => {
                              const isCur = s === cur;
                              return (
                                <button
                                  key={s}
                                  onClick={() => { if (!isCur && data.canEditStages) void changeProductionStatus(s); }}
                                  disabled={savingStatus || isCur}
                                  className={`text-[11px] rounded-full px-2.5 py-1 border transition-colors disabled:cursor-default ${
                                    isCur
                                      ? "border-[var(--violet-light)] text-[var(--fg)] font-bold"
                                      : "border-[var(--rule)] text-[var(--dim)] enabled:hover:border-[var(--violet-light)]"
                                  }`}
                                  style={isCur ? { background: "rgba(139,92,246,0.18)" } : undefined}
                                >
                                  {PROD_STATUS_LABEL[s]}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                <div className="space-y-2.5">
                  {data.fields
                    // Registered in entities.ts, deliberately not rendered here.
                    // `status` and `storage_disk` have their own dedicated UI at
                    // the top of the drawer; `billing_block_reason` (0067) is
                    // registered so `selectColumns` will fetch the column at all
                    // — the hourly-pricing UI needs it — but a bare readonly row
                    // reading "חסימת חיוב: לא הוזנו שעות ההקלטה" beside the
                    // guest and the studio explains nothing and offers nothing to
                    // press. It comes back with a display built for it.
                    .filter(
                      (f) =>
                        !(
                          data.type === "production" &&
                          (f.key === "status" || f.key === "storage_disk" || f.key === "billing_block_reason")
                        )
                    )
                    .map((f) => (
                    <div key={f.key} className="grid grid-cols-[110px_1fr] items-center gap-2">
                      <label className="text-xs text-[var(--dim)]">{f.label}</label>
                      {renderValue(f)}
                    </div>
                  ))}
                </div>

                {/* Contact details, which live in Morning and not in `clients`.
                    Its own self-fetching block beside the DB fields — never a
                    row in the generic list above — for the reason its route
                    states: the registry maps field keys to COLUMNS, and these
                    have none. Same shape as AddonsSection. */}
                {data.type === "client" && ref && (
                  <ClientContactsSection clientId={ref.id} onChanged={broadcast} />
                )}

                {/* the two workflow lines — where daily work happens. Each is
                    independent: its own stage steps, its own client-review
                    state and correction notes. Advancing a step here is what
                    moves the status cursor above. */}
                {data.type === "production" && data.stages && (() => {
                  const advance = (s: Stage) => void advanceStage(s);
                  const epStages = data.stages!.filter((s) => s.track === "episode");
                  const reelStages = data.stages!.filter((s) => s.track === "reels");
                  const rs = data.reelsSummary;
                  const reelsTally = rs && rs.count > 0 ? `${rs.count} רילז` : null;
                  // 0055: the stage rows ARE the composition. A production
                  // without reels has no reels rows at all (create_default_
                  // stages never seeds them), so their presence is the whole
                  // test. review_reels_required is deliberately not consulted
                  // here any more — it means "the client wasn't asked in this
                  // round", never "this production has no reels", and mixing
                  // the two hid a live work line from the technician.
                  const reelsShown = reelStages.length > 0;
                  // unified send available when both blocks are present, at
                  // least one media link is filled, and both aren't already
                  // approved (nothing left to send)
                  const bothPresent = epStages.length > 0 && reelsShown;
                  const reelCount = data.reelsSummary?.count ?? 0;
                  const reelFilled = firstReelLink();
                  const anyMedia = !!(episodeMedia.trim() || reelFilled);
                  const bothApproved = !!data.review?.episode_approved && !!data.review?.reels_approved;
                  const showUnified = data.canEditStages && bothPresent && !bothApproved;
                  // which live links each send button would burn (Q7).
                  // Scope-aware supersession (B1 fix) means episode and reels
                  // links coexist, so each button warns about its own overlap;
                  // the unified send supersedes every live link.
                  const allLive = data.reviewLinks ?? [];
                  const liveForEpisode = allLive.filter((l) => scopeCovers(l.scope, "episode"));
                  const liveForReels = allLive.filter((l) => scopeCovers(l.scope, "reels"));
                  return (
                    <div className="space-y-2">
                      {/* what the client is holding right now — ONE box for the
                          whole production. Per-block rendering showed the same
                          scope='all' link in every block. The per-scope
                          overwrite warning stays on each button, where it is
                          genuinely different per track. */}
                      {data.canEditStages && <LiveLinksBox links={allLive} />}
                      {/* the round the client already answered — its notes, and
                          the "קיבלתי, מטפל" step that closes the loop. Above the
                          track blocks: what the client said comes before what is
                          being sent next. */}
                      {data.canEditStages && (
                        <button
                          onClick={() => setShowClientNotes(true)}
                          className="w-full text-sm border border-[var(--rule)] rounded-lg px-3 py-2 mb-2 text-[var(--violet-light)] hover:bg-[var(--panel3)] transition-colors flex items-center justify-center gap-2"
                        >
                          💬 צפה בהערות הלקוח
                        </button>
                      )}
                      {epStages.length > 0 && (
                        <ProductionTrackBlock
                          icon="🎬"
                          title="פרק"
                          stages={epStages}
                          note={data.review?.episode_note ?? null}
                          approved={!!data.review?.episode_approved}
                          canEdit={data.canEditStages}
                          onAdvance={advance}
                          saving={savingStatus}
                          onSend={(url) => void sendReviewLink("episode", url)}
                          sending={reviewSending === "episode"}
                          sent={reviewSent?.scope === "episode" ? reviewSent : null}
                          mediaUrl={episodeMedia}
                          onMediaChange={setEpisodeMedia}
                          onMediaBlur={() => void saveItemLink("episode", null, episodeMedia)}
                          liveLinks={liveForEpisode}
                          materials={{
                            // materials live ON the round; with no round there
                            // is nothing to read and nothing to write
                            transcript: liveForEpisode[0]?.transcript ?? null,
                            audioLink: liveForEpisode[0]?.audio_link ?? null,
                            noRound: liveForEpisode.length === 0,
                            canEdit: data.canEditStages,
                            busy: matBusy,
                            onSaveTranscript: (v) => void saveMaterials({ transcript: v }),
                            onSaveAudio: (v) => void saveMaterials({ audio_link: v }),
                            onLoadBody: async () => {
                              if (!liveForEpisode[0]) return null;
                              const r = await fetch(
                                `/api/productions/${ref.id}/review-materials?link_id=${liveForEpisode[0].id}`
                              );
                              const j = await r.json().catch(() => ({}));
                              if (!r.ok) {
                                setError(j.error ?? "טעינת התמלול נכשלה");
                                return null;
                              }
                              return (j.transcript?.content as string | undefined) ?? null;
                            },
                          }}
                        />
                      )}
                      {reelsShown && (
                        <ProductionTrackBlock
                          icon="📱"
                          title="רילז"
                          stages={reelStages}
                          note={data.review?.reels_note ?? null}
                          approved={!!data.review?.reels_approved}
                          canEdit={data.canEditStages}
                          onAdvance={advance}
                          tally={reelsTally}
                          saving={savingStatus}
                          onSend={(url) => void sendReviewLink("reels", url)}
                          sending={reviewSending === "reels"}
                          sent={reviewSent?.scope === "reels" ? reviewSent : null}
                          mediaUrl={reelFilled ?? ""}
                          onMediaChange={() => {}}
                          mediaFields={
                            reelCount > 0
                              ? Array.from({ length: reelCount }, (_, k) => {
                                  const i = k + 1;
                                  const item = (data.reviewItems ?? []).find(
                                    (it) => it.kind === "reel" && it.reel_index === i
                                  );
                                  return {
                                    label: `ריל ${i}`,
                                    value: reelMedia[i] ?? "",
                                    onChange: (v: string) => setReelMedia((prev) => ({ ...prev, [i]: v })),
                                    onBlur: () => void saveItemLink("reel", i, reelMedia[i] ?? ""),
                                    status: item ? { approved: item.approved, note: item.last_note } : null,
                                  };
                                })
                              : undefined
                          }
                          liveLinks={liveForReels}
                        />
                      )}
                      {/* unified send — takes both blocks' links at once */}
                      {showUnified && (
                        <div className="space-y-1.5">
                          <button
                            onClick={() => void sendUnifiedReviewLink()}
                            disabled={reviewSending === "all" || !anyMedia}
                            className="w-full text-[11px] rounded-lg py-2 border border-[var(--violet-light)] text-[var(--violet-light)] hover:bg-[rgba(139,92,246,0.14)] disabled:opacity-50 transition-colors font-bold"
                          >
                            {/* line 1 keeps B2's scope-reflecting label — what
                                WILL be sent; line 2 says what it destroys */}
                            <span className="block">
                              {reviewSending === "all"
                                ? "יוצר קישור…"
                                : !anyMedia
                                  ? "הדביקו קישור צפייה לפחות למסלול אחד"
                                  : episodeMedia.trim() && reelFilled
                                    ? "שלח לצפייה (פרק + רילז) →"
                                    : episodeMedia.trim()
                                      ? "שלח לצפייה (פרק בלבד — חסר קישור רילז) →"
                                      : "שלח לצפייה (רילז בלבד — חסר קישור פרק) →"}
                            </span>
                            {reviewSending !== "all" && anyMedia && allLive.length > 0 && (
                              <span className="block text-[9px] font-normal text-rose-400/70">
                                {allLive.length > 1 ? "ידרוס את שני הלינקים החיים" : "ידרוס את הלינק החי"}
                              </span>
                            )}
                          </button>
                          {reviewSent?.scope === "all" && (
                            <div className="rounded-lg px-2.5 py-2 text-[11px]" style={{ background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.35)" }}>
                              <div className="font-bold mb-1">
                                {reviewSent.sentScope === "all"
                                  ? "נשלח לינק מאוחד — פרק + רילז"
                                  : reviewSent.sentScope === "episode"
                                    ? "נשלח לינק לפרק בלבד"
                                    : "נשלח לינק לרילז בלבד"}
                              </div>
                              <div className="text-[var(--dim)] mb-1 break-all">{reviewSent.url}</div>
                              <div className="flex items-center gap-3">
                                <button onClick={() => navigator.clipboard?.writeText(reviewSent.url)} className="text-[var(--violet-light)] hover:underline">העתק קישור</button>
                                {reviewSent.whatsapp && (
                                  <a href={reviewSent.whatsapp} target="_blank" rel="noreferrer" className="text-[var(--violet-light)] hover:underline">שלח בוואטסאפ ↗</a>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* ⛔ THE MISSING-HOURS FLAG (F6).
                    Shaped like the client's correction note above — same red
                    border, same tint — because it is the same kind of thing:
                    something a person asked for that the production cannot
                    proceed without.

                    IT CARRIES A BUTTON, and that is the whole point. A notice
                    that only states a problem gets read once and lived with;
                    the fix has to be one press away, in the place the problem
                    is named. (Same lesson as 70488a5.)

                    DERIVED AT RENDER, from three columns already loaded — not
                    from billing_block_reason. That column is only written when
                    something RUNS the eligibility check, nothing re-runs it on
                    a status change, and technicians cannot open /radar where it
                    is surfaced. So the drawer decides for itself, and is right
                    the moment the recording ends. */}
                {data.type === "production" &&
                  hoursMissing({
                    pricing_model: data.hourly?.pricing_model,
                    studio_hours: data.hourly?.studio_hours,
                    status: String(data.entity.status ?? ""),
                  }) && (
                    <div
                      className="rounded-lg border border-rose-500/40 px-2.5 py-2 flex items-center gap-2"
                      style={{ background: "rgba(251,113,133,0.10)" }}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold text-rose-400">⛔ לא הוזנו שעות הקלטה</div>
                        <div className="text-[10px] text-[var(--dim)]">לא תיווצר הזמנת עבודה עד שיוזנו</div>
                      </div>
                      {data.canEditStages && (
                        <button
                          onClick={askHours}
                          className="shrink-0 text-[11px] rounded-lg px-2.5 py-1.5 border border-rose-500/60 text-rose-300 hover:bg-rose-500/15 transition-colors"
                        >
                          הזן שעות
                        </button>
                      )}
                    </div>
                  )}

                {data.type === "production" && ref && (
                  <AddonsSection productionId={ref.id} onChanged={broadcast} />
                )}

                {/* §3 יומן ההפקה — the full chronological story */}
                {data.type === "production" && data.log && (
                  <JournalSection
                    log={data.log}
                    canEdit={data.canEditStages}
                    onAddNote={(note) => addLogNote(note, null)}
                    onEditNote={editLogNote}
                  />
                )}

                {data.linked && (
                  <div>
                    <div className="text-xs font-bold text-[var(--dim)] mb-1.5">
                      {data.type === "job" ? "הפקות מקושרות" : "חיובים מקושרים"}
                    </div>
                    {data.linked.length === 0 && (
                      <div className="text-xs text-[var(--faint)]">
                        אין קישורים.{" "}
                        <Link href="/finance/link" className="underline">מסך הקישור ←</Link>
                      </div>
                    )}
                    <div className="space-y-1">
                      {data.linked.map((l) => (
                        <button
                          key={l.id as string}
                          onClick={() =>
                            openEntity({ type: data.type === "job" ? "production" : "job", id: l.id as string })
                          }
                          className="block w-full text-right text-xs border border-[var(--rule)] rounded px-2 py-1.5 hover:bg-[var(--panel3)]"
                        >
                          {data.type === "job"
                            ? `🎬 ${displayDate(l.record_date as string | null) ?? "—"} · ${l.podcast_name}${l.guest ? ` · ${l.guest}` : ""}`
                            : `💰 ${displayDate(l.date as string | null) ?? "—"} · ${l.campaign ?? "—"} · ${
                                l.amount != null ? `${NIS.format(l.amount as number)} ₪` : "—"
                              }`}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {data.milestones && data.milestones.length > 0 && (
                  <div>
                    <div className="text-xs font-bold text-[var(--dim)] mb-1.5">אבני דרך</div>
                    <div className="space-y-1">
                      {data.milestones.map((m) => (
                        <div key={m.id as string} className="text-xs flex gap-2">
                          <span>{m.name as string}</span>
                          <span className="text-[var(--dim)]">
                            {m.amount != null ? `${NIS.format(m.amount as number)} ₪` : "—"}
                          </span>
                          <span className="text-[var(--faint)]">{(m.expected_date as string) ?? ""}</span>
                          {/* the derived state, same source as /contracts —
                              not the raw English status column */}
                          <span style={{ color: MILESTONE_META[m.state as MilestoneState]?.color ?? "var(--faint)" }}>
                            {MILESTONE_META[m.state as MilestoneState]?.label ?? (m.status as string)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {data.history && (
                  <div className="border-t border-[var(--rule)] pt-3">
                    <div className="text-xs font-bold text-[var(--dim)] mb-1.5">היסטוריית שינויים</div>
                    {data.history.length === 0 && (
                      <div className="text-xs text-[var(--faint)]">אין אירועים.</div>
                    )}
                    <div className="space-y-2">
                      {data.history.map((h) => (
                        <div key={h.id} className="text-[11px]">
                          <div className="flex gap-2 text-[var(--faint)]">
                            <span>{displayDateTime(h.created_at)}</span>
                            <span>{h.actor}</span>
                            <span>{h.event_type}</span>
                          </div>
                          {renderChanges(h)}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </aside>
        </>
      )}
    </DrawerContext.Provider>
  );
}

// Session add-ons / upsells (owner spec 2026-07-21). Self-contained: it owns
// its fetch and mutations against /api/productions/[id]/addons, so the drawer
// core stays permission-free. The server decides what this viewer may do and
// see (prices are stripped for a non-money viewer) and hands back the flags
// we branch on here — the drawer never infers a permission on its own.
type AddonItem = {
  id: string;
  title: string;
  quantity: number;
  status: string;
  approved_via: string | null;
  unit_price: number | null;
  total: number | null;
  is_reels_addon: boolean;
};
type AddonsData = {
  addons: AddonItem[];
  base_amount: number | null; // effective: price_override ?? default_rate
  default_rate: number | null;
  price_override: number | null;
  can_edit_stages: boolean;
  can_edit_money: boolean;
  can_view_money: boolean;
};

const ADDON_STATUS: Record<string, { label: string; className: string }> = {
  proposed: { label: "מוצע", className: "text-[var(--dim)] border-[var(--rule)]" },
  approved: { label: "אושר", className: "text-emerald-400 border-emerald-500/50" },
  rejected: { label: "נדחה", className: "text-[var(--faint)] border-[var(--rule)] line-through" },
};

function AddonsSection({ productionId, onChanged }: { productionId: string; onChanged: () => void }) {
  const [data, setData] = useState<AddonsData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newQty, setNewQty] = useState("1");
  const [newPrice, setNewPrice] = useState("");
  const [newIsReels, setNewIsReels] = useState(false);
  // per-row draft price for a money editor filling in an unpriced line
  const [priceDraft, setPriceDraft] = useState<Record<string, string>>({});
  // base-price override editing (money editors)
  const [editingBase, setEditingBase] = useState(false);
  const [baseDraft, setBaseDraft] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/productions/${productionId}/addons`);
    if (!res.ok) return;
    setData(await res.json());
  }, [productionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/productions/${productionId}/addons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "הפעולה נכשלה");
      return false;
    }
    await load();
    onChanged();
    return true;
  }

  if (!data) return null;
  const { addons, base_amount, default_rate, price_override, can_edit_stages, can_edit_money, can_view_money } = data;

  const approvedTotal = addons
    .filter((a) => a.status === "approved" && a.total != null)
    .reduce((sum, a) => sum + (a.total ?? 0), 0);

  async function addLine() {
    const qty = Number(newQty);
    if (!newTitle.trim() || !Number.isInteger(qty) || qty < 1) return;
    const body: Record<string, unknown> = { action: "add", title: newTitle.trim(), quantity: qty, is_reels_addon: newIsReels };
    if (can_edit_money && newPrice.trim()) body.unit_price = Number(newPrice);
    if (await act(body)) {
      setNewTitle("");
      setNewQty("1");
      setNewPrice("");
      setNewIsReels(false);
    }
  }

  return (
    <div className="border-t border-[var(--rule)] pt-3">
      <div className="text-xs font-bold text-[var(--dim)] mb-1.5">תוספות</div>

      {addons.length === 0 && <div className="text-xs text-[var(--faint)] mb-2">אין תוספות.</div>}

      <div className="space-y-1.5">
        {addons.map((a) => {
          const st = ADDON_STATUS[a.status] ?? ADDON_STATUS.proposed;
          return (
            <div key={a.id} className="border border-[var(--rule)] rounded-lg px-2.5 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="flex-1 font-medium">{a.title}</span>
                {a.is_reels_addon && (
                  <span className="text-[10px] border border-[var(--rule)] rounded px-1.5 py-0.5 text-[var(--dim)]">רילז</span>
                )}
                <span className={`text-[10px] border rounded px-1.5 py-0.5 ${st.className}`}>{st.label}</span>
              </div>
              <div className="flex items-center gap-2 mt-1 text-[var(--dim)]">
                <span>כמות {a.quantity}</span>
                {can_view_money && (
                  <>
                    <span>·</span>
                    {a.unit_price != null ? (
                      <span>
                        {NIS.format(a.unit_price)} ₪ ליח׳ · סה״כ {NIS.format(a.total ?? 0)} ₪
                      </span>
                    ) : (
                      <span className="text-amber-400">ללא מחיר — לא נכלל בסיכום</span>
                    )}
                  </>
                )}
              </div>

              {/* money editor prices an unpriced line inline */}
              {can_edit_money && a.unit_price == null && (
                <div className="flex gap-1.5 mt-1.5">
                  <input
                    value={priceDraft[a.id] ?? ""}
                    onChange={(e) => setPriceDraft((p) => ({ ...p, [a.id]: e.target.value.replace(/[^\d.]/g, "") }))}
                    placeholder="מחיר ליחידה"
                    className="flex-1 bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1 text-xs"
                  />
                  <button
                    disabled={busy || !(priceDraft[a.id] ?? "").trim()}
                    onClick={() => act({ action: "price", addon_id: a.id, unit_price: Number(priceDraft[a.id]) })}
                    className="border border-[var(--rule)] rounded px-2 py-1 text-[var(--dim)] hover:bg-[var(--panel3)] disabled:opacity-40"
                  >
                    שמור מחיר
                  </button>
                </div>
              )}

              {/* actions on a still-proposed line */}
              {a.status === "proposed" && (
                <div className="flex gap-1.5 mt-1.5">
                  {can_edit_money && a.unit_price != null && (
                    <>
                      <button
                        disabled={busy}
                        onClick={() => act({ action: "approve", addon_id: a.id })}
                        className="border border-emerald-500/50 text-emerald-400 rounded px-2 py-0.5 hover:bg-emerald-500/10 disabled:opacity-40"
                      >
                        אשר
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => act({ action: "reject", addon_id: a.id })}
                        className="border border-[var(--rule)] text-[var(--dim)] rounded px-2 py-0.5 hover:bg-[var(--panel3)] disabled:opacity-40"
                      >
                        דחה
                      </button>
                    </>
                  )}
                  {can_edit_stages && (
                    <button
                      disabled={busy}
                      onClick={() => act({ action: "delete", addon_id: a.id })}
                      className="border border-[var(--rule)] text-[var(--faint)] rounded px-2 py-0.5 hover:bg-[var(--panel3)] disabled:opacity-40 mr-auto"
                    >
                      מחק
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* add a line — stages editor */}
      {can_edit_stages && (
        <div className="mt-2.5 space-y-1.5">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="תיאור תוספת (למשל: 3 רילז נוספים)"
            className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1.5 text-xs"
          />
          <div className="flex gap-1.5">
            <input
              value={newQty}
              onChange={(e) => setNewQty(e.target.value.replace(/\D/g, ""))}
              placeholder="כמות"
              className="w-16 bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1.5 text-xs"
            />
            {can_edit_money && (
              <input
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="מחיר ליח׳ (אופציונלי)"
                className="flex-1 bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1.5 text-xs"
              />
            )}
            <button
              disabled={busy || !newTitle.trim()}
              onClick={addLine}
              className="text-white font-bold rounded px-3 py-1.5 text-xs disabled:opacity-40 mr-auto"
              style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
            >
              הוסף
            </button>
          </div>
          {/* explicit reels flag — feeds the drawer's reels tally instead of a
              fragile title match (owner 2026-07-22) */}
          <label className="flex items-center gap-1.5 text-[11px] text-[var(--dim)] cursor-pointer">
            <input type="checkbox" checked={newIsReels} onChange={(e) => setNewIsReels(e.target.checked)} />
            זו תוספת רילז (תיספר במניין הרילז)
          </label>
        </div>
      )}

      {/* production total = base + approved add-ons — money viewers */}
      {can_view_money && (
        <div className="mt-3 pt-2 border-t border-[var(--rule)] text-xs space-y-1">
          {/* base price: money editors can override it per production */}
          {editingBase && can_edit_money ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[var(--dim)] flex-1">מחיר בסיס</span>
              <input
                autoFocus
                value={baseDraft}
                onChange={(e) => setBaseDraft(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder={default_rate != null ? String(default_rate) : "מחיר"}
                className="w-24 bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1"
              />
              <button
                disabled={busy}
                onClick={async () => {
                  const val = baseDraft.trim() === "" ? null : Number(baseDraft);
                  if (await act({ action: "set_base_price", price_override: val })) setEditingBase(false);
                }}
                className="border border-[var(--rule)] rounded px-2 py-1 text-[var(--dim)] hover:bg-[var(--panel3)] disabled:opacity-40"
              >
                שמור
              </button>
              <button
                onClick={() => setEditingBase(false)}
                className="text-[var(--faint)] px-1"
              >
                ✕
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-[var(--dim)]">
              <span className="flex-1">
                מחיר בסיס
                {price_override == null && default_rate != null && (
                  <span className="text-[var(--faint)]"> (ברירת מחדל מהתוכנית)</span>
                )}
                {price_override != null && <span className="text-[var(--violet-light)]"> (מותאם)</span>}
              </span>
              <span>{base_amount != null ? `${NIS.format(base_amount)} ₪` : "—"}</span>
              {can_edit_money && (
                <button
                  onClick={() => {
                    setBaseDraft(price_override != null ? String(price_override) : "");
                    setEditingBase(true);
                  }}
                  className="text-[var(--violet-light)] hover:underline"
                >
                  ערוך
                </button>
              )}
            </div>
          )}
          <div className="flex justify-between text-[var(--dim)]">
            <span>תוספות מאושרות</span>
            <span>{NIS.format(approvedTotal)} ₪</span>
          </div>
          <div className="flex justify-between font-bold">
            <span>סה״כ הפקה</span>
            <span>{base_amount != null ? `${NIS.format(base_amount + approvedTotal)} ₪` : "—"}</span>
          </div>
        </div>
      )}

      {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Client contact block — emails, phone, contact person, and the read-only
// `send` flag. All four live in MORNING; `clients` has no column for any of
// them, which is why this is a block and not four rows in the field registry
// (entities.ts maps every registered key to a real column).
//
// Self-fetching, like AddonsSection: the seven DB fields render immediately and
// this arrives beside them, so Morning being slow or down costs the block and
// never the card. The server hands back the flags — the drawer never infers a
// permission on its own.
// ---------------------------------------------------------------------------
type ContactsData = {
  linked: boolean;
  morningClientId?: string;
  contacts: { emails: string[]; phone: string | null; contactPerson: string | null; send: boolean | null } | null;
  clientFetchFailed: boolean;
  canEdit: boolean;
  recipientCap: number;
};

function ClientContactsSection({ clientId, onChanged }: { clientId: string; onChanged: () => void }) {
  const [data, setData] = useState<ContactsData | null>(null);
  const [emails, setEmails] = useState<string[]>([]);
  const [phone, setPhone] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // the last-email warning, held until the operator answers it
  const [confirmLast, setConfirmLast] = useState<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/clients/${clientId}/contacts`);
    if (!res.ok) return;
    const d: ContactsData = await res.json();
    setData(d);
    setEmails(d.contacts?.emails ?? []);
    setPhone(d.contacts?.phone ?? "");
    setContactPerson(d.contacts?.contactPerson ?? "");
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  // One save path for all three fields. NO DIRTY-CHECKING: everything the block
  // holds goes on the wire every time. Measured 2026-09-09 — a field resent at
  // its current value does not register as a change, and three fields in one
  // body move exactly those three. Sending the whole block is both safe and
  // safer than diffing, because a wrong diff writes the wrong thing.
  //
  // `emails` is always the COMPLETE list (Morning replaces the array wholesale;
  // there is no add/remove). Empty strings clear phone/contactPerson — the
  // route turns null into "" for exactly that reason.
  async function save(nextEmails: string[], nextPhone: string, nextContact: string, confirm = false) {
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await fetch(`/api/entity/client/${clientId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patch: { emails: nextEmails, phone: nextPhone.trim(), contactPerson: nextContact.trim() },
        ...(confirm ? { confirm_morning: true } : {}),
      }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    // the same double-confirmation the client NAME goes through — one click,
    // then the same request again with confirm_morning
    if (res.status === 409 && body?.needs_morning_confirmation) {
      return save(nextEmails, nextPhone, nextContact, true);
    }
    if (!res.ok) {
      setError(body?.error ?? "השמירה נכשלה");
      // pull the truth back rather than leave the form showing what did not save
      await load();
      return false;
    }
    await load();
    onChanged();
    return true;
  }

  function removeEmail(i: number) {
    // The ONLY moment the emails/send coupling fires: the list dropping to zero.
    // Measured 2026-09-09 and one-way — emptying turns `send` off, refilling
    // does NOT turn it back on. So the warning is here, before the act, and
    // nowhere else.
    if (emails.length === 1) {
      setConfirmLast(i);
      return;
    }
    const next = emails.filter((_, j) => j !== i);
    setEmails(next);
    void save(next, phone, contactPerson);
  }

  function addEmail() {
    const e = newEmail.trim();
    if (!e) return;
    const next = [...emails, e];
    setNewEmail("");
    setEmails(next);
    void save(next, phone, contactPerson);
  }

  if (!data) return null;

  // Unmapped client: shown, locked, and told why. No creation path from here.
  if (!data.linked) {
    return (
      <div className="rounded-lg border border-[var(--rule)] px-2.5 py-2">
        <div className="text-[11px] font-bold text-[var(--dim)] mb-1">פרטי קשר</div>
        <div className="text-[10px] text-[var(--faint)]">
          הלקוח אינו מקושר למורנינג. פרטי הקשר נשמרים במורנינג בלבד, ולכן אין מה להציג או לערוך כאן.
        </div>
      </div>
    );
  }

  if (data.clientFetchFailed) {
    return (
      <div className="rounded-lg border border-amber-500/40 px-2.5 py-2" style={{ background: "rgba(251,191,36,0.08)" }}>
        <div className="text-[11px] font-bold text-amber-400 mb-1">פרטי קשר</div>
        <div className="text-[10px] text-[var(--dim)]">
          לא ניתן לקרוא את פרטי הקשר ממורנינג כרגע. שאר פרטי הלקוח מוצגים כרגיל.
        </div>
        <button onClick={() => void load()} className="mt-1.5 text-[10px] underline text-[var(--signal)]">
          נסי שוב
        </button>
      </div>
    );
  }

  const canEdit = data.canEdit;
  const overCap = emails.length > data.recipientCap;

  return (
    <div className="rounded-lg border border-[var(--rule)] px-2.5 py-2 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold text-[var(--dim)]">פרטי קשר</div>
        <div className="text-[9px] text-[var(--faint)]">מתוך מורנינג</div>
      </div>

      {/* ---- emails ---- */}
      <div className="space-y-1">
        {emails.length === 0 && <div className="text-[10px] text-[var(--faint)]">אין כתובות מייל</div>}
        {emails.map((e, i) => (
          <div key={`${e}-${i}`} className="flex items-center gap-2">
            <span className="text-[11px] flex-1 min-w-0 break-all">{e}</span>
            {canEdit && (
              <button
                onClick={() => removeEmail(i)}
                disabled={busy}
                className="shrink-0 text-[10px] text-[var(--faint)] hover:text-rose-400"
                title="הסרת כתובת"
              >
                הסר
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <div className="flex items-center gap-1.5 pt-0.5">
            <input
              value={newEmail}
              onChange={(ev) => setNewEmail(ev.target.value)}
              onKeyDown={(ev) => { if (ev.key === "Enter") addEmail(); }}
              placeholder="הוספת מייל"
              inputMode="email"
              className="flex-1 min-w-0 bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1 text-[11px]"
            />
            <button onClick={addEmail} disabled={busy || !newEmail.trim()} className="shrink-0 text-[10px] underline text-[var(--signal)]">
              הוסף
            </button>
          </div>
        )}
        {/* NOT a block. Three is the cap Morning applies to a DOCUMENT request
            (recipients.ts), not to a client record — measured: a client in this
            very account holds four. So the card states the consequence and lets
            the operator decide. */}
        {overCap && (
          <div className="text-[10px] text-amber-400">
            בהנפקת מסמך מורנינג מקבל עד {data.recipientCap} כתובות — הראשונות ברשימה.
          </div>
        )}
      </div>

      {/* ---- phone + contact person ---- */}
      <div className="grid grid-cols-[70px_1fr] items-center gap-2">
        <label className="text-[10px] text-[var(--dim)]">טלפון</label>
        <input
          value={phone}
          onChange={(ev) => setPhone(ev.target.value)}
          onBlur={() => { if ((data.contacts?.phone ?? "") !== phone.trim()) void save(emails, phone, contactPerson); }}
          disabled={!canEdit || busy}
          inputMode="tel"
          className="bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1 text-[11px] disabled:opacity-60"
        />
        <label className="text-[10px] text-[var(--dim)]">איש קשר</label>
        <input
          value={contactPerson}
          onChange={(ev) => setContactPerson(ev.target.value)}
          onBlur={() => { if ((data.contacts?.contactPerson ?? "") !== contactPerson.trim()) void save(emails, phone, contactPerson); }}
          disabled={!canEdit || busy}
          className="bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1 text-[11px] disabled:opacity-60"
        />
      </div>

      {/* ---- send: READ-ONLY, and that is the whole mitigation ----
          Morning recomputes this from `emails` and overwrites anything we pass
          (measured), so we never send it. Showing it is what stops the silent
          change: the flag was invisible until 2026-09-09, and an invisible flag
          is what let it be knocked off without anyone noticing. */}
      <div className="flex items-center gap-2 pt-0.5 border-t border-[var(--rule)]">
        <span className="text-[10px] text-[var(--dim)]">שליחה אוטומטית של מסמכים</span>
        {data.contacts?.send == null ? (
          <span className="text-[10px] text-[var(--faint)]">לא ידוע</span>
        ) : data.contacts.send ? (
          <span className="text-[10px] text-emerald-400">פעילה</span>
        ) : (
          <span className="text-[10px] text-amber-400">כבויה</span>
        )}
        <span className="text-[9px] text-[var(--faint)]">· נקבע במורנינג</span>
      </div>

      {error && <div className="text-[10px] text-red-400">{error}</div>}
      {note && <div className="text-[10px] text-[var(--dim)]">{note}</div>}

      {confirmLast !== null && (
        <div className="rounded-lg border border-amber-500/50 px-2.5 py-2" style={{ background: "rgba(251,191,36,0.10)" }}>
          <div className="text-[10px] text-amber-200 leading-relaxed">
            זהו המייל האחרון של הלקוח. מחיקתו תכבה במורנינג את השליחה האוטומטית של מסמכים ללקוח הזה — והדגל לא יידלק בחזרה כשתוסיפי מייל. להדליק אותו שוב אפשר רק ידנית, בכרטיס הלקוח במורנינג.
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            <button
              onClick={() => {
                const i = confirmLast;
                setConfirmLast(null);
                const next = emails.filter((_, j) => j !== i);
                setEmails(next);
                void save(next, phone, contactPerson);
              }}
              disabled={busy}
              className="text-[10px] rounded-lg px-2 py-1 border border-amber-500/60 text-amber-300"
            >
              מחק בכל זאת
            </button>
            <button onClick={() => setConfirmLast(null)} className="text-[10px] text-[var(--faint)] underline">
              ביטול
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
