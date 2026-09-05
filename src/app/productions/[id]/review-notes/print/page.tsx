import { getSessionAndProfile } from "@/lib/profile";
import { createClient } from "@/lib/supabase/server";
import { parseReelNotes } from "@/lib/review/reelNotes";
import PrintTrigger from "./PrintTrigger";

// The client's correction notes, on paper. A technician who works away from a
// screen — in the edit bay, with the reels open — gets the round printed
// instead of transcribed.
//
// INTERNAL, not public: unlike /r/[token], this is behind the same wall as the
// rest of the app (auth + can_edit_stages) and reads through the USER's client,
// so the RLS on client_review_links (can_view_stages(), 0029:50-52) is the real
// gate rather than a service-role read that trusts this file's own check.
//
// The round is chosen by exactly the rule api/productions/[id]/review-current
// uses — last responded_at wins — and the reels note is split by the shared
// parseReelNotes, not a second copy of it. Two renderings of the same notes
// that could disagree would be worse than no print page at all.
export const dynamic = "force-dynamic";

// Server-rendered, so the timezone must be said out loud: Vercel runs this in
// UTC (vercel.json pins fra1) and a round answered at 23:08 Israel time would
// otherwise print as 20:08. Same explicit-timezone rule as
// documents/accrued/page.tsx:18 and calendar/sync/route.ts:74.
const ANSWERED_AT = new Intl.DateTimeFormat("he-IL", {
  timeZone: "Asia/Jerusalem",
  day: "numeric",
  month: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

// Paper, not the app's palette. The design tokens are near-black surfaces with
// light text (globals.css:12-19) — printed, that is a page of ink. Everything
// below is written in plain values for that reason.
const PRINT_CSS = `
  .sheet { background: #ffffff; color: #111111; }
  @media print {
    @page { margin: 16mm; }
    html, body { background: #ffffff !important; }
    .no-print { display: none !important; }
    .sheet {
      margin: 0 !important;
      padding: 0 !important;
      max-width: none !important;
      border: none !important;
      box-shadow: none !important;
    }
    /* keep a note and its heading on the same sheet */
    .block { break-inside: avoid; page-break-inside: avoid; }
  }
`;

type Round = {
  id: string;
  responded_at: string;
  scope: string;
  episode_response: string | null;
  episode_note: string | null;
  reels_response: string | null;
  reels_note: string | null;
};

function Sheet({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      <div
        dir="rtl"
        className="sheet"
        style={{
          maxWidth: 720,
          margin: "24px auto",
          padding: "32px 36px",
          border: "1px solid #dddddd",
          borderRadius: 8,
          fontFamily: "system-ui, -apple-system, 'Segoe UI', Arial, sans-serif",
          lineHeight: 1.6,
        }}
      >
        {children}
      </div>
    </>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <Sheet>
      <p style={{ fontSize: 15, color: "#555555" }}>{text}</p>
    </Sheet>
  );
}

// one note, under its own heading
function NoteBlock({ title, note }: { title: string; note: string }) {
  return (
    <div className="block" style={{ marginBottom: 22 }}>
      <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{title}</h2>
      <div
        style={{
          border: "1px solid #cccccc",
          borderRadius: 4,
          padding: "10px 12px",
          fontSize: 14,
          whiteSpace: "pre-wrap",
        }}
      >
        {note}
      </div>
    </div>
  );
}

export default async function ReviewNotesPrintPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { print?: string };
}) {
  const { user, profile } = await getSessionAndProfile();
  if (!user || !profile?.approved) return <Notice text="לא מחובר" />;
  if (!profile.can_edit_stages) return <Notice text="אין הרשאה" />;

  const supabase = createClient();

  const { data: prod } = await supabase
    .from("productions")
    .select("id,podcast_name,record_date,guest")
    .eq("id", params.id)
    .maybeSingle();
  if (!prod) return <Notice text="ההפקה לא נמצאה" />;

  const { data: roundRow } = await supabase
    .from("client_review_links")
    .select("id,responded_at,scope,episode_response,episode_note,reels_response,reels_note")
    .eq("production_id", params.id)
    .not("responded_at", "is", null)
    .order("responded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const round = roundRow as Round | null;

  const autoPrint = searchParams.print === "1";

  if (!round) {
    return (
      <Sheet>
        <Header podcastName={prod.podcast_name as string} recordDate={prod.record_date as string | null} answeredAt={null} />
        <p style={{ fontSize: 15, color: "#555555" }}>אין הערות פתוחות מהלקוח.</p>
      </Sheet>
    );
  }

  // the same two tests review-current makes: 'approved' carries no correction,
  // and a revisions round with an empty note is a real (if quiet) shape
  const episodeNote = round.episode_note?.trim() || null;
  const reelsNote = round.reels_note?.trim() || null;
  const episode = round.episode_response === "revisions" && episodeNote ? episodeNote : null;
  const reels = round.reels_response === "revisions" && reelsNote ? parseReelNotes(reelsNote) : [];
  const hasDetail = !!episode || reels.length > 0;

  return (
    <Sheet>
      {autoPrint && <PrintTrigger />}
      <Header
        podcastName={prod.podcast_name as string}
        recordDate={prod.record_date as string | null}
        answeredAt={round.responded_at}
      />

      {episode && <NoteBlock title="פרק" note={episode} />}
      {reels.map((r, i) => (
        <NoteBlock
          key={r.reel ?? `free-${i}`}
          // reel is null for a track-mode note — one comment about the reels as
          // a whole, with no per-reel prefix to recover (links.ts:517)
          title={r.reel !== null ? `ריל ${r.reel}` : "רילז"}
          note={r.note}
        />
      ))}
      {!hasDetail && <p style={{ fontSize: 15, color: "#555555" }}>אין פירוט הערות בסבב זה.</p>}

      {/* screen only — on paper the browser prints its own header/footer */}
      <p className="no-print" style={{ marginTop: 28, fontSize: 12, color: "#888888" }}>
        להדפסה או שמירה כ-PDF: ⌘P / Ctrl+P
      </p>
    </Sheet>
  );
}

function Header({
  podcastName,
  recordDate,
  answeredAt,
}: {
  podcastName: string;
  recordDate: string | null;
  answeredAt: string | null;
}) {
  return (
    <div style={{ borderBottom: "1px solid #cccccc", paddingBottom: 14, marginBottom: 22 }}>
      {/* dir=ltr: the sheet is RTL, and an RTL row renders the Latin wordmark
          reversed — the same fix the public page carries (r/[token]:70-71) */}
      <div dir="ltr" style={{ fontSize: 12, color: "#777777", letterSpacing: "0.02em", marginBottom: 10 }}>
        Bizi Podclub
      </div>
      <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>{podcastName ?? "הפקה"}</h1>
      <p style={{ fontSize: 13, color: "#555555", margin: "6px 0 0" }}>
        הערות הלקוח
        {recordDate ? ` · הוקלט ${recordDate}` : ""}
        {answeredAt ? ` · נענה: ${ANSWERED_AT.format(new Date(answeredAt))}` : ""}
      </p>
    </div>
  );
}
