import type { JSX } from "react";

// TODO: check for Safari's (OS 27) new webkit where this gradient approach causes problems

export function GradientBorder(): JSX.Element {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-[inherit]"
      style={{
        padding: "1px",
        background: "linear-gradient(to bottom, var(--ds-gray-alpha-400), transparent)",
        WebkitMask: "linear-gradient(white, white) content-box, linear-gradient(white, white)",
        WebkitMaskComposite: "xor",
        mask: "linear-gradient(white, white) content-box, linear-gradient(white, white)",
        maskComposite: "exclude",
      }}
    />
  );
}
