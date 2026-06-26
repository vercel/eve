// Hard copy of IconAgents from @vercel/geistcn-assets/icons.
import type { JSX } from "react";
import { BaseIcon, type IconProps } from "./base-icon";

const GENERATED_CONFIG = { height: 16, aspectRatio: 1, viewBox: "0 0 16 16" };

export function IconAgents(props: IconProps): JSX.Element {
  return (
    <BaseIcon $generated={GENERATED_CONFIG} {...props}>
      <path
        fill="currentColor"
        d="M3 10.25a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5m10 0a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5m-10 1.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5m10 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5M8 12a1 1 0 1 1 0 2 1 1 0 0 1 0-2M2.5 7a1 1 0 1 1 0 2 1 1 0 0 1 0-2M8 7a1 1 0 1 1 0 2 1 1 0 0 1 0-2m5.5 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2M8 .25a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5m0 1.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5M2.5 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2m11 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2"
      />
    </BaseIcon>
  );
}
