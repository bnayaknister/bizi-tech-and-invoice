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
  // 🔵 the episode ORDINAL. Present on 336 of 787 productions (measured
  // 2026-09-18), so it decides a minority of rows and is never required —
  // when it is absent the engine falls back to exactly what it did before.
  episode_no: number | null;
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
  // 🔴 P12 (owner 2026-09-18) — the three fields the PRE-TICK decision reads.
  // The suggestion itself is unchanged in spirit: the engine still names its
  // best candidate. What changed is that naming one no longer ticks its box.
  //
  // ambiguous: a second show scored within 0.1 of the winner. It already
  // downgraded `confidence`, but it is surfaced here so shouldPreTick can say
  // so out loud rather than inferring it from the grade.
  ambiguous: boolean;
  // amountOutlier: the job is too big to be one episode — see
  // SINGLE_PRODUCTION_CEILING. The second safety net, behind the contract gate.
  amountOutlier: boolean;
  // episodeMatch: the ordinal that decided the pick, when one did. Non-null
  // means the campaign named an episode and exactly one production in the
  // window carried that episode_no — the strongest signal the engine has.
  episodeMatch: number | null;
};

/**
 * 🔴 The amount guard (owner decision 2026-09-18, P12 §2).
 *
 * Measured over the 54 jobs linked to exactly ONE production: min ₪250,
 * median ₪600, p90 ₪1,270, p99 ₪4,873, max ₪8,000 — and that max is a lone
 * outlier, the second-highest being ₪2,100. ₪10,000 is the round number above
 * the single observed outlier, ~16× the median.
 *
 * Applied PER PRODUCTION (`amount ÷ max(1, expectedEpisodes)`) so a genuine
 * multi-episode job is judged on its per-episode price: "אפרת לקט*4" at
 * ₪8,000 reads as ₪2,000 an episode and passes, as it should.
 *
 * ⚠️ This is a net, not a gate. On the live data it flags NOTHING today: the
 * contract gate removes the ₪250,000 ביפו row before this is consulted. It
 * exists for the next job of that shape that arrives without a contract_id.
 */
export const SINGLE_PRODUCTION_CEILING = 10000;
export const AMOUNT_OUTLIER_NOTE = "סכום חריג להפקה בודדת — לבדוק";

function isAmountOutlier(amount: number | null, expectedEpisodes: number | null): boolean {
  if (amount === null || amount === undefined) return false;
  return amount / Math.max(1, expectedEpisodes ?? 1) > SINGLE_PRODUCTION_CEILING;
}

/**
 * 🔴 Whether the UI may pre-tick this suggestion's checkbox.
 *
 * Before P12 the screen ticked whatever `suggested` carried, at every grade
 * including `low` — so a guess decided by nothing but date proximity arrived
 * looking exactly like a certainty, and `Enter` approved it. On the live data
 * that was 16 of 22 rows pre-ticked with ZERO of them graded `high`.
 *
 * Three conditions, all required. `confidence === "high"` already implies
 * `!ambiguous` (ambiguity downgrades the grade), but both are tested because
 * the rule the owner approved names both, and a future change to the grading
 * must not silently loosen this.
 */
export function shouldPreTick(s: Suggestion): boolean {
  return s.suggested.length > 0 && s.confidence === "high" && !s.ambiguous && !s.amountOutlier;
}

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

/**
 * 🔵 "פרק N" — the ORDINAL, deliberately separate from parseExpectedEpisodes
 * above, which reads a COUNT. That confusion is precisely F13's bug: "פרק 8"
 * is episode eight, not eight episodes, and the count parser cannot tell them
 * apart because `פרק`/`פרקים` sit in GENERIC and a bare number is dropped by
 * tokens() — the episode number was invisible to the engine on both sides.
 *
 * Refuses anything that is not a single unambiguous ordinal:
 *   "2 פרקים"    → count, not an ordinal        → null
 *   "פרקים 8+9"  → a range                      → null
 *   "פרק 1 ו-2"  → covers two episodes, not one → null
 */
function parseEpisodeOrdinal(campaign: string): number | null {
  if (/פרקים/.test(campaign)) return null;
  if (/פרק\s*\d+\s*ו-?\s*\d/.test(campaign)) return null;
  const m = campaign.match(/פרק\s*(\d+)/);
  return m ? Number(m[1]) : null;
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
  const episodeOrdinal = parseEpisodeOrdinal(campaign);
  const amountOutlier = isAmountOutlier(job.amount, expectedEpisodes);

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
    ambiguous: false, amountOutlier, episodeMatch: null,
  });

  if (cands.length) {
    const top = cands[0];
    const ambiguous =
      cands.length > 1 &&
      cands[1].score >= top.score - 0.1 &&
      cands[1].campScore >= top.campScore &&
      cands[1].win.length > 0 === top.win.length > 0;
    const guests = top.win.filter(guestHit);
    // 🔵 F13 — the episode number outranks date proximity.
    //
    // The old tiebreak was `picked[0]`, and with no guest hit `picked` was
    // top.win sorted by |date distance|: the nearest recording won, full stop.
    // That is how "פרק 8" of חתונמיות was offered the 7.7 production (which is
    // episode 7, and another job's target) instead of the 9.7 one.
    //
    // An episode hit is checked FIRST and beats both the guest signal and the
    // date tiebreak, because it names the episode outright rather than
    // inferring it. Only a UNIQUE hit counts — two productions carrying the
    // same episode_no is a data problem, not a decision.
    const epHits =
      episodeOrdinal === null ? [] : top.win.filter((p) => p.episode_no === episodeOrdinal);
    if (epHits.length === 1) {
      return {
        jobId: job.id,
        confidence: ambiguous ? "medium" : "high",
        showId: top.show.id,
        suggested: [epHits[0].id],
        windowCandidates: top.win.map((p) => p.id),
        note:
          `מספר פרק תואם (${episodeOrdinal})` +
          (ambiguous ? `; תוכנית לא חד-משמעית (גם: ${cands[1].show.name})` : ""),
        multiEpisode, expectedEpisodes,
        ambiguous, amountOutlier, episodeMatch: episodeOrdinal,
      };
    }

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
        ambiguous, amountOutlier, episodeMatch: null,
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
      ambiguous: false, amountOutlier, episodeMatch: null,
    };
  }

  return none("לא זוהתה תוכנית — כנראה חיוב כללי");
}
