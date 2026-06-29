// Hard copy of the Vercel triangle from @vercel/geistcn-assets (logo-icon-vercel).
// Uses currentColor so it adapts to dark mode; "default" maps to the gray-1000
// token (black in light, white in dark) to match the other brand marks.
import type { JSX } from "react";
import { BaseIcon, type IconProps } from "./base-icon";

const GENERATED_CONFIG = { height: 16, aspectRatio: 1.15, viewBox: "0 0 115 100" };

export function IconVercel({ color = "gray-1000", ...props }: IconProps): JSX.Element {
  return (
    <BaseIcon
      $generated={GENERATED_CONFIG}
      color={color === "default" ? "gray-1000" : color}
      {...props}
    >
      <path fill="currentColor" fillRule="evenodd" d="M57.5 0 115 100H0z" clipRule="evenodd" />
    </BaseIcon>
  );
}
