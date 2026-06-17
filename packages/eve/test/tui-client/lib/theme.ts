import pc from "picocolors";

/**
 * Smoke-test color palette. Mirrors the eve CLI REPL's theme (see
 * `packages/eve/src/cli/ui/output.ts`) so the visual language is
 * consistent: reasoning in blue, secondary output in dim gray,
 * failures in red, assistant replies in default terminal text.
 *
 * Uses `picocolors`' built-in auto-detection (respects `FORCE_COLOR`,
 * `NO_COLOR`, TTY, CI), do NOT pass an explicit boolean to
 * `createColors`, that overrides those env checks.
 */
export const theme = {
  accent: (text: string): string => pc.cyan(text),
  danger: (text: string): string => pc.red(text),
  heading: (text: string): string => pc.bold(pc.cyan(text)),
  info: (text: string): string => pc.blue(text),
  label: (text: string): string => pc.bold(text),
  muted: (text: string): string => pc.dim(text),
  plain: (text: string): string => text,
  success: (text: string): string => pc.green(text),
  warning: (text: string): string => pc.yellow(text),
};
