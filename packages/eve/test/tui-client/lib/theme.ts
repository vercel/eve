import pc from "picocolors";

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
