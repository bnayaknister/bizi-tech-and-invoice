import type { CSSProperties } from "react";
import LineIcon from "@/components/LineIcon";

// Geometric gradient icon tile (DESIGN.md §7): 34x34, rounded 11px, a
// colored gradient with a matching colored shadow — the module-card and
// header icon treatment everywhere. `muted` = archive's gray/secondary case.
export type IconAccent = "violet" | "violet-light" | "cyan" | "rose" | "muted";

// colored tile shadows softened ~25% from the first hi-fi pass — the tiles
// still lift off the glass, just without the neon halo (owner note)
const ACCENTS: Record<Exclude<IconAccent, "muted">, { a: string; b: string; shadow: string }> = {
  violet: { a: "var(--violet)", b: "var(--violet-dk)", shadow: "rgba(139, 92, 246, 0.34)" },
  "violet-light": { a: "var(--violet-light)", b: "var(--violet)", shadow: "rgba(192, 132, 252, 0.30)" },
  cyan: { a: "var(--cyan)", b: "var(--cyan-dk)", shadow: "rgba(56, 189, 248, 0.30)" },
  rose: { a: "var(--red)", b: "var(--red-dk)", shadow: "rgba(251, 113, 133, 0.30)" },
};

export default function IconTile({
  icon,
  accent = "violet",
  size = 34,
  iconSize = 18,
}: {
  icon: string;
  accent?: IconAccent;
  size?: number;
  iconSize?: number;
}) {
  const muted = accent === "muted";
  const style: CSSProperties = muted
    ? { width: size, height: size }
    : {
        width: size,
        height: size,
        ["--tile-a" as string]: ACCENTS[accent].a,
        ["--tile-b" as string]: ACCENTS[accent].b,
        ["--tile-shadow" as string]: ACCENTS[accent].shadow,
      };
  return (
    <span className={`icon-tile ${muted ? "icon-tile-muted" : ""}`} style={style}>
      <LineIcon name={icon} size={iconSize} />
    </span>
  );
}
