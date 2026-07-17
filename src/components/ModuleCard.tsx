import Link from "next/link";
import type { CSSProperties } from "react";
import IconTile, { type IconAccent } from "@/components/IconTile";
import type { ModuleMetric } from "@/modules/types";

const toneColor: Record<ModuleMetric["tone"], string> = {
  default: "var(--ink)",
  warn: "var(--warn)",
  peak: "var(--peak)",
  signal: "var(--signal)",
};

// Card accent = the semantic hue of the whole tile (DESIGN.md §4): a
// colored glass gradient, a colored border, and a matching corner glow orb.
// Debt and commitment are DIFFERENT colors because they're different things
// (DESIGN.md §2): finance=debt gets the violet→rose blend, contracts=open
// commitment gets cyan, radar=alerts gets rose.
type CardAccent = "violet" | "cyan" | "rose" | "debt" | "muted";

const CARD_ACCENTS: Record<
  Exclude<CardAccent, "muted">,
  { gradient: string; border: string; glow: string; hoverBorder: string; hoverShadow: string }
> = {
  violet: {
    gradient: "linear-gradient(135deg, rgba(139,92,246,0.20), rgba(30,20,55,0.42))",
    border: "rgba(192,132,252,0.30)",
    glow: "rgba(192,132,252,0.42)",
    hoverBorder: "var(--violet-light)",
    hoverShadow: "rgba(139,92,246,0.45)",
  },
  cyan: {
    gradient: "linear-gradient(135deg, rgba(56,189,248,0.18), rgba(18,28,48,0.42))",
    border: "rgba(56,189,248,0.30)",
    glow: "rgba(56,189,248,0.40)",
    hoverBorder: "var(--cyan)",
    hoverShadow: "rgba(56,189,248,0.42)",
  },
  rose: {
    gradient: "linear-gradient(135deg, rgba(251,113,133,0.20), rgba(45,18,32,0.42))",
    border: "rgba(251,113,133,0.32)",
    glow: "rgba(251,113,133,0.42)",
    hoverBorder: "var(--red)",
    hoverShadow: "rgba(251,113,133,0.45)",
  },
  // debt: violet→rose, the two-color blend that visually reads "money at risk"
  debt: {
    gradient: "linear-gradient(135deg, rgba(251,113,133,0.20), rgba(139,92,246,0.15), rgba(30,20,55,0.42))",
    border: "rgba(251,113,133,0.32)",
    glow: "rgba(251,113,133,0.42)",
    hoverBorder: "var(--red)",
    hoverShadow: "rgba(251,113,133,0.45)",
  },
};

// per-module theme: the card's semantic hue + the icon tile's hue (icon
// hues follow DESIGN.md §7, which don't all match the card semantics)
const MODULE_THEME: Record<string, { card: CardAccent; tile: IconAccent }> = {
  radar: { card: "rose", tile: "violet" },
  shows: { card: "cyan", tile: "cyan" },
  productions: { card: "violet", tile: "violet" },
  finance: { card: "debt", tile: "rose" },
  contracts: { card: "cyan", tile: "violet-light" },
  users: { card: "violet", tile: "violet" },
  settings: { card: "violet", tile: "violet" },
  archive: { card: "muted", tile: "muted" },
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
  const theme = MODULE_THEME[moduleKey] ?? { card: "violet" as CardAccent, tile: "violet" as IconAccent };
  const isEmpty = metric.value === "0";
  // a 0 / inactive module stays flat and gray (DESIGN.md §4) — no colored
  // gradient, no glow orb; archive is always muted for the same reason
  const showAccent = !isEmpty && theme.card !== "muted";
  const accent = showAccent ? CARD_ACCENTS[theme.card as Exclude<CardAccent, "muted">] : null;

  const style: CSSProperties = { animationDelay: `${index * 60}ms` };
  if (accent) {
    Object.assign(style, {
      background: accent.gradient,
      borderColor: accent.border,
      ["--card-accent"]: accent.hoverBorder,
      ["--card-glow-shadow"]: accent.hoverShadow,
    } as CSSProperties);
  }

  return (
    <Link
      href={href}
      // stagger entrance + float-up hover signature (DESIGN.md §5)
      className={`stagger float-card float-card-secondary group flex flex-col gap-3 ${
        isEmpty ? "glass-card-dim" : "glass-card-secondary"
      }`}
      style={style}
    >
      {/* corner glow orb — the mood-app signature, under the content */}
      {accent && <span className="corner-glow" style={{ ["--glow-color"]: accent.glow } as CSSProperties} />}

      <div className="glass-content flex flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <IconTile icon={icon} accent={isEmpty ? "muted" : theme.tile} />
          <span className="float-label font-bold text-sm">{title}</span>
        </div>
        <div>
          {/* calibrated number with a restrained violet halo (DESIGN.md §2) */}
          <div className="num-glow text-3xl font-medium font-mono" style={{ color: toneColor[metric.tone] }}>
            {metric.value}
          </div>
          <div className="text-xs text-[var(--faint)] mt-1">{metric.label}</div>
        </div>
      </div>
    </Link>
  );
}
