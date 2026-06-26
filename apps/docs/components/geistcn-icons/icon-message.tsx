// Hard copy of IconMessage from @vercel/geistcn-assets/icons.
import type { JSX } from "react";
import { BaseIcon, type IconProps } from "./base-icon";

const GENERATED_CONFIG = { height: 16, aspectRatio: 1, viewBox: "0 0 16 16" };

export function IconMessage(props: IconProps): JSX.Element {
  return (
    <BaseIcon $generated={GENERATED_CONFIG} {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="m2.9 10.4.08.23a5.27 5.27 0 0 1 .4 3.42 8 8 0 0 0 2.33-1.3l.51-.43.67.1q.54.08 1.11.08c3.78 0 6.5-2.64 6.5-5.5S11.78 1.5 8 1.5 1.5 4.14 1.5 7c0 1.18.44 2.3 1.23 3.22zm-.09 5.37A9 9 0 0 1 1 16s.43-.69.73-1.56c.15-.46.27-.96.27-1.44 0-.62-.2-1.27-.4-1.81A6.4 6.4 0 0 1 0 7c0-3.87 3.58-7 8-7s8 3.13 8 7-3.58 7-8 7q-.68 0-1.33-.1a8.7 8.7 0 0 1-3.86 1.87"
        clipRule="evenodd"
      />
    </BaseIcon>
  );
}
