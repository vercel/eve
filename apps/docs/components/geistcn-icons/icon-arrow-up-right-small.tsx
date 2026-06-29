// Hard copy of IconArrowUpRightSmall from @vercel/geistcn-assets/icons.
import type { JSX } from "react";
import { BaseIcon, type IconProps } from "./base-icon";

const GENERATED_CONFIG = { height: 16, aspectRatio: 1, viewBox: "0 0 16 16" };

export function IconArrowUpRightSmall(props: IconProps): JSX.Element {
  return (
    <BaseIcon $generated={GENERATED_CONFIG} {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M6.75 4H6v1.5h3.44L5.47 9.47l-.53.53L6 11.06l.53-.53 3.97-3.97V10H12V5a1 1 0 0 0-1-1z"
        clipRule="evenodd"
      />
    </BaseIcon>
  );
}
