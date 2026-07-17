import Link from "next/link";
import IconTile, { type IconAccent } from "@/components/IconTile";
import type { ModuleMetric } from "@/modules/types";

const toneColor: Record<ModuleMetric["tone"], string> = {
  default: "var(--ink)",
  warn: "var(--warn)",
  peak: "var(--peak)",
  signal: "var(--signal)",
};

// module -> icon accent (DESIGN.md §7); anything not called out explicitly
// there just takes the primary violet
const MODULE_ACCENT: Record<string, IconAccent> = {
  productions: "violet",
  shows: "cyan",
  contracts: "violet-light",
  archive: "muted",
};

const ACCENT_VARS: Record<Exclude<IconAccent, "muted">, { border: string; shadow: string }> = {
  violet: { border: "var(--violet-light)", shadow: "rgba(139, 92, 246, 0.4)" },
  "violet-light": { border: "var(--violet-light)", shadow: "rgba(192, 132, 252, 0.4)" },
  cyan: { border: "var(--cyan)", shadow: "rgba(56, 189, 248, 0.4)" },
  rose: { border: "var(--red)", shadow: "rgba(251, 113, 133, 0.4)" },
};

export default function ModuleCard({
  moduleKey,
  title,
  icon,
  href,
  metric,
  index = 0,
}: {
  moduleKey: string;
  title: string;
  icon: string;
  href: string;
  metric: ModuleMetric;
  index?: number;
}) {
  const accent = MODULE_ACCENT[moduleKey] ?? "violet";
  const isEmpty = metric.value === "0";
  const accentVars = accent !== "muted" ? ACCENT_VARS[accent] : null;

  return (
    <Link
      href={href}
      // stagger: each card rises in sequence on load (DESIGN.md §5)
      className={`stagger float-card float-card-secondary group flex flex-col gap-3 ${
        isEmpty ? "glass-card-dim" : "glass-card-secondary"
      }`}
      style={{
        animationDelay: `${index * 60}ms`,
        ...(accentVars && !isEmpty
          ? ({
              ["--card-accent" as string]: accentVars.border,
              ["--card-glow-shadow" as string]: accentVars.shadow,
            } as React.CSSProperties)
          : {}),
      }}
    >
      <div className="flex items-center gap-2.5">
        <IconTile icon={icon} accent={isEmpty ? "muted" : accent} />
        <span className="float-label font-bold text-sm">{title}</span>
      </div>
      <div>
        {/* calibrated number with a restrained violet halo (DESIGN.md §2) */}
        <div
          className="num-glow text-3xl font-medium font-mono"
          style={{ color: toneColor[metric.tone] }}
        >
          {metric.value}
        </div>
        <div className="text-xs text-[var(--faint)] mt-1">{metric.label}</div>
      </div>
    </Link>
  );
}
