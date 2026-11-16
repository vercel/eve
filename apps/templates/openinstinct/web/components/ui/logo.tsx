import * as React from "react";

type LogoProps = React.ComponentPropsWithoutRef<"svg">;

function Logo({ className, ...props }: LogoProps) {
  return (
    <svg
      aria-hidden="true"
      className={["size-5 shrink-0", className].filter(Boolean).join(" ")}
      data-slot="logo"
      fill="currentColor"
      focusable="false"
      viewBox="-85 0 1229 1229"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* OpenInstinct's mark with transparent cutouts for every surface. */}
      <path
        d="M0 170H445V360H614V170H1059V1229H0Z M867 698.5a338.5 338.5 0 1 0-677 0a338.5 338.5 0 1 0 677 0Z"
        fillRule="evenodd"
      />
      <rect height="170" width="169" x="445" y="0" />
      <rect height="523" width="169" x="445" y="360" />
    </svg>
  );
}

export { Logo };
export type { LogoProps };
