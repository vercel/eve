// Hard copy of IconLogs from @vercel/geistcn-assets/icons.
import type { JSX } from "react";
import { BaseIcon, type IconProps } from "./base-icon";

const GENERATED_CONFIG = { height: 16, aspectRatio: 1, viewBox: "0 0 16 16" };

export function IconLogs(props: IconProps): JSX.Element {
  return (
    <BaseIcon $generated={GENERATED_CONFIG} {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M9 2h6v1.5H9zm0 10h6v1.5H9zm.75-5H9v1.5h6V7H9.75M1 12h2v1.5H1zm.75-10H1v1.5h2V2H1.75M1 7h2v1.5H1zm4.75 5H5v1.5h2V12H5.75M5 2h2v1.5H5zm.75 5H5v1.5h2V7H5.75"
        clipRule="evenodd"
      />
    </BaseIcon>
  );
}
