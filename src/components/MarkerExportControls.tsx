"use client";

import { useEffect, useState } from "react";
import { parseTimecodeOffset, framesToTimecode } from "@/lib/review/markerExport";

// E13-11 — "⬇ מרקרים ל-Premiere", next to an item's comments in the drawer
// (owner decisions 18.10). The file goes to the "Bizi · מרקרים" UXP panel,
// which adds the markers to the OPEN sequence; the XML is the no-install
// fallback (File › Import → a new sequence).
//
// The offset ("הסרט שלי מתחיל בטיימקוד:") is off by default (= 00:00:00:00).
// The browser remembers the editor's last choice — localStorage, every access
// in try/catch (a private window or blocked storage simply starts at the
// default). The same parser as the route validates it before the download.

const STORE_KEY = "bizi:markers:offset";

export default function MarkerExportControls({ productionId, itemId, hasComments }: { productionId: string; itemId: string; hasComments: boolean }) {
  const [on, setOn] = useState(false);
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<"open" | "all">("open");

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const v = JSON.parse(raw) as { on?: unknown; value?: unknown };
      if (typeof v.on === "boolean") setOn(v.on);
      if (typeof v.value === "string") setValue(v.value);
    } catch {
      /* storage unavailable — the default stands */
    }
  }, []);

  const remember = (next: { on: boolean; value: string }) => {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable — nothing to remember */
    }
  };

  const parsed = on ? parseTimecodeOffset(value) : ({ ok: true, frames: 0 } as const);
  const offset = on && parsed.ok ? value.trim() : "";
  const href = (format: "json" | "xml") =>
    `/api/productions/${encodeURIComponent(productionId)}/review-items/${encodeURIComponent(itemId)}/markers?format=${format}&scope=${scope}${offset ? `&offset=${encodeURIComponent(offset)}` : ""}`;
  const disabled = !hasComments || !parsed.ok;

  return (
    <div className="border border-[var(--rule)] rounded-lg p-2 mb-2 text-[12px] space-y-1.5" data-marker-export={itemId}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => {
              setOn(e.target.checked);
              remember({ on: e.target.checked, value });
            }}
          />
          <span>הסרט שלי מתחיל בטיימקוד:</span>
        </label>
        <input
          type="text"
          dir="ltr"
          inputMode="numeric"
          placeholder="00:00:00:00"
          value={value}
          disabled={!on}
          onChange={(e) => {
            setValue(e.target.value);
            remember({ on, value: e.target.value });
          }}
          className="w-28 bg-transparent border border-[var(--rule)] rounded px-1.5 py-0.5 disabled:opacity-40"
        />
        {on && parsed.ok && value.trim() && (
          <span className="text-[var(--faint)]" dir="ltr">
            = {framesToTimecode(parsed.frames)}
          </span>
        )}
      </div>
      {!parsed.ok && <div className="text-[var(--red)]">{parsed.error}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value === "all" ? "all" : "open")}
          className="bg-transparent border border-[var(--rule)] rounded px-1 py-0.5"
        >
          <option value="open">שלא טופלו, בגרסה האחרונה</option>
          <option value="all">הכול (כולל שטופלו)</option>
        </select>
        <a
          href={disabled ? undefined : href("json")}
          aria-disabled={disabled}
          className={`font-bold rounded px-2 py-0.5 border border-[var(--rule)] ${disabled ? "opacity-40 pointer-events-none" : "hover:bg-[var(--panel3)]"}`}
        >
          ⬇ מרקרים ל-Premiere
        </a>
        <a
          href={disabled ? undefined : href("xml")}
          aria-disabled={disabled}
          className={`text-[var(--dim)] underline ${disabled ? "opacity-40 pointer-events-none" : ""}`}
          title="בלי פאנל: File › Import ב-Premiere. המרקרים נוחתים ברצף חדש"
        >
          XML (גיבוי)
        </a>
        <a href="/downloads/bizi-markers.ccx" className="text-[var(--faint)] underline mr-auto" title="התקנה חד-פעמית של הפאנל ב-Premiere 26">
          התקנת הפאנל
        </a>
      </div>
    </div>
  );
}
