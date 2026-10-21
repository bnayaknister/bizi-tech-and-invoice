import type { Understood } from "@/lib/whatsapp/freetextMonitor";

// E14-3 — the list of messages the bot did not fully understand. A plain
// (server-renderable) component so the render test can count what it shows.

export type MissRow = {
  at: string;
  step: string;
  understood: Understood;
  /** the model's outcome, null when it was not asked */
  llm: string | null;
  text: string | null;
  reply: string | null;
};

const STEP_HE: Record<string, string> = {
  menu: "תפריט",
  duration: "משך",
  "studio-default": "אולפן קבוע",
  studio: "אולפן",
  day: "יום",
  hour: "שעה",
  summary: "סיכום",
};

export function FreeTextMissList({ rows }: { rows: MissRow[] | null | undefined }) {
  const list = rows ?? [];
  if (list.length === 0) return <div className="text-xs text-[var(--faint)]">אין הודעות כאלה.</div>;
  return (
    <ul className="space-y-3">
      {list.map((r, i) => (
        <li key={i} data-freetext-miss="" className="border-t border-[var(--rule)] pt-2 text-xs">
          <div className="text-[var(--faint)] mb-1">
            {r.at} · {STEP_HE[r.step] ?? r.step} · {r.understood === "none" ? "לא הובן" : "הובן חלקית"}
            {r.llm ? ` · LLM: ${r.llm}` : " · בלי LLM"}
          </div>
          <div className="mb-1">
            <span className="font-bold">הלקוח כתב: </span>
            <span dir="auto">{r.text ?? "—"}</span>
          </div>
          <div className="text-[var(--dim)]">
            <span className="font-bold">הבוט ענה: </span>
            <span dir="auto">{r.reply ?? "—"}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
