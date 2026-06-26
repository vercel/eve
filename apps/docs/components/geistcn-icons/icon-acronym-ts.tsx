// Hard copy of IconAcronymTs from @vercel/geistcn-assets/icons.
import type { JSX } from "react";
import { BaseIcon, type IconProps } from "./base-icon";

const GENERATED_CONFIG = { height: 16, aspectRatio: 1, viewBox: "0 0 16 16" };

export function IconAcronymTs(props: IconProps): JSX.Element {
  return (
    <BaseIcon $generated={GENERATED_CONFIG} {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M0 2.5A2.5 2.5 0 0 1 2.5 0h11A2.5 2.5 0 0 1 16 2.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 0 13.5zm12.13 7a.38.38 0 0 0 0 .75 1.88 1.88 0 0 1 0 3.75H10.5v-1.5h1.63a.38.38 0 0 0 0-.75 1.88 1.88 0 0 1 0-3.75h1.37v1.5zM5 9.5h1.25V14h1.5V9.5H9V8H5z"
        clipRule="evenodd"
      />
    </BaseIcon>
  );
}
