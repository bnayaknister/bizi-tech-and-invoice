import { normalizeForMatch } from "@/lib/calendar/match";

// ═══════════════════════════════════════════════════════════════════════════
// Warnings before "שלח לביקורת" (owner, 22.10). PURE and client-safe.
// ═══════════════════════════════════════════════════════════════════════════
//
// Two real mistakes in two days: a reel file sent to the episode slot
// (המניפה 14.10, 21.10) and another client's episode sent to the wrong show
// (סדרת חינוך ← "THE COMMUNICATORS - EP16 ROUGH CUT", 22.10). None of them is
// a refusal — every one can be legitimate — so each is a WARNING the sender
// must acknowledge ("לשלוח בכל זאת"). The server refuses a send that has
// warnings and no acknowledgement (versions.ts).

export type SendWarning = { code: "same-file" | "name-kind" | "name-other-show" | "folder-other-show"; text: string };

export type ShowForWarn = { id: string; name: string; aliases: string[] };

/** "REEL" / "ריל" in a name — a word, not a substring of another word */
const REEL_RE = /(?:^|[^a-zא-ת])(?:reels?|ריל|רילס|רילז)(?:[^a-zא-ת]|\d|$)/i;
/** "EP" / "פרק" / "episode" */
const EPISODE_RE = /(?:^|[^a-zא-ת])(?:ep|episode|פרק)(?:[^a-zא-ת]|\d|$)/i;

/** a name and a slot that disagree: REEL in the episode slot, or an episode-looking file in a reel slot */
export function nameKindWarning(fileName: string, kind: "episode" | "reel"): SendWarning | null {
  const n = fileName ?? "";
  if (kind === "episode" && REEL_RE.test(n)) {
    return { code: "name-kind", text: `בשם הקובץ כתוב "ריל" / REEL, והוא נשלח לשדה של הפרק.` };
  }
  if (kind === "reel" && !REEL_RE.test(n) && EPISODE_RE.test(n)) {
    return { code: "name-kind", text: `שם הקובץ נראה כמו פרק (EP / פרק), והוא נשלח לשדה של ריל.` };
  }
  return null;
}

/**
 * The names a show is recognised by in a file or folder name: its name, its
 * aliases, and the parts of an alias written "A - B" (so "עומר חן - The
 * Communicators" also answers to "The Communicators"). Shorter than 4
 * characters is too likely a coincidence.
 */
export function showKeys(s: ShowForWarn): string[] {
  const out = new Set<string>();
  for (const raw of [s.name, ...(s.aliases ?? [])]) {
    const whole = normalizeForMatch(raw);
    if (whole.length >= 4) out.add(whole);
    for (const part of whole.split(/\s+[-–—|]\s+/)) if (part.length >= 4) out.add(part.trim());
  }
  return Array.from(out);
}

/** separators in file names ("HAMENIFA_EP6-REEL1") read as spaces */
const flat = (s: string) => normalizeForMatch((s ?? "").replace(/[._\-–—]+/g, " "));

/** The show whose key is the LONGEST match in `text` — the sync's rule. */
export function showInText(text: string, shows: ShowForWarn[]): ShowForWarn | null {
  const t = ` ${flat(text)} `;
  let best: ShowForWarn | null = null;
  let len = 0;
  for (const s of shows) {
    for (const k of showKeys(s)) {
      const kk = flat(k);
      if (kk.length >= 4 && t.includes(kk) && kk.length > len) {
        best = s;
        len = kk.length;
      }
    }
  }
  return best;
}

/** another show's name in the file name — and not this show's own */
export function otherShowInName(fileName: string, shows: ShowForWarn[], ownShowId: string | null): SendWarning | null {
  const hit = showInText(fileName, shows);
  if (!hit || hit.id === ownShowId) return null;
  const own = shows.find((s) => s.id === ownShowId);
  if (own && showKeys(own).some((k) => ` ${flat(fileName)} `.includes(flat(k)))) return null;
  return { code: "name-other-show", text: `שם הקובץ מכיל את השם של תוכנית אחרת: "${hit.name}".` };
}

/**
 * The file's show folder — the first folder under BIZI PODCLUB — names
 * another show. A folder that names no known show says nothing.
 */
export function folderWarning(folderChain: string[], shows: ShowForWarn[], ownShowId: string | null): SendWarning | null {
  const showFolder = folderChain[0];
  if (!showFolder) return null;
  const hit = showInText(showFolder, shows);
  if (!hit || hit.id === ownShowId) return null;
  return { code: "folder-other-show", text: `הקובץ נמצא בתיקייה של תוכנית אחרת ב-Drive: "${showFolder}" (${hit.name}).` };
}

export type SameFileRow = {
  itemId: string;
  productionId: string;
  showId: string | null;
  showName: string | null;
  kind: string;
  reelIndex: number | null;
  recordDate: string | null;
  number: number | null;
};

const itemWord = (kind: string, reelIndex: number | null) => (kind === "reel" ? `ריל ${reelIndex ?? ""}`.trim() : "פרק");
const dm = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}` : "");

/** the same Drive file already sent: to another item of THIS production, or to a production of ANOTHER show */
export function sameFileWarnings(
  rows: SameFileRow[],
  target: { productionId: string; showId: string | null; itemId: string | null }
): SendWarning[] {
  const out: SendWarning[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (target.itemId && r.itemId === target.itemId) continue; // the same item: Q17's own refusal
    const sameProd = r.productionId === target.productionId;
    const otherShow = !!r.showId && r.showId !== target.showId;
    if (!sameProd && !otherShow) continue;
    const key = `${r.productionId}|${r.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const where = `${itemWord(r.kind, r.reelIndex)}${r.number ? ` v${r.number}` : ""}`;
    out.push({
      code: "same-file",
      text: sameProd
        ? `אותו קובץ כבר נשלח בהפקה הזאת ל${where}.`
        : `אותו קובץ כבר נשלח לתוכנית אחרת: ${r.showName ?? "—"}${r.recordDate ? ` ${dm(r.recordDate)}` : ""} (${where}).`,
    });
  }
  return out;
}

/** Hebrew label of the target, for the confirmation screen */
export function targetLabel(kind: "episode" | "reel", reelIndex: number | null): string {
  return kind === "reel" ? `ריל ${reelIndex}` : "פרק מלא";
}
