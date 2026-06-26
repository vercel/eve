// Hard copy of IconTrash from @vercel/geistcn-assets/icons.
import type { JSX } from "react";
import { BaseIcon, type IconProps } from "./base-icon";

const GENERATED_CONFIG = { height: 16, aspectRatio: 1, viewBox: "0 0 16 16" };

export function IconTrash(props: IconProps): JSX.Element {
  return (
    <BaseIcon $generated={GENERATED_CONFIG} {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M6.75 2.75a1.25 1.25 0 1 1 2.5 0V3h-2.5zM5.25 3v-.25a2.75 2.75 0 0 1 5.5 0V3H15v1.5h-1.12l-.7 9.2a2.5 2.5 0 0 1-2.5 2.3H5.32c-1.31 0-2.4-1-2.5-2.3l-.7-9.2H1V3h4.25m-.93 10.58-.7-9.08h8.76l-.7 9.08a1 1 0 0 1-1 .92H5.32a1 1 0 0 1-1-.92"
        clipRule="evenodd"
      />
    </BaseIcon>
  );
}
