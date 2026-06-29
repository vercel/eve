// TODO: make LLM provider icons dark mode capable
// TODO: bring over to geistdocs package, and import from there

import { type CSSProperties, memo, type ReactNode, type SVGProps } from "react";

/** Flexible size format: a number, or a numeric string with optional "px" suffix. */
export type IconSize = number | `${number}` | `${number}px`;

/** `currentColor` (inherit) or a design-system color token resolved to `--ds-<token>`. */
export type IconColor = string;

type ReservedSVGProps = "color" | "size" | "width" | "height" | "fill" | "viewBox";

/** Consumer-facing props shared by every geistcn icon. */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, ReservedSVGProps> {
  color?: IconColor;
  size?: IconSize;
  style?: Omit<CSSProperties, "color" | "width" | "height">;
  className?: string;
}

interface GeneratedIconProps {
  height: number;
  aspectRatio: number;
  viewBox: string;
}

interface BaseIconProps extends IconProps {
  $generated: GeneratedIconProps;
  children: ReactNode;
}

function parseIconSize(size: IconSize): number {
  return typeof size === "number" ? size : Number(size.replace("px", ""));
}

/**
 * Shared renderer for the hard-copied geistcn icons. `size` controls height and
 * width is derived from the icon's aspect ratio to preserve proportions.
 */
export const BaseIcon = memo(function BaseIcon({
  $generated,
  size,
  style,
  color = "currentColor",
  children,
  ...props
}: BaseIconProps) {
  const height = size !== undefined ? parseIconSize(size) : $generated.height;
  const width = height * $generated.aspectRatio;

  return (
    <svg
      viewBox={$generated.viewBox}
      height={height}
      width={width}
      data-slot="geist-icon"
      style={{
        color: color === "currentColor" ? "currentColor" : `var(--ds-${color})`,
        ...style,
      }}
      {...props}
    >
      {children}
    </svg>
  );
});
