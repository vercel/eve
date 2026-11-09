import { IconChevronRightSmall } from "@vercel/geistdocs/assets/icons";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

// The homepage visuals follow vercel.com's enterprise control visuals: set straight in a 16:9
// frame, black, white, and gray, thin lines, one black label. Each is drawn on a 320 × 180
// canvas and scaled with the frame through `cqw` sizes (16px type at a 360px frame).
export const view = { width: 320, height: 180 };

// Slack and Teams have no single-color simple icon, so their brand marks take the text color;
// Teams' white letter takes the background color so it stays cut out.
export const monochromeLogo = "[&_path]:fill-current [&_path[fill=white]]:fill-background-100";

export function pct(value: number, total: number) {
  return `${(value / total) * 100}%`;
}

/** The 16:9 frame a visual renders in: an optional SVG scene on the canvas with HTML over it. */
export function Visual({
  caption,
  children,
  scene,
}: {
  caption: string;
  children?: ReactNode;
  scene?: ReactNode;
}): JSX.Element {
  return (
    <figure className="@container relative m-0 aspect-video w-full overflow-hidden">
      {scene ? (
        <svg
          aria-hidden
          className="absolute inset-0 size-full"
          fill="none"
          viewBox={`0 0 ${view.width} ${view.height}`}
        >
          {scene}
        </svg>
      ) : null}
      {children}
      <figcaption className="sr-only">{caption}</figcaption>
    </figure>
  );
}

/** The one black label a visual may carry, centered on a canvas point. */
export function Label({ children, x, y }: { children: ReactNode; x: number; y: number }) {
  return (
    <span
      aria-hidden
      className="absolute -translate-1/2 whitespace-nowrap rounded-[0.45em] bg-gray-1000 px-[0.55em] py-[0.2em] font-medium text-[3.05cqw] text-background-100 leading-[1.45]"
      style={{ left: pct(x, view.width), top: pct(y, view.height) }}
    >
      {children}
    </span>
  );
}

/** A dashed line that fades out at both ends. */
export function LimitLine({ id, x, y1, y2 }: { id: string; x: number; y1: number; y2: number }) {
  return (
    <>
      <defs>
        <linearGradient gradientUnits="userSpaceOnUse" id={id} x1={x} x2={x} y1={y1} y2={y2}>
          <stop stopColor="var(--ds-gray-1000)" stopOpacity="0" />
          <stop offset="0.14" stopColor="var(--ds-gray-1000)" />
          <stop offset="0.86" stopColor="var(--ds-gray-1000)" />
          <stop offset="1" stopColor="var(--ds-gray-1000)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`M${x} ${y1}V${y2}`} stroke={`url(#${id})`} strokeDasharray="3 3" />
    </>
  );
}

/** Geist's small gray low-contrast badge, in `em` so it scales with the frame. */
export function GrayBadge({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <span className="inline-flex h-[1.75em] shrink-0 items-center gap-[0.375em] rounded-full bg-gray-200 px-[0.75em] font-medium text-[0.625em] text-gray-1000 tracking-[0.2px] [&>svg]:size-[1.1em]">
      {icon}
      {children}
    </span>
  );
}

/**
 * A list set straight in the frame: inset 8% plus a 1em gutter from the left and as far from
 * the top, a gray header, then rows under a top rule with dividers between them, the rules
 * fading out toward the right edge.
 */
export function RuledList({ children, header }: { children: ReactNode; header: ReactNode }) {
  return (
    <div className="absolute top-[calc(8cqw+1em)] right-0 left-[8%] select-none pl-[1em] text-[4.4cqw]">
      <div className="flex flex-col gap-[1.25em]">
        <span className="flex h-[0.8125em] items-center gap-[0.5em] text-[0.8125em] text-gray-900 leading-none">
          {header}
        </span>
        <ul className="m-0 flex list-none flex-col divide-y divide-gray-alpha-400 border-gray-alpha-400 border-t p-0 [mask-image:linear-gradient(to_right,black_55%,transparent_92%)]">
          {children}
        </ul>
      </div>
    </div>
  );
}

// A row's height without the divider, which `divide-y` adds on top.
export const ruledRow = "box-content flex h-[1.25em] items-center py-[0.5em]";

/** A feature item: an optional bordered visual, then icon, title, and description. */
export function FeatureCard({
  title,
  href,
  icon,
  children,
  visual,
  className,
}: {
  title: string;
  href: string;
  icon: ReactNode;
  children: ReactNode;
  visual?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <li className={cn("min-w-0", className)}>
      <Link className="group flex flex-col gap-3" href={href} prefetch={true}>
        {visual ? (
          <div className="relative mb-5 overflow-hidden rounded-xs border border-gray-300">
            {visual}
          </div>
        ) : null}
        <h3 className="flex items-center gap-3 font-[450] text-copy-16 text-gray-1000 [&>svg:first-child]:shrink-0">
          {icon}
          {title}
          <IconChevronRightSmall
            aria-hidden
            className="-ml-1 -translate-x-px transition-transform group-hover:translate-x-0"
            size={14}
          />
        </h3>
        <p className="max-w-[34ch] text-pretty text-copy-16 text-gray-900 transition-colors group-hover:text-gray-1000 lg:text-copy-18">
          {children}
        </p>
      </Link>
    </li>
  );
}
