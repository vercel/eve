// Hard copy of IconRobot from @vercel/geistcn-assets/icons.
import type { JSX } from "react";
import { BaseIcon, type IconProps } from "./base-icon";

const GENERATED_CONFIG = { height: 16, aspectRatio: 1, viewBox: "0 0 16 16" };

export function IconRobot(props: IconProps): JSX.Element {
  return (
    <BaseIcon $generated={GENERATED_CONFIG} {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M8.75 2.8a1.5 1.5 0 1 0-1.5 0V5H7a6 6 0 0 0-5.92 5H0v3h1v3h14v-3h1v-3h-1.08A6 6 0 0 0 9 5h-.25zM7 6.5A4.5 4.5 0 0 0 2.5 11v3.5h11V11A4.5 4.5 0 0 0 9 6.5zm.25 4.75a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0M10.5 13a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5"
        clipRule="evenodd"
      />
    </BaseIcon>
  );
}
