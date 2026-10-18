"use client";

import { useEffect, useRef, useState } from "react";

// E13-6 — the client's player, version picker and download (plan §9.2 E13-6).
// OUR player, not Bunny's embed: an embed is a cross-origin iframe, so the page
// could never read the playback time — and the time-stamped pins of E13-8 are
// the reason E13 exists. Video: <video> on Bunny's HLS playlist — native HLS in
// Safari/iOS, hls.js everywhere else (loaded only when a Bunny version is on the
// page). Audio: the same playlist in <audio>, a plain time bar (owner 11.10).
//
// The playback URL is signed on the server for 4 hours (Q4). When the CDN
// answers 403 the player asks /api/r/[token]/playback for a fresh one and
// carries on from the same second.
//
// MODULE LEVEL, like Block in ReviewClient: declared inside a parent it would
// be a new component type on every render and the <video> would reload.

// mirrors ClientVersion from lib/review/clientVersions (redeclared — client component)
export type ClientVersionView =
  | { id: string; number: number; kind: "bunny"; isAudio: boolean; fileName: string | null; playbackUrl: string; expires: number; downloadable: boolean }
  | { id: string; number: number; kind: "drive"; mediaLink: string }
  | { id: string; number: number; kind: "archived"; isAudio: boolean; fileName: string | null };

// E13-8b: what the item's comment box needs from the player — the time to pin
// at (exact ms, owner 17.10: E13-11 exports it), a pause while the client
// types, and a seek from the pins list.
export type PlayerApi = { currentMs: () => number; pause: () => void; seek: (ms: number) => void };

// mirrors ClientComment from lib/review/itemComments (redeclared — client component)
export type ClientCommentView = {
  id: string;
  version_id: string | null;
  kind: "pin" | "general";
  pin_number: number | null;
  time_ms: number | null;
  body: string;
  created_at: string;
  /** E13-8c: written through this link (optional: older payloads omit it) */
  mine?: boolean;
  /** E13-9: the team marked it "טופל" */
  resolved?: boolean;
};

/** "00:42", "1:02:03" — mirrors formatPinTime in lib/review/itemComments. */
export function formatPinTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

const chip = (active: boolean): React.CSSProperties => ({
  padding: "5px 12px",
  borderRadius: 999,
  fontSize: 13,
  fontWeight: 700,
  border: active ? "1px solid #a78bfa" : "1px solid rgba(255,255,255,0.14)",
  background: active ? "rgba(167,139,250,0.18)" : "transparent",
  color: active ? "#ddd6fe" : "#c9c3e8",
  cursor: "pointer",
});

const primaryButton: React.CSSProperties = {
  display: "block",
  textAlign: "center",
  border: "1px solid rgba(167,139,250,0.55)",
  background: "rgba(167,139,250,0.10)",
  borderRadius: 12,
  padding: "11px 12px",
  fontSize: 14,
  fontWeight: 700,
  color: "#ddd6fe",
  textDecoration: "none",
};

function HlsMedia({
  token,
  version,
  onApi,
}: {
  token: string;
  version: Extract<ClientVersionView, { kind: "bunny" }>;
  onApi?: (api: PlayerApi | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [failed, setFailed] = useState(false);
  // a ref, not an effect dependency: a new callback each render must never
  // re-run the loading effect below (that would reload the media)
  const onApiRef = useRef(onApi);
  onApiRef.current = onApi;

  useEffect(() => {
    const el: HTMLMediaElement | null = version.isAudio ? audioRef.current : videoRef.current;
    if (!el) return;
    onApiRef.current?.({
      currentMs: () => Math.round(el.currentTime * 1000),
      pause: () => el.pause(),
      seek: (ms: number) => {
        el.currentTime = ms / 1000;
      },
    });
    return () => onApiRef.current?.(null);
  }, [version.id, version.isAudio]);

  useEffect(() => {
    const el: HTMLMediaElement | null = version.isAudio ? audioRef.current : videoRef.current;
    if (!el) return;
    let destroyed = false;
    let hls: { destroy: () => void; loadSource: (u: string) => void; attachMedia: (m: HTMLMediaElement) => void } | null = null;
    let renewing = false;
    setFailed(false);

    // 4h token ran out (403), or any fatal load error: re-sign once, resume from the same second
    const renew = async () => {
      if (renewing || destroyed) return;
      renewing = true;
      const at = el.currentTime;
      try {
        const r = await fetch(`/api/r/${encodeURIComponent(token)}/playback?version=${encodeURIComponent(version.id)}`, { cache: "no-store" });
        const b = (await r.json().catch(() => ({}))) as { url?: string };
        if (!r.ok || !b.url || destroyed) throw new Error("renew failed");
        if (hls) hls.loadSource(b.url);
        else el.src = b.url;
        const resume = () => {
          el.currentTime = at;
          el.removeEventListener("loadedmetadata", resume);
        };
        el.addEventListener("loadedmetadata", resume);
      } catch {
        if (!destroyed) setFailed(true);
      } finally {
        renewing = false;
      }
    };

    const native = !!el.canPlayType && el.canPlayType("application/vnd.apple.mpegurl") !== "";
    const onNativeError = () => void renew();
    if (native) {
      el.src = version.playbackUrl;
      el.addEventListener("error", onNativeError);
    } else {
      import("hls.js")
        .then(({ default: Hls }) => {
          if (destroyed) return;
          if (!Hls.isSupported()) {
            el.src = version.playbackUrl; // last resort; may not play
            return;
          }
          const h = new Hls();
          hls = h;
          h.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) void renew();
          });
          h.loadSource(version.playbackUrl);
          h.attachMedia(el);
        })
        .catch(() => !destroyed && setFailed(true));
    }
    return () => {
      destroyed = true;
      el.removeEventListener("error", onNativeError);
      if (hls) hls.destroy();
    };
  }, [token, version.id, version.playbackUrl, version.isAudio]);

  return (
    <div style={{ marginBottom: 10 }}>
      {version.isAudio ? (
        <audio ref={audioRef} controls preload="metadata" style={{ width: "100%" }} />
      ) : (
        <video
          ref={videoRef}
          controls
          playsInline
          preload="metadata"
          style={{ width: "100%", maxHeight: "70vh", background: "#000", borderRadius: 12, display: "block" }}
        />
      )}
      {failed && (
        <div style={{ fontSize: 12, color: "#fbbf24", marginTop: 6, textAlign: "center" }}>
          הנגן לא נטען. רעננו את הדף, או הורידו את הקובץ למטה.
        </div>
      )}
    </div>
  );
}

// The bytes come from Drive (owner 17.10); our route only checks the token,
// logs client_review_download and 302s to Drive's direct download.
// rel="noreferrer": with our Referer, Drive shows its virus-scan page on files
// over ~100MB even with confirm=t (the route's 302 also says no-referrer).
function DownloadButton({ token, versionId, fileName, tall }: { token: string; versionId: string; fileName: string | null; tall?: boolean }) {
  return (
    <a href={`/api/r/${encodeURIComponent(token)}/download/${encodeURIComponent(versionId)}`} rel="noreferrer" style={tall ? { ...primaryButton, padding: "16px 12px" } : primaryButton}>
      ⬇ הורדת הקובץ המקורי
      {fileName ? <span style={{ display: "block", fontSize: 11, fontWeight: 400, color: "#9a94b8", marginTop: 3 }} dir="auto">{fileName}</span> : null}
    </a>
  );
}

// E13-8b: the client's comments on the version on screen — pins by time (a
// tap seeks there), then the general ones. A list, not marks on the bar: the
// native controls (iOS above all) cannot carry marks.
// E13-9 (owner 18.10): "טופל ✓" beside a comment the team marked handled.
function ResolvedTag({ c }: { c: ClientCommentView }) {
  if (!c.resolved) return null;
  return <span style={{ color: "#4ade80", fontWeight: 700, fontSize: 12, whiteSpace: "nowrap" }}>טופל ✓</span>;
}

function CommentsList({ comments, onSeek }: { comments: ClientCommentView[]; onSeek: ((ms: number) => void) | null }) {
  if (!comments.length) return null;
  const pins = comments.filter((c) => c.kind === "pin" && c.time_ms !== null).sort((a, b) => (a.time_ms ?? 0) - (b.time_ms ?? 0));
  const general = comments.filter((c) => c.kind === "general");
  const row: React.CSSProperties = {
    display: "flex",
    gap: 8,
    alignItems: "baseline",
    width: "100%",
    textAlign: "right",
    padding: "7px 10px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.03)",
    color: "#ece9f5",
    fontSize: 13,
    marginBottom: 6,
  };
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: "#9a94b8", marginBottom: 6 }}>ההערות שלכם על הגרסה הזו</div>
      {pins.map((c) => (
        <button key={c.id} type="button" onClick={() => onSeek?.(c.time_ms ?? 0)} style={{ ...row, cursor: onSeek ? "pointer" : "default" }}>
          <span style={{ color: "#c4b5fd", fontWeight: 700, whiteSpace: "nowrap" }}>
            📍{c.pin_number ?? ""} · <span dir="ltr">{formatPinTime(c.time_ms ?? 0)}</span>
          </span>
          <span dir="auto" style={{ flex: 1, whiteSpace: "pre-wrap" }}>{c.body}</span>
          <ResolvedTag c={c} />
        </button>
      ))}
      {general.map((c) => (
        <div key={c.id} style={row}>
          <span style={{ color: "#9a94b8", whiteSpace: "nowrap" }}>כללית</span>
          <span dir="auto" style={{ flex: 1, whiteSpace: "pre-wrap" }}>{c.body}</span>
          <ResolvedTag c={c} />
        </div>
      ))}
    </div>
  );
}

export default function ReviewPlayer({
  token,
  versions,
  selectedId,
  onSelect,
  renderDrive,
  comments = [],
  onApi,
}: {
  token: string;
  versions: ClientVersionView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** today's Drive rendering (iframe + "open in Drive"), passed in by ReviewClient */
  renderDrive: (link: string) => React.ReactNode;
  /** E13-8b: the client's comments on this item, all versions; the list shows the selected one's */
  comments?: ClientCommentView[];
  /** E13-8b: the player's time / pause / seek, for the comment box; null when no Bunny player is on screen */
  onApi?: (api: PlayerApi | null) => void;
}) {
  const apiRef = useRef<PlayerApi | null>(null);
  if (!versions.length) return null;
  const latest = versions[versions.length - 1];
  const selected = versions.find((v) => v.id === selectedId) ?? latest;
  const isLatest = selected.id === latest.id;

  return (
    <div style={{ marginBottom: 12 }}>
      {versions.length > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 10 }}>
          {versions.map((v) => (
            <button key={v.id} type="button" onClick={() => onSelect(v.id)} style={chip(v.id === selected.id)}>
              v{v.number}
            </button>
          ))}
          <span style={{ fontSize: 12, color: "#9a94b8", marginInlineStart: 4 }}>
            {isLatest ? "הגרסה הנוכחית" : `גרסה קודמת · לצפייה בלבד`}
          </span>
        </div>
      )}

      {selected.kind === "bunny" && (
        <>
          <HlsMedia
            key={selected.id}
            token={token}
            version={selected}
            onApi={(api) => {
              apiRef.current = api;
              onApi?.(api);
            }}
          />
          <CommentsList comments={comments.filter((c) => c.version_id === selected.id)} onSeek={(ms) => apiRef.current?.seek(ms)} />
          {selected.downloadable && <DownloadButton token={token} versionId={selected.id} fileName={selected.fileName} />}
        </>
      )}

      {selected.kind === "drive" && (
        <>
          {renderDrive(selected.mediaLink)}
          <CommentsList comments={comments.filter((c) => c.version_id === selected.id)} onSeek={null} />
        </>
      )}

      {/* E13-10: media deleted at Bunny — no player, the same Drive download */}
      {selected.kind === "archived" && (
        <>
          <CommentsList comments={comments.filter((c) => c.version_id === selected.id)} onSeek={null} />
          <DownloadButton token={token} versionId={selected.id} fileName={selected.fileName} tall />
        </>
      )}
    </div>
  );
}
