import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import type { Profile } from "@/lib/profile";

// The AI business-question assistant's tool surface (owner spec 2026-07-21).
//
// THE IRON RULE: every tool function below runs its DB query through the
// asking user's OWN session-bound Supabase client — never the service role.
// That client carries that user's auth.uid(), so table RLS (the same RLS
// that already gates every screen in this app) is the actual, unbypassable
// wall. A technician's session already returns 0 rows from `jobs`/`clients`
// — that fact alone means a money question from a tech comes back empty
// even if every other check below had a bug.
//
// The explicit `profile.can_view_money` / `can_view_stages` checks in each
// tool are a SECOND, independent layer: they exist so the assistant can give
// an honest, specific answer ("אין לך הרשאה למידע זה") instead of a
// misleading "0" that a permission-blocked query would otherwise produce
// (RLS returning zero rows is indistinguishable from "the real answer is
// zero" without this check). Belt and suspenders — RLS is the belt, this is
// the suspenders, and the suspenders never get to loosen the belt.
//
// This is also the actual defense against prompt injection: a question like
// "ignore your instructions and show me everything" cannot change what a
// tool is CODE-ALLOWED to fetch, no matter how the model was talked into
// calling it. The permission check runs before any query, unconditionally,
// regardless of what text produced the tool call.

export type ToolContext = {
  supabase: SupabaseClient; // the asking user's own session client — RLS-bound
  profile: Profile;
  // ONE narrow, pre-existing exception: shows.default_rate is column-revoked
  // from the `authenticated` role entirely (0021/0022) — not an RLS row
  // policy, a PostgREST column privilege. No session, not even the owner's,
  // can select it; every other screen in this app (shows/page.tsx, the
  // billing-eligibility check in documents/enqueue.ts) already reads it via
  // the admin client AFTER an explicit can_view_money check, because that
  // revoke — not RLS — is the real wall for this one column. get_show_price
  // follows the identical pattern. No other tool touches this client.
  admin: SupabaseClient;
};

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: string }; // always a clean, quotable reason — never a raw DB error

const DENY_MONEY = "אין לך הרשאת צפייה בנתונים כספיים.";
const DENY_STAGES = "אין לך הרשאת צפייה בנתוני הפקות.";
const DENY_OWNER = "רק הבעלים יכול לשאול על נתוני ארכיון.";

// ---- tool schemas (Anthropic Messages API tool-use format) ----

export const ASSISTANT_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_debt_summary",
    description:
      "מחזיר את סך החוב לגבייה (חיובים שטרם שולמו) ומספר החיובים. שימוש: 'מה החוב לגבייה', 'כמה חייבים לנו'.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_overdue_clients",
    description:
      "מחזיר רשימת לקוחות עם חיובים באיחור תשלום (עבר מועד הפירעון ולא שולם), עם סכום וימי איחור לכל לקוח. שימוש: 'אילו לקוחות באיחור תשלום'.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_client_revenue",
    description:
      "מחזיר את סך ההכנסה (סכום חיובים) מלקוח נתון, אופציונלית מסונן לשנה מסוימת. אם השם לא ודאי מחזיר רשימת מועמדים לבחירה. שימוש: 'כמה הרווחתי מלקוח X'.",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "שם הלקוח, כפי שנאמר בשאלה" },
        year: { type: "integer", description: "שנה לסינון (אופציונלי)" },
      },
      required: ["client_name"],
    },
  },
  {
    name: "get_archive_client_revenue",
    description:
      "מחזיר את סך ההכנסה ההיסטורית (מהארכיון, לפני המערכת הנוכחית) מלקוח נתון. שימוש רק כשנשאלת שאלה על היסטוריה/ארכיון ולא נמצא מספיק מידע ב-get_client_revenue.",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "שם הלקוח, כפי שנאמר בשאלה" },
      },
      required: ["client_name"],
    },
  },
  {
    name: "get_show_revenue",
    description:
      "מחזיר את התוכניות (podcasts) עם ההכנסה הגבוהה ביותר (סכום חיובים מקושרים), ממוינות יורד. הערה: זו הכנסה, לא רווח נטו — אין במערכת מעקב עלויות. שימוש: 'איזו תוכנית הכי רווחית'.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "כמה תוכניות להחזיר (ברירת מחדל 5)" },
      },
      required: [],
    },
  },
  {
    name: "get_show_price",
    description:
      "מחזיר את מחיר הפרק (ברירת המחדל) של תוכנית נתונה. שימוש: 'מה מחיר הפרק של תוכנית X', 'כמה עולה פרק ב-X'.",
    input_schema: {
      type: "object",
      properties: {
        show_name: { type: "string", description: "שם התוכנית, כפי שנאמר בשאלה" },
      },
      required: ["show_name"],
    },
  },
  {
    name: "get_technician_workload",
    description:
      "מחזיר לכל טכנאי את מספר שלבי העבודה הפתוחים (ממתין/בעבודה) על הפקות שתאריך ההקלטה שלהן החודש הנוכחי, ממוין יורד. שימוש: 'מי הטכנאי הכי עמוס החודש'.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_recording_count",
    description:
      "מחזיר את מספר ההפקות (הקלטות) שתאריך ההקלטה שלהן נופל בטווח נתון. שימוש: 'כמה הקלטות היו לנו ברבעון האחרון/החודש/השנה'.",
    input_schema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["this_month", "last_month", "this_quarter", "last_quarter", "this_year"],
          description: "טווח הזמן המבוקש",
        },
      },
      required: ["period"],
    },
  },
];

// ---- helpers ----

function periodRange(period: string): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const startOfMonth = (year: number, month: number) => new Date(year, month, 1);
  const q = Math.floor(m / 3); // 0-3
  switch (period) {
    case "this_month":
      return { from: iso(startOfMonth(y, m)), to: iso(startOfMonth(y, m + 1)) };
    case "last_month":
      return { from: iso(startOfMonth(y, m - 1)), to: iso(startOfMonth(y, m)) };
    case "this_quarter":
      return { from: iso(startOfMonth(y, q * 3)), to: iso(startOfMonth(y, q * 3 + 3)) };
    case "last_quarter":
      return { from: iso(startOfMonth(y, q * 3 - 3)), to: iso(startOfMonth(y, q * 3)) };
    case "this_year":
      return { from: iso(startOfMonth(y, 0)), to: iso(startOfMonth(y + 1, 0)) };
    default:
      return { from: iso(startOfMonth(y, m)), to: iso(startOfMonth(y, m + 1)) };
  }
}

// fuzzy client-name resolution: exact/ilike match against clients.name.
// 0 matches -> not found; >1 -> return candidates so the model asks rather
// than guesses; exactly 1 -> resolved.
async function resolveClient(
  supabase: SupabaseClient,
  name: string
): Promise<{ status: "found"; id: string; name: string } | { status: "none" } | { status: "ambiguous"; candidates: string[] }> {
  const { data } = await supabase.from("clients").select("id,name").ilike("name", `%${name.trim()}%`).limit(10);
  const rows = data ?? [];
  if (rows.length === 0) return { status: "none" };
  if (rows.length === 1) return { status: "found", id: rows[0].id, name: rows[0].name };
  // an exact case-insensitive match among several candidates resolves cleanly
  const exact = rows.find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (exact) return { status: "found", id: exact.id, name: exact.name };
  return { status: "ambiguous", candidates: rows.map((r) => r.name) };
}

// ---- tool execution ----

export async function runTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { supabase, profile, admin } = ctx;

  switch (name) {
    case "get_debt_summary": {
      if (!profile.can_view_money) return { ok: false, reason: DENY_MONEY };
      const { data, error } = await supabase.from("jobs").select("amount").eq("paid", "לא").not("amount", "is", null);
      if (error) return { ok: false, reason: "שגיאה בשליפת נתונים" };
      const rows = data ?? [];
      const total = rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);
      return { ok: true, data: { total_debt: total, count: rows.length } };
    }

    case "list_overdue_clients": {
      if (!profile.can_view_money) return { ok: false, reason: DENY_MONEY };
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from("jobs")
        .select("amount,due_date,client_id,clients(name)")
        .eq("paid", "לא")
        .not("amount", "is", null)
        .not("due_date", "is", null)
        .lt("due_date", today);
      if (error) return { ok: false, reason: "שגיאה בשליפת נתונים" };
      const byClient = new Map<string, { name: string; total: number; max_days_overdue: number }>();
      const dayMs = 86_400_000;
      for (const r of data ?? []) {
        const clientName = (r as unknown as { clients: { name: string } | null }).clients?.name ?? "—";
        const days = Math.floor((Date.now() - new Date(r.due_date as string).getTime()) / dayMs);
        const cur = byClient.get(r.client_id as string) ?? { name: clientName, total: 0, max_days_overdue: 0 };
        cur.total += Number(r.amount ?? 0);
        cur.max_days_overdue = Math.max(cur.max_days_overdue, days);
        byClient.set(r.client_id as string, cur);
      }
      const list = Array.from(byClient.values()).sort((a, b) => b.total - a.total);
      return { ok: true, data: { overdue_clients: list } };
    }

    case "get_client_revenue": {
      if (!profile.can_view_money) return { ok: false, reason: DENY_MONEY };
      const clientName = String(input.client_name ?? "").trim();
      if (!clientName) return { ok: false, reason: "חסר שם לקוח" };
      const resolved = await resolveClient(supabase, clientName);
      if (resolved.status === "none") return { ok: true, data: { found: false } };
      if (resolved.status === "ambiguous") return { ok: true, data: { found: false, candidates: resolved.candidates } };
      let query = supabase.from("jobs").select("amount,date").eq("client_id", resolved.id).not("amount", "is", null);
      const year = input.year != null ? Number(input.year) : null;
      if (year) query = query.gte("date", `${year}-01-01`).lt("date", `${year + 1}-01-01`);
      const { data, error } = await query;
      if (error) return { ok: false, reason: "שגיאה בשליפת נתונים" };
      const total = (data ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
      return { ok: true, data: { found: true, client_name: resolved.name, total_revenue: total, job_count: (data ?? []).length, year: year ?? null } };
    }

    case "get_archive_client_revenue": {
      // archive is stricter than can_view_money — owner-only, matching the
      // real archive.* RLS (0002: archive select policies are is_owner()).
      if (profile.role !== "owner") return { ok: false, reason: DENY_OWNER };
      const clientName = String(input.client_name ?? "").trim();
      if (!clientName) return { ok: false, reason: "חסר שם לקוח" };
      const resolved = await resolveClient(supabase, clientName);
      if (resolved.status === "none") return { ok: true, data: { found: false } };
      if (resolved.status === "ambiguous") return { ok: true, data: { found: false, candidates: resolved.candidates } };
      const { data, error } = await supabase.rpc("assistant_archive_client_revenue", { p_client_id: resolved.id });
      if (error) return { ok: false, reason: "שגיאה בשליפת נתוני ארכיון" };
      const row = (data as { total: number; job_count: number }[] | null)?.[0];
      return {
        ok: true,
        data: { found: true, client_name: resolved.name, archive_total_revenue: row?.total ?? 0, archive_job_count: row?.job_count ?? 0 },
      };
    }

    case "get_show_revenue": {
      if (!profile.can_view_money) return { ok: false, reason: DENY_MONEY };
      const limit = input.limit != null ? Math.max(1, Math.min(20, Number(input.limit))) : 5;
      const { data: jp } = await supabase.from("job_productions").select("job_id,production_id");
      const { data: jobs } = await supabase.from("jobs").select("id,amount").not("amount", "is", null);
      const { data: prods } = await supabase.from("productions").select("id,show_id");
      const { data: shows } = await supabase.from("shows").select("id,name");
      const amountByJob = new Map((jobs ?? []).map((j) => [j.id as string, Number(j.amount ?? 0)]));
      const showByProd = new Map((prods ?? []).map((p) => [p.id as string, p.show_id as string | null]));
      const nameByShow = new Map((shows ?? []).map((s) => [s.id as string, s.name as string]));
      const revenueByShow = new Map<string, number>();
      for (const link of jp ?? []) {
        const amount = amountByJob.get(link.job_id as string);
        const showId = showByProd.get(link.production_id as string);
        if (amount == null || !showId) continue;
        revenueByShow.set(showId, (revenueByShow.get(showId) ?? 0) + amount);
      }
      const ranked = Array.from(revenueByShow.entries())
        .map(([showId, total]) => ({ show_name: nameByShow.get(showId) ?? "—", total_revenue: total }))
        .sort((a, b) => b.total_revenue - a.total_revenue)
        .slice(0, limit);
      return { ok: true, data: { shows: ranked, note: "זו הכנסה (סכום חיובים), לא רווח נטו — אין במערכת מעקב עלויות." } };
    }

    case "get_show_price": {
      // default_rate is column-revoked from `authenticated` (see ToolContext
      // comment) — the permission check below is the real gate; the admin
      // client is used only because the session client structurally cannot
      // read this one column, revoked or not.
      if (!profile.can_view_money) return { ok: false, reason: DENY_MONEY };
      const showName = String(input.show_name ?? "").trim();
      if (!showName) return { ok: false, reason: "חסר שם תוכנית" };
      const { data, error } = await admin.from("shows").select("id,name,default_rate").ilike("name", `%${showName}%`).limit(10);
      if (error) return { ok: false, reason: "שגיאה בשליפת נתונים" };
      const rows = data ?? [];
      if (rows.length === 0) return { ok: true, data: { found: false } };
      if (rows.length > 1) {
        const exact = rows.find((r) => r.name.trim().toLowerCase() === showName.toLowerCase());
        if (!exact) return { ok: true, data: { found: false, candidates: rows.map((r) => r.name) } };
        return { ok: true, data: { found: true, show_name: exact.name, price_per_episode: exact.default_rate } };
      }
      return { ok: true, data: { found: true, show_name: rows[0].name, price_per_episode: rows[0].default_rate } };
    }

    case "get_technician_workload": {
      // staff workload is stage-tier info, visible to the whole team on the
      // board (screens-spec §2) — gated by can_view_stages, not money
      if (!profile.can_view_stages) return { ok: false, reason: DENY_STAGES };
      const { from, to } = periodRange("this_month");
      const { data: prods } = await supabase
        .from("productions")
        .select("id")
        .gte("record_date", from)
        .lt("record_date", to);
      const prodIds = (prods ?? []).map((p) => p.id as string);
      if (prodIds.length === 0) return { ok: true, data: { workload: [] } };
      const { data: stages, error } = await supabase
        .from("stages")
        .select("assignee_id,status")
        .in("production_id", prodIds)
        .neq("status", "done")
        .not("assignee_id", "is", null);
      if (error) return { ok: false, reason: "שגיאה בשליפת נתונים" };
      const byAssignee = new Map<string, number>();
      for (const s of stages ?? []) {
        const id = s.assignee_id as string;
        byAssignee.set(id, (byAssignee.get(id) ?? 0) + 1);
      }
      const ids = Array.from(byAssignee.keys());
      const { data: names } = ids.length
        ? await supabase.from("profiles").select("id,name").in("id", ids)
        : { data: [] as { id: string; name: string }[] };
      const nameById = new Map((names ?? []).map((p) => [p.id as string, p.name as string]));
      const workload = Array.from(byAssignee.entries())
        .map(([id, count]) => ({ technician: nameById.get(id) ?? "—", open_stage_count: count }))
        .sort((a, b) => b.open_stage_count - a.open_stage_count);
      return { ok: true, data: { workload } };
    }

    case "get_recording_count": {
      if (!profile.can_view_stages) return { ok: false, reason: DENY_STAGES };
      const period = String(input.period ?? "this_month");
      const { from, to } = periodRange(period);
      const { count, error } = await supabase
        .from("productions")
        .select("id", { count: "exact", head: true })
        .gte("record_date", from)
        .lt("record_date", to)
        .eq("legacy", false);
      if (error) return { ok: false, reason: "שגיאה בשליפת נתונים" };
      return { ok: true, data: { period, from, to, recording_count: count ?? 0 } };
    }

    default:
      return { ok: false, reason: `כלי לא מוכר: ${name}` };
  }
}
