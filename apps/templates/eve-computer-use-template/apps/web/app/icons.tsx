import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { readonly size?: number };

function Icon({ size = 16, children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 16 16"
      width={size}
      {...props}
    >
      {children}
    </svg>
  );
}

export const ArrowUp = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </Icon>
);

export const ChevronRight = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6 4 4 4-4 4" />
  </Icon>
);

export const ChevronDown = (props: IconProps) => (
  <Icon {...props}>
    <path d="m4 6 4 4 4-4" />
  </Icon>
);

export const Check = (props: IconProps) => (
  <Icon {...props}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Icon>
);

export const Cross = (props: IconProps) => (
  <Icon {...props}>
    <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
  </Icon>
);

export const Plus = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);

export const Lock = (props: IconProps) => (
  <Icon {...props}>
    <rect height="6.5" rx="1.5" width="9" x="3.5" y="7" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </Icon>
);

export const ArrowLeft = (props: IconProps) => (
  <Icon {...props}>
    <path d="M13 8H3M7.5 3.5 3 8l4.5 4.5" />
  </Icon>
);

export const ArrowRight = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 8h10M8.5 3.5 13 8l-4.5 4.5" />
  </Icon>
);

export const Refresh = (props: IconProps) => (
  <Icon {...props}>
    <path d="M13 8a5 5 0 1 1-1.46-3.54M13 3v2.5h-2.5" />
  </Icon>
);

export const Pointer = (props: IconProps) => (
  <Icon {...props}>
    <path d="m3.5 3 3.2 9.5 1.6-3.9 3.9-1.6L3.5 3Z" />
    <path d="m8.5 8.5 3.5 3.5" />
  </Icon>
);

export const Sparkle = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 2.5c.4 2.9 2.1 4.6 5 5-2.9.4-4.6 2.1-5 5-.4-2.9-2.1-4.6-5-5 2.9-.4 4.6-2.1 5-5Z" />
  </Icon>
);

export const Shield = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 2 3 4v3.5c0 3 2.1 5.4 5 6.5 2.9-1.1 5-3.5 5-6.5V4L8 2Z" />
    <path d="M8 5.5V8.5M8 10.75v.01" />
  </Icon>
);

export const Escalate = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 3v10M4.5 9.5 8 13l3.5-3.5" />
  </Icon>
);

export const Undo = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5.5 4 3 6.5 5.5 9" />
    <path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H7" />
  </Icon>
);

export const NewTab = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9.5 3H13v3.5M13 3 8 8M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5" />
  </Icon>
);

export const Unplug = (props: IconProps) => (
  <Icon {...props}>
    <path d="m3 13 2.5-2.5M10.5 5.5 13 3M6 7l3 3M5 6l-1.2 1.2a2.5 2.5 0 0 0 0 3.6l1.4 1.4a2.5 2.5 0 0 0 3.6 0L10 11M11 10l1.2-1.2a2.5 2.5 0 0 0 0-3.6l-1.4-1.4a2.5 2.5 0 0 0-3.6 0L6 5" />
  </Icon>
);

export const Monitor = (props: IconProps) => (
  <Icon {...props}>
    <rect height="8.5" rx="1.5" width="11" x="2.5" y="2.5" />
    <path d="M6 13.5h4M8 11v2.5" />
  </Icon>
);

export const Wrench = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9.8 2.7a3.2 3.2 0 0 0-3.9 4.1L2.6 10.1a1.4 1.4 0 0 0 2 2l3.3-3.3a3.2 3.2 0 0 0 4.1-3.9l-1.9 1.9-1.6-.4-.4-1.6 1.7-2.1Z" />
  </Icon>
);

export const Expand = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
  </Icon>
);

export const Collapse = (props: IconProps) => (
  <Icon {...props}>
    <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4" />
  </Icon>
);

export const Clock = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3l2 1.5" />
  </Icon>
);

/** Geist's 12-bar spinner. */
export function Spinner({ size = 16 }: { readonly size?: number }) {
  return (
    <span className="spinner" style={{ width: size, height: size }}>
      {Array.from({ length: 12 }, (_, index) => (
        <span
          key={index}
          style={{
            transform: `rotate(${index * 30}deg) translate(146%)`,
            animationDelay: `${-1.2 + index * 0.1}s`,
          }}
        />
      ))}
    </span>
  );
}

const TRIANGLE = [
  [12, 4.5],
  [9.6, 8.6],
  [14.4, 8.6],
  [7.2, 12.8],
  [12, 12.8],
  [16.8, 12.8],
  [4.8, 17],
  [9.6, 17],
  [14.4, 17],
  [19.2, 17],
] as const;
const RIPPLE_DELAYS = [0, 0.16, 0.16, 0.3, 0.3, 0.3, 0.41, 0.41, 0.41, 0.41];

/** Vercel's agent indicator: ten dots in a triangle that ripple while the agent works. */
export function AgentIndicator({
  size = 18,
  active = false,
}: {
  readonly size?: number;
  readonly active?: boolean;
}) {
  return (
    <svg
      aria-hidden="true"
      className={`agent-indicator ${active ? "agent-indicator-active" : ""}`}
      height={size}
      viewBox="0 0 24 21"
      width={size}
    >
      {TRIANGLE.map(([cx, cy], index) => (
        <circle
          cx={cx}
          cy={cy}
          key={index}
          r={1.25}
          style={{ animationDelay: `${RIPPLE_DELAYS[index]}s` }}
        />
      ))}
    </svg>
  );
}
