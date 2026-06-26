// Hard copy of IconSandbox from @vercel/geistcn-assets/icons.
import type { JSX } from "react";
import { BaseIcon, type IconProps } from "./base-icon";

const GENERATED_CONFIG = { height: 16, aspectRatio: 1, viewBox: "0 0 16 16" };

export function IconSandbox(props: IconProps): JSX.Element {
  return (
    <BaseIcon $generated={GENERATED_CONFIG} {...props}>
      <path
        fill="currentColor"
        d="M14.5 2.25a.75.75 0 0 0-.75-.75H10.5V0h3.25C14.99 0 16 1 16 2.25V5.5h-1.5zM0 2.25C0 1.01 1 0 2.25 0H5.5v1.5H2.25a.75.75 0 0 0-.75.75V5.5H0zm2.94 8L5.19 8 2.94 5.75 4 4.69l2.6 2.6a1 1 0 0 1 0 1.42L4 11.3zm4.93-.62h4.63v1.5H7.87zm2.63 4.87h3.25c.41 0 .75-.34.75-.75V10.5H16v3.25c0 1.24-1 2.25-2.25 2.25H10.5zM2.25 16C1.01 16 0 15 0 13.75V10.5h1.5v3.25c0 .41.34.75.75.75H5.5V16z"
      />
    </BaseIcon>
  );
}
