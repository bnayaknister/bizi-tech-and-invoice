import Link from "next/link";
import type { ModuleMetric } from "@/modules/types";

const toneColor: Record<ModuleMetric["tone"], string> = {
  default: "var(--ink)",
  warn: "var(--warn)",
  peak: "var(--peak)",
  signal: "var(--signal)",
};

export default function ModuleCard({
  title,
  icon,
  href,
  metric,
}: {
  title: string;
  icon: string;
  href: string;
  metric: ModuleMetric;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-3 p-5 rounded border border-[var(--rule)] bg-[var(--panel2)] hover:border-[var(--rule2)] hover:bg-[var(--panel3)] transition-colors"
    >
      <div className="flex items-center gap-2">
        <span className="text-xl">{icon}</span>
        <span className="font-bold text-sm">{title}</span>
      </div>
      <div>
        <div className="text-2xl font-black font-mono" style={{ color: toneColor[metric.tone] }}>
          {metric.value}
        </div>
        <div className="text-xs text-[var(--faint)] mt-0.5">{metric.label}</div>
      </div>
    </Link>
  );
}
