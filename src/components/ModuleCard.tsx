import Link from "next/link";
import LineIcon from "@/components/LineIcon";
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
  index = 0,
}: {
  title: string;
  icon: string;
  href: string;
  metric: ModuleMetric;
  index?: number;
}) {
  return (
    <Link
      href={href}
      // stagger: each card rises in sequence on load (DESIGN.md §6)
      className="stagger lift group flex flex-col gap-3 p-5 rounded-lg border border-[var(--rule)] bg-[var(--panel2)]"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="flex items-center gap-2.5">
        <span className="text-[var(--dim)] group-hover:text-[var(--violet-light)] transition-colors">
          <LineIcon name={icon} size={20} />
        </span>
        <span className="font-bold text-sm">{title}</span>
      </div>
      <div>
        {/* calibrated number with a restrained violet halo (DESIGN.md §3.3) */}
        <div
          className="num-glow text-3xl font-medium font-mono tracking-tight"
          style={{ color: toneColor[metric.tone] }}
        >
          {metric.value}
        </div>
        <div className="text-xs text-[var(--faint)] mt-1">{metric.label}</div>
      </div>
    </Link>
  );
}
