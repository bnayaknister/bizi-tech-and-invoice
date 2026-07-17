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

// glow orb + hover-shadow opacities softened ~35% from the first hi-fi pass
// (owner note: "indirect luxury lighting, not a neon tube"). The gradient
// fills and borders — the semantic hue itself — are untouched.
const CARD_ACCENTS: Record<
  Exclude<CardAccent, "muted">,
  { gradient: string; border: string; glow: string; hoverBorder: string; hoverShadow: string }
> = {
  violet: {
    gradient: "linear-gradient(135deg, rgba(139,92,246,0.20), rgba(30,20,55,0.42))",
    border: "rgba(192,132,252,0.30)",
    glow: "rgba(192,132,252,0.26)",
    hoverBorder: "var(--violet-light)",
    hoverShadow: "rgba(139,92,246,0.29)",
  },
  cyan: {
    gradient: "linear-gradient(135deg, rgba(56,189,248,0.18), rgba(18,28,48,0.42))",
    border: "rgba(56,189,248,0.30)",
    glow: "rgba(56,189,248,0.25)",
    hoverBorder: "var(--cyan)",
    hoverShadow: "rgba(56,189,248,0.27)",
  },
  rose: {
    gradient: "linear-gradient(135deg, rgba(251,113,133,0.20), rgba(45,18,32,0.42))",
    border: "rgba(251,113,133,0.32)",
    glow: "rgba(251,113,133,0.26)",
    hoverBorder: "var(--red)",
    hoverShadow: "rgba(251,113,133,0.29)",
  },
  // debt: violet→rose, the two-color blend that visually reads "money at risk"
  debt: {
    gradient: "linear-gradient(135deg, rgba(251,113,133,0.20), rgba(139,92,246,0.15), rgba(30,20,55,0.42))",
    border: "rgba(251,113,133,0.32)",
    glow: "rgba(251,113,133,0.26)",
    hoverBorder: "var(--red)",
    hoverShadow: "rgba(251,113,133,0.29)",
  },
};

// a 0 / inactive module is RESTING, not dead (owner note): same glass, a
// very-low-saturation violet tint, a faint violet border, and a small dim
// orb — alive frame, calm contents. It brightens on hover and, once its
// value is > 0, switches to the full accent above.
const RESTING = {
  gradient: "linear-gradient(135deg, rgba(139,92,246,0.075), rgba(30,20,55,0.30))",
  border: "rgba(139,92,246,0.16)",
  glow: "rgba(139,92,246,0.12)",
  hoverBorder: "rgba(139,92,246,0.4)",
  hoverShadow: "rgba(139,92,246,0.16)",
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
  const hasAccent = !isEmpty && theme.card !== "muted";
  const accent = hasAccent ? CARD_ACCENTS[theme.card as Exclude<CardAccent, "muted">] : null;

  // empty -> resting violet frame; accented -> full semantic hue; archive
  // (muted, non-empty) -> plain secondary glass, no orb
  const surface = accent ?? (isEmpty ? RESTING : null);

  const style: CSSProperties = { animationDelay: `${index * 60}ms` };
  if (surface) {
    Object.assign(style, {
      background: surface.gradient,
      borderColor: surface.border,
      ["--card-accent"]: surface.hoverBorder,
      ["--card-glow-shadow"]: surface.hoverShadow,
    } as CSSProperties);
  }

  // resting orb is smaller + dimmer than a live one
  const orbStyle: CSSProperties | null = surface
    ? ({ ["--glow-color"]: surface.glow, ...(isEmpty ? { width: 84, height: 84 } : {}) } as CSSProperties)
    : null;

  return (
    <Link
      href={href}
      // stagger entrance + float-up hover signature (DESIGN.md §5)
      className="stagger float-card float-card-secondary glass-card-secondary group flex flex-col gap-3"
      style={style}
    >
      {/* corner glow orb — the mood-app signature, under the content */}
      {orbStyle && <span className="corner-glow" style={orbStyle} />}

      <div className="glass-content flex flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <IconTile icon={icon} accent={isEmpty ? "muted" : theme.tile} />
          <span className="float-label font-bold text-sm">{title}</span>
        </div>
        <div>
          {/* calibrated number with a restrained violet halo (DESIGN.md §2);
              a resting 0 keeps a dim number even though its frame is alive */}
          <div
            className="num-glow text-3xl font-medium font-mono"
            style={{ color: isEmpty ? "var(--faint)" : toneColor[metric.tone] }}
          >
            {metric.value}
          </div>
          <div className="text-xs text-[var(--faint)] mt-1">{metric.label}</div>
        </div>
      </div>
    </Link>
  );
}
