// Hard copy of IconWorkflow from @vercel/geistcn-assets/icons.
import type { JSX } from "react";
import { BaseIcon, type IconProps } from "./base-icon";

const GENERATED_CONFIG = { height: 16, aspectRatio: 1, viewBox: "0 0 16 16" };

export function IconWorkflow(props: IconProps): JSX.Element {
  return (
    <BaseIcon $generated={GENERATED_CONFIG} {...props}>
      <path
        fill="currentColor"
        d="m5.75 7 .67.34-1.57 3.13c.54.3.9.87.9 1.53v2c0 .97-.78 1.75-1.75 1.75H2c-.97 0-1.75-.78-1.75-1.75v-2c0-.97.78-1.75 1.75-1.75h1.29l1.79-3.58zM14 10.25c.97 0 1.75.78 1.75 1.75v2c0 .97-.78 1.75-1.75 1.75h-2c-.88 0-1.6-.65-1.73-1.5H7v-1.5h3.25V12c0-.97.78-1.75 1.75-1.75zm-12 1.5a.25.25 0 0 0-.25.25v2c0 .14.11.25.25.25h2c.14 0 .25-.11.25-.25v-2a.25.25 0 0 0-.25-.25zm10 0a.25.25 0 0 0-.25.25v2q.02.23.25.25h2q.23-.02.25-.25v-2a.25.25 0 0 0-.25-.25zM9 .25c.97 0 1.75.78 1.75 1.75v2q-.02.69-.44 1.16l1.9 3.48-1.32.72-1.97-3.61H7c-.97 0-1.75-.78-1.75-1.75V2c0-.97.78-1.75 1.75-1.75zm-2 1.5a.25.25 0 0 0-.25.25v2c0 .14.11.25.25.25h2c.14 0 .25-.11.25-.25V2A.25.25 0 0 0 9 1.75z"
      />
    </BaseIcon>
  );
}
