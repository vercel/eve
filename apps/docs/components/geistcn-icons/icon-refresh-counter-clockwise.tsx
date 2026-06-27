// Hard copy of IconRefreshCounterClockwise from @vercel/geistcn-assets/icons.
import type { JSX } from "react";
import { BaseIcon, type IconProps } from "./base-icon";

const GENERATED_CONFIG = { height: 16, aspectRatio: 1, viewBox: "0 0 16 16" };

export function IconRefreshCounterClockwise(props: IconProps): JSX.Element {
  return (
    <BaseIcon $generated={GENERATED_CONFIG} {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M2.73 6.42A5.5 5.5 0 0 1 12.84 5.4l.36.66 1.32-.72-.36-.66A7 7 0 0 0 1.5 5.4V3H0v4.17c0 .42.34.75.75.75h4.18v-1.5h-2.2m10.54 3.16h-2.2v-1.5h4.18c.41 0 .75.33.75.75V13h-1.5v-2.39a7 7 0 0 1-12.64.75l-.36-.66 1.31-.72.36.66a5.5 5.5 0 0 0 10.1-1.06"
        clipRule="evenodd"
      />
    </BaseIcon>
  );
}
