// Hard copy of IconUser from @vercel/geistcn-assets/icons.
import type { JSX } from "react";
import { BaseIcon, type IconProps } from "./base-icon";

const GENERATED_CONFIG = { height: 16, aspectRatio: 1, viewBox: "0 0 16 16" };

export function IconUser(props: IconProps): JSX.Element {
  return (
    <BaseIcon $generated={GENERATED_CONFIG} {...props}>
      <path
        fill="currentColor"
        d="M9.42 9.25a6.3 6.3 0 0 1 5.76 3.69l.07.15v3.16h-14v-3.16l.07-.15a6.3 6.3 0 0 1 5.76-3.69zm-2.34 1.5a4.8 4.8 0 0 0-4.33 2.68v1.32h11v-1.32a4.8 4.8 0 0 0-4.33-2.68zM8.25 0c1.8 0 3.25 1.46 3.25 3.25v.5C11.5 5.55 10.04 7 8.25 7h-.5A3.25 3.25 0 0 1 4.5 3.75v-.5C4.5 1.45 5.96 0 7.75 0zm-.5 1.5C6.78 1.5 6 2.28 6 3.25v.5c0 .97.78 1.75 1.75 1.75h.5c.97 0 1.75-.78 1.75-1.75v-.5c0-.97-.78-1.75-1.75-1.75z"
      />
    </BaseIcon>
  );
}
