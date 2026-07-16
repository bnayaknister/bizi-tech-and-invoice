// The brand signature (DESIGN.md §3.1): a live VU-meter wordmark. Bars are
// violet/cyan electric with a violet drop-shadow. `animated` makes them
// dance (hub + login only); everywhere else it renders static so working
// screens stay calm. Pure component (no hooks) — safe in server components.
const BARS = [
  { x: 2, y: 8, h: 8, fill: "var(--violet-light)", delay: "0s" },
  { x: 6.5, y: 4, h: 16, fill: "var(--violet)", delay: "0.18s" },
  { x: 11, y: 1, h: 22, fill: "var(--cyan)", delay: "0.36s" },
  { x: 15.5, y: 5, h: 14, fill: "var(--violet)", delay: "0.54s" },
  { x: 20, y: 9, h: 6, fill: "var(--violet-light)", delay: "0.72s" },
];

export default function SoundWaveLogo({
  size = 22,
  animated = false,
}: {
  size?: number;
  animated?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ filter: "drop-shadow(0 0 5px rgba(124, 92, 255, 0.55))" }}
    >
      <g className={animated ? "vu-live" : undefined}>
        {BARS.map((b) => (
          <rect
            key={b.x}
            className="vu-bar"
            x={b.x}
            y={b.y}
            width="2"
            height={b.h}
            rx="1"
            fill={b.fill}
            style={{ animationDelay: b.delay }}
          />
        ))}
      </g>
    </svg>
  );
}
