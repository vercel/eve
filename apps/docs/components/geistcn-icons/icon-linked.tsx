// Hard copy of IconLinked from @vercel/geistcn-assets/icons.
import type { JSX } from "react";
import { BaseIcon, type IconProps } from "./base-icon";

const GENERATED_CONFIG = { height: 16, aspectRatio: 1, viewBox: "0 0 16 16" };

export function IconLinked(props: IconProps): JSX.Element {
  return (
    <BaseIcon $generated={GENERATED_CONFIG} {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M4.25 1.5A4.25 4.25 0 0 0 .99 8.48l1.15-.96A2.75 2.75 0 0 1 4.24 3h4.26a2.75 2.75 0 1 1 0 5.5V10a4.25 4.25 0 0 0 0-8.5zm7.5 11.5H7.5a2.75 2.75 0 1 1 0-5.5V6a4.25 4.25 0 0 0 0 8.5h4.25a4.25 4.25 0 0 0 3.26-6.98l-1.15.96a2.75 2.75 0 0 1-2.1 4.52"
        clipRule="evenodd"
      />
    </BaseIcon>
  );
}
