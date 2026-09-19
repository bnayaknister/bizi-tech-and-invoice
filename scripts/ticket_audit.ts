/**
 * צ'ק ליסט הטיקטים — נגזר מ-`docs/TICKETS.md` עצמו, בכל הרצה.
 *
 * Run:  npx tsx --tsconfig tsconfig.scripts.json scripts/ticket_audit.ts
 *       npx tsx --tsconfig tsconfig.scripts.json scripts/ticket_audit.ts > /tmp/audit.md
 *
 * ═══ למה סקריפט ולא מסמך ═══
 * `docs/TICKETS-AUDIT-2026-09-19.md` היה הראשון, והוא נכון ליום שנכתב בו
 * בלבד — **מסמך מתוארך מתיישן ברגע שנוגעים בלוח**. הוא נשמר כצילום היסטורי;
 * מכאן והלאה **הסקריפט הוא המקור**. הפלט הוא Markdown, כך שאפשר להפנות אותו
 * לקובץ ולהדביק לתוך הנדאוף.
 *
 * READ-ONLY BY CONSTRUCTION: אין כאן שום כתיבה — לא לקובץ, לא למסד.
 *
 * ═══ מה הוא בודק, ולמה דווקא את זה ═══
 * שלוש מתוך ארבע התקלות שנמצאו ידנית ב-19.9 הן מהסוג שסקריפט תופס בשנייה:
 *   · מזהה כפול (P7)
 *   · טיקט שמיגרציה סגרה והלוח עדיין אומר ⬜ (P10, P19)
 *   · ✅ בלי תאריך סגירה
 * הרביעית — T6, שמיגרציה **הזכירה** אך לא סגרה — אינה ניתנת להכרעה אוטומטית,
 * ולכן הסקריפט **מסמן לבדיקה** במקום להכריז על שגיאה. ההבדל הזה מכוון:
 * בדיקה שצועקת על מצב לגיטימי נהיית רעש, ואז מתעלמים ממנה.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const TICKETS = join(ROOT, "docs/TICKETS.md");
const MIGRATIONS = join(ROOT, "supabase/migrations");

/**
 * כפילויות מזהה שהוכרע להשאיר.
 *
 * `P7` — שני טיקטים שונים נושאים אותו: "מעגל סגירת הערות לקוח" (✅) ו"ליעד
 * הרמן 28.8" (⬜). **הכרעת בעלים 19.9: להשאיר.** שינוי מזהה שובר כל הפניה
 * קיימת בטיקטים, בהנדאופים ובהודעות הקומיט, והבלבול מוגבל לשני טיקטים.
 * רשום כאן ולא בקוד שבשתיקה מדלג — כדי שהחריג יהיה גלוי ולא ייעלם.
 */
const ACCEPTED_DUPLICATE_IDS = new Set(["P7"]);

type Ticket = { id: string; status: string; title: string; body: string; line: number };

const ID_RE = /^[A-Z]+\d+$/;

function parseTickets(): Ticket[] {
  const out: Ticket[] = [];
  const lines = readFileSync(TICKETS, "utf8").split("\n");
  lines.forEach((l, i) => {
    if (!l.startsWith("| ")) return;
    const p = l.split("|");
    if (p.length < 4) return;
    const id = p[1].trim();
    if (!ID_RE.test(id)) return;
    const body = p.slice(3).join("|");
    // הכותרת היא הקטע המודגש הראשון; אם אין — תחילת הגוף
    const m = /\*\*(.+?)\*\*/.exec(body);
    out.push({
      id,
      status: p[2].trim(),
      title: (m ? m[1] : body.trim()).slice(0, 100),
      body,
      line: i + 1,
    });
  });
  return out;
}

const isClosed = (t: Ticket) => t.status.startsWith("✅");
const closedOn = (t: Ticket) => {
  const m = /נסגר(?:ה)?\s+(\d{1,2}\.\d{1,2})/.exec(t.body);
  return m ? m[1] : "";
};
const marker = (t: Ticket) => (t.body.includes("🔴") ? "🔴" : t.body.includes("🟡") ? "🟡" : "");

/** איזה טיקט כל מיגרציה מצהירה עליו, דרך שדה `'ticket'` באירוע האודיט שלה. */
function migrationTickets(): Map<string, string[]> {
  const byTicket = new Map<string, string[]>();
  let files: string[] = [];
  try {
    files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    return byTicket; // אין תיקיית מיגרציות — לא שגיאה, פשוט אין מה להצליב
  }
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    const re = /'ticket',\s*'([A-Z]+\d+)'/g;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = re.exec(sql)) !== null) seen.add(m[1]);
    for (const tid of Array.from(seen)) {
      byTicket.set(tid, [...(byTicket.get(tid) ?? []), f.slice(0, 4)]);
    }
  }
  return byTicket;
}

function main() {
  const tickets = parseTickets();
  const byId = new Map<string, Ticket[]>();
  for (const t of tickets) byId.set(t.id, [...(byId.get(t.id) ?? []), t]);

  const problems: string[] = [];
  const verify: string[] = [];

  // ── כותרת ומניין ────────────────────────────────────────────────────────
  const hist = new Map<string, number>();
  for (const t of tickets) {
    const k = isClosed(t) ? "✅" : t.status.slice(0, 2).trim() || "?";
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  console.log(`# צ'ק ליסט טיקטים — ${new Date().toISOString().slice(0, 10)}`);
  console.log(`\n**נגזר מ-\`docs/TICKETS.md\` בזמן ההרצה.** ${tickets.length} שורות · ${byId.size} מזהים ייחודיים.\n`);
  console.log("| סטטוס | כמות |\n|---|---|");
  for (const [k, v] of Array.from(hist.entries()).sort((a, b) => b[1] - a[1])) console.log(`| ${k} | ${v} |`);

  // ── 1. מזהים כפולים ─────────────────────────────────────────────────────
  for (const [id, list] of Array.from(byId.entries())) {
    if (list.length < 2) continue;
    const where = list.map((t) => `שורה ${t.line} (${t.status.slice(0, 2)})`).join(" · ");
    if (ACCEPTED_DUPLICATE_IDS.has(id)) {
      verify.push(`**${id}** כפול — ${where}. **הוכרע להשאיר** (הכרעת בעלים 19.9): שינוי מזהה שובר הפניות קיימות`);
    } else {
      problems.push(`🔴 **מזהה כפול: ${id}** — ${where}. כל הפניה אליו דו-משמעית`);
    }
  }

  // ── 2. טיקט שמיגרציה מצהירה עליו והלוח אומר פתוח ────────────────────────
  const mig = migrationTickets();
  for (const [tid, files] of Array.from(mig.entries())) {
    const list = byId.get(tid);
    if (!list) {
      problems.push(`🔴 מיגרציה ${files.join(", ")} מצהירה על **${tid}** — טיקט שאינו קיים בלוח`);
      continue;
    }
    if (list.every((t) => !isClosed(t))) {
      verify.push(
        `**${tid}** מוצהר במיגרציה ${files.join(", ")} והלוח אומר \`${list[0].status.slice(0, 2)}\` — ` +
          `לוודא: האם המיגרציה סגרה את הטיקט, או רק פריט בתוכו? *(זה בדיוק המקרה של T6 מול 0092)*`
      );
    }
  }

  // ── 3. הפניות לטיקטים שאינם קיימים ──────────────────────────────────────
  const raw = readFileSync(TICKETS, "utf8");
  const refs = new Set<string>();
  const rr = /\*\*([A-Z]{1,2}\d{1,2})\*\*/g;
  let r: RegExpExecArray | null;
  while ((r = rr.exec(raw)) !== null) refs.add(r[1]);
  const dangling = Array.from(refs).filter((x) => !byId.has(x));
  if (dangling.length) problems.push(`🔴 הפניות לטיקטים שאינם קיימים: ${dangling.join(", ")}`);

  // ── 4. ✅ בלי תאריך, וסטטוס שנושא פרוזה ─────────────────────────────────
  const noDate = tickets.filter((t) => isClosed(t) && !closedOn(t)).map((t) => t.id);
  if (noDate.length) verify.push(`${noDate.length} טיקטים ✅ בלי תאריך סגירה בגוף: ${noDate.join(", ")}`);
  const prose = tickets.filter((t) => t.status.length > 3).map((t) => t.id);
  if (prose.length) verify.push(`${prose.length} תאי סטטוס נושאים פרוזה (שובר פרסינג): ${prose.join(", ")}`);

  // ── הדוח ────────────────────────────────────────────────────────────────
  console.log(`\n---\n\n## ${problems.length ? "🔴" : "✅"} תקלות (${problems.length})\n`);
  problems.forEach((p) => console.log(`- ${p}`));
  if (!problems.length) console.log("_אין._");

  console.log(`\n## ⚠️ לבדיקה ידנית (${verify.length})\n`);
  verify.forEach((v) => console.log(`- ${v}`));
  if (!verify.length) console.log("_אין._");

  // ── סגורים ──────────────────────────────────────────────────────────────
  const closed = tickets.filter(isClosed);
  console.log(`\n---\n\n## ✅ נסגרו (${closed.length})\n`);
  console.log("| # | כותרת | נסגר |\n|---|---|---|");
  // מיון כרונולוגי אמיתי: "18.8" → 818 ו-"1.9" → 901. השוואת מחרוזות הייתה
  // ממיינת 18.8 לפני 1.9, כי היא משווה תו-בתו ולא חודש-ואז-יום.
  const key = (t: Ticket) => {
    const d = closedOn(t);
    if (!d) return -1;
    const [day, month] = d.split(".").map(Number);
    return month * 100 + day;
  };
  for (const t of closed.sort((a, b) => key(b) - key(a))) {
    console.log(`| **${t.id}** | ${t.title} | ${closedOn(t) || "—"} |`);
  }

  // ── פתוחים, לפי סימון הכסף ──────────────────────────────────────────────
  const open = tickets.filter((t) => !isClosed(t));
  console.log(`\n---\n\n## ⬜ פתוחים (${open.length})\n`);
  for (const [mk, label] of [
    ["🔴", "נוגעים בכסף"],
    ["🟡", "נוגעים בכסף, אינם מדממים"],
    ["", "שאר הפתוחים"],
  ] as const) {
    const group = open.filter((t) => marker(t) === mk);
    if (!group.length) continue;
    console.log(`### ${mk} ${label} (${group.length})\n`);
    if (mk) {
      console.log("| # | סטטוס | כותרת |\n|---|---|---|");
      group.forEach((t) => console.log(`| **${t.id}** | ${t.status.slice(0, 2)} | ${t.title} |`));
    } else {
      console.log(group.map((t) => `${t.id}${t.status.startsWith("⬜") ? "" : ` ${t.status.slice(0, 2)}`}`).join(" · "));
    }
    console.log("");
  }

  // ── תלויות, כפי שהן כתובות בגוף ─────────────────────────────────────────
  console.log("---\n\n## 🔗 תלויות שנמצאו בטקסט\n");
  let found = 0;
  for (const t of tickets) {
    const m = /תלוי ב[־\-]?\s*\*{0,2}([A-Z]{1,2}\d{1,2})/.exec(t.body);
    if (!m) continue;
    const dep = byId.get(m[1]);
    const depState = dep ? (dep.some(isClosed) ? "✅" : "⬜") : "?";
    console.log(`- **${t.id}** ${t.status.slice(0, 2)} ← תלוי ב-**${m[1]}** ${depState}`);
    found++;
  }
  if (!found) console.log("_לא נמצאו._");

  console.log(`\n---\n\n_נוצר ע"י \`scripts/ticket_audit.ts\`. קריאה בלבד._`);
  process.exit(problems.length ? 1 : 0);
}

main();
