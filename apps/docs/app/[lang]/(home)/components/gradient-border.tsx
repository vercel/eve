import type { JSX } from "react";

/**
 * Subtle gradient hairline border — strongest at the top, fading to transparent
 * toward the bottom. Render inside a `relative rounded-*` element; it inherits
 * the parent's corner radius and paints a 1px masked ring at the edge.
 */
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
