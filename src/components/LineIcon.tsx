// Custom thin-stroke line icons (DESIGN.md §4) — no emoji, ever. currentColor
// so an icon picks up its context (accent when active/hover). Pure component.
import type { CSSProperties } from "react";

type IconName =
  | "radar"
  | "shows"
  | "productions"
  | "finance"
  | "contracts"
  | "users"
  | "archive"
  | "search";

const PATHS: Record<IconName, React.ReactNode> = {
  // radar sweep: rings + a sweeping arm + blip
  radar: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 12 L18 7" />
      <circle cx="15.5" cy="9" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  // shows = waveform (podcast titles)
  shows: (
    <>
      <path d="M4 12 L4 12" />
      <path d="M4 10.5v3M7.3 7v10M10.6 9v6M13.9 5v14M17.2 8.5v7M20.5 11v2" />
    </>
  ),
  // productions = play triangle in a rounded frame
  productions: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M10.5 9.2 L15 12 L10.5 14.8 Z" fill="currentColor" stroke="none" />
    </>
  ),
  // finance = banknote
  finance: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6 9.5v5M18 9.5v5" />
    </>
  ),
  // contracts = document with folded corner + lines
  contracts: (
    <>
      <path d="M6 3.5h7L18.5 9v11.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
      <path d="M13 3.5V9h5.5" />
      <path d="M8 13h6M8 16.5h6" />
    </>
  ),
  // users = two people
  users: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <path d="M16 6.2a3 3 0 0 1 0 5.6" />
      <path d="M17 14.4c2.3.5 3.9 2.3 3.9 4.6" />
    </>
  ),
  // archive = box / drawer
  archive: (
    <>
      <path d="M3.5 7.5 5 4.5h14l1.5 3" />
      <rect x="3.5" y="7.5" width="17" height="12" rx="1.5" />
      <path d="M9.5 12h5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16 L20.5 20.5" />
    </>
  ),
};

export default function LineIcon({
  name,
  size = 18,
  className,
  style,
  strokeWidth = 1.5,
}: {
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  strokeWidth?: number;
}) {
  const content = PATHS[name as IconName];
  if (!content) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {content}
    </svg>
  );
}
