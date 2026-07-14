// Job→production matching — the TS port of the step-A diagnostic
// (scripts/step_b_link_jobs.py carries the one-time approved batch; this
// runs live in the linking screen for whatever is still unlinked).
//
// Three signals, strongest first:
//   1. guest: the production's guest named in the campaign text — this
//      proved to be the strongest signal in the step-A diagnosis
//   2. show name/alias found in client name + campaign text
//   3. productions.client_id equal to the job's client_id
// A show match is then narrowed to productions within ±30 days of the
// job date. Nothing here writes — suggestions only, owner approves each.

export type ProductionLite = {
  id: string;
  show_id: string | null;
  record_date: string | null;
  guest: string | null;
  client_id: string | null;
};

export type ShowLite = { id: string; name: string; aliases: string[] };

export type JobLite = {
  id: string;
  client_id: string | null;
  date: string | null;
  campaign: string | null;
  amount: number | null;
};

export type Confidence = "high" | "medium" | "low" | "none";

export type Suggestion = {
  jobId: string;
  confidence: Confidence;
  showId: string | null;
  suggested: string[]; // production ids, pre-checked in the UI
  windowCandidates: string[]; // production ids of the matched show within ±30d
  note: string;
  multiEpisode: boolean; // campaign hints the job covers several productions
  // 🟡 parsed episode count from the campaign ("*4", "2 פרקים", "8+9").
  // When it exceeds the productions that exist in the window, work was done
  // but never entered — the אפרת לקט *2 hole, surfaced instead of swallowed.
  expectedEpisodes: number | null;
};

const WINDOW_DAYS = 30;
const GENERIC = new Set([
  "פודקאסט", "פרק", "פרקים", "קמפיין", "רדיו", "הזמנה", "תשדיר",
  "הקלטות", "הקלטה", "אולפן", "גלם", "בלבד", "עריכות", "רילז",
  "חבילת", "מיוחד", "מחיר", "שעות", "פיילוט", "וידאו", "אודיו",
  "תוכן", "חודש", "live", "sessions", "the", 'בע"מ', "מדיה",
  "דר", 'ד"ר', "דוקטור", "סרטים",
]);
const MULTI_RE = /\*\s*\d|\d+\s*פרקים|פרקים\s*\d|\d\s*\+\s*\d/;

function parseExpectedEpisodes(campaign: string): number | null {
  const star = campaign.match(/\*\s*(\d+)/);
  if (star) return Number(star[1]);
  const before = campaign.match(/(\d+)\s*פרקים/);
  if (before) return Number(before[1]);
  if (/פרקים\s*\d+\s*\+\s*\d+/.test(campaign)) return 2;
  return null;
}

function norm(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/['’"׳״`.,:;!?()[\]/\\*+\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string | null | undefined): string[] {
  return norm(s)
    .split(" ")
    .filter((t) => t.length >= 2 && !GENERIC.has(t) && !/^\d+$/.test(t));
}

// optimal-string-alignment similarity (transposition-aware, so
// סבלטנה ≈ סבטלנה passes) — stands in for Python's difflib ratio
function similarity(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return 1 - d[m][n] / Math.max(m, n);
}

function tokMatch(t: string, pool: string[]): number {
  if (pool.includes(t)) return 1;
  let best = 0;
  for (const u of pool) best = Math.max(best, similarity(t, u));
  // 0.72, not 0.78: OSA scores a bit lower than difflib's ratio — at 0.78
  // real matches like חווה≈חוה (0.75) and דודיסון≈דווידסון (0.75) are lost
  return best >= 0.72 ? best : 0;
}

function nameScore(name: string, textNorm: string, toks: string[]): number {
  const n = norm(name);
  if (!n) return 0;
  if (textNorm.replace(/ /g, "").includes(n.replace(/ /g, ""))) return 1;
  const nt = tokens(name);
  if (!nt.length) return 0;
  let hits = 0;
  for (const t of nt) hits += tokMatch(t, toks);
  return hits / nt.length;
}

function daysBetween(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
}

export function suggestForJob(
  job: JobLite,
  clientName: string,
  shows: ShowLite[],
  productions: ProductionLite[]
): Suggestion {
  const campaign = job.campaign ?? "";
  const jointText = norm(`${clientName} ${campaign}`);
  const jointToks = Array.from(new Set([...tokens(clientName), ...tokens(campaign)]));
  const campToks = tokens(campaign);
  const multiEpisode = MULTI_RE.test(campaign);
  const expectedEpisodes = parseExpectedEpisodes(campaign);

  const byShow = new Map<string, ProductionLite[]>();
  const clientShowIds = new Set<string>();
  for (const p of productions) {
    if (!p.show_id) continue;
    (byShow.get(p.show_id) ?? byShow.set(p.show_id, []).get(p.show_id)!).push(p);
    if (job.client_id && p.client_id === job.client_id) clientShowIds.add(p.show_id);
  }

  const inWindow = (pool: ProductionLite[]) =>
    !job.date
      ? []
      : pool
          .filter((p) => p.record_date && daysBetween(p.record_date, job.date!) <= WINDOW_DAYS)
          .sort((a, b) => daysBetween(a.record_date!, job.date!) - daysBetween(b.record_date!, job.date!));

  const guestHit = (p: ProductionLite) => {
    const gt = tokens(p.guest);
    return gt.length > 0 && gt.every((t) => tokMatch(t, campToks) > 0);
  };

  type Cand = { score: number; campScore: number; show: ShowLite; win: ProductionLite[] };
  const cands: Cand[] = [];
  for (const s of shows) {
    const names = [s.name, ...(s.aliases ?? [])];
    let score = Math.max(...names.map((n) => nameScore(n, jointText, jointToks)));
    const campScore = Math.max(...names.map((n) => nameScore(n, norm(campaign), campToks)));
    const viaClient = clientShowIds.has(s.id);
    if (viaClient) score = Math.max(score, 0.9);
    if (score >= 0.45) {
      cands.push({ score, campScore, show: s, win: inWindow(byShow.get(s.id) ?? []) });
    }
  }
  cands.sort(
    (a, b) =>
      b.score - a.score || b.campScore - a.campScore || Number(b.win.length > 0) - Number(a.win.length > 0)
  );

  const none = (note: string): Suggestion => ({
    jobId: job.id, confidence: "none", showId: null,
    suggested: [], windowCandidates: [], note, multiEpisode, expectedEpisodes,
  });

  if (cands.length) {
    const top = cands[0];
    const ambiguous =
      cands.length > 1 &&
      cands[1].score >= top.score - 0.1 &&
      cands[1].campScore >= top.campScore &&
      cands[1].win.length > 0 === top.win.length > 0;
    const guests = top.win.filter(guestHit);

    if (guests.length || top.win.length) {
      const picked = guests.length ? guests : top.win;
      let confidence: Confidence;
      let note: string;
      if (guests.length === 1) {
        confidence = "high";
        note = "אורח תואם בקמפיין";
      } else if (guests.length > 1) {
        confidence = "medium";
        note = `${guests.length} הפקות עם אורח תואם בחלון`;
      } else if (top.win.length === 1 && top.score >= 0.9) {
        confidence = "high";
        note = "הפקה יחידה בחלון";
      } else if (top.score >= 0.75) {
        confidence = "medium";
        note = top.win.length > 1 ? `${top.win.length} הפקות בחלון` : "הפקה יחידה בחלון, התאמת שם חזקה";
      } else {
        confidence = "low";
        note = `התאמת שם חלקית; ${top.win.length} הפקות בחלון`;
      }
      if (ambiguous) {
        confidence = confidence === "high" ? "medium" : "low";
        note += `; תוכנית לא חד-משמעית (גם: ${cands[1].show.name})`;
      }
      return {
        jobId: job.id, confidence, showId: top.show.id,
        suggested: [picked[0].id],
        windowCandidates: top.win.map((p) => p.id),
        note, multiEpisode, expectedEpisodes,
      };
    }
    if (top.score >= 0.7) {
      return none(
        job.date
          ? `תוכנית זוהתה (${top.show.name}) אך אין הפקה בחלון ±${WINDOW_DAYS} יום`
          : `תוכנית זוהתה (${top.show.name}) אך לחיוב אין תאריך`
      );
    }
  }

  // global guest fallback: the campaign names a guest of some production
  const globalGuests = inWindow(productions).filter(guestHit);
  if (globalGuests.length) {
    return {
      jobId: job.id,
      confidence: globalGuests.length === 1 ? "high" : "medium",
      showId: globalGuests[0].show_id,
      suggested: [globalGuests[0].id],
      windowCandidates: globalGuests.map((p) => p.id),
      note:
        globalGuests.length === 1
          ? "אורח בקמפיין תואם הפקה יחידה"
          : `אורח תואם ${globalGuests.length} הפקות`,
      multiEpisode, expectedEpisodes,
    };
  }

  return none("לא זוהתה תוכנית — כנראה חיוב כללי");
}
